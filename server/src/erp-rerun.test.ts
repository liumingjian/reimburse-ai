import { randomBytes } from 'node:crypto';
import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, type ExtensionHolder, type TaskSnapshot } from '@baox/contract';
import type { ResultEvent } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, type FillRequest } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenJob } from './erp/fill-plan';
import { draftMarkOf } from './erp/remote-executor';
import { drafted, readbackMismatch, uncertainDraft } from './erp/testing/fake-executor';
import { fakeExtension, type FakeExtension, type FillRunner } from './erp/testing/fake-extension';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// 自动重新去报销 (ADR-0034, erp-headless-v1.md line 2 item 4): a 去报销 on a baox 本地执行器 that stops after its import
// or fill, before 暂存, starts over by itself on a fresh 新增单, at most twice in a row, each time asking ERP first
// whether the bill already landed. Nothing else starts over: not after 暂存, not on the 浏览器扩展.

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer({ erpExecutor: 'extension', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32), autoRerun: true });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

async function executor(scripts: FillRunner[], holder: ExtensionHolder = 'local_executor'): Promise<FakeExtension> {
  const issued = ExtensionPairingSchema.parse(await (await alice.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXTENSION_VERSION, holder }),
  });
  let run = 0;
  const extension = fakeExtension(server.app.extensionChannel, ExtensionTokenSchema.parse(await redeemed.json()).token, {
    trySignIn: async () => ({ ok: true }),
    fill: (plan, channel, trigger) => scripts[Math.min(run++, scripts.length - 1)]!(plan, channel, trigger),
  });
  await extension.connect();
  await alice.post('/api/erp-credentials', { account: 'zhangsan', password: 'erp-Pa55' });
  return extension;
}

// The precondition answered no: a 费用报销单 already holds an invoice, so the re-run stops before uploading.
const invoiceHeld: FillRunner = async (_plan, channel) => {
  const event: ResultEvent = { type: 'result', status: 'aborted', code: 'rerun_invoice_held', message: '没有自动重新去报销：这次的发票已经关联在费用报销单 FYBX20260911000011 上。报销系统没有被改动。', billNo: null, capture: null };
  await channel.emit(event);
  return event;
};

// `settle` can look in the moment between a job's result and the re-run it starts: wait for the jobs, then settle.
async function after(scene: { task: { taskId: string }; settled: () => Promise<TaskSnapshot> }, jobs: number, waitMs = 5_000) {
  const rows = () => server.db.selectFrom('erp_job').select(['job_id', 'trigger', 'plan']).where('task_id', '=', scene.task.taskId).orderBy('revision').execute();
  const deadline = Date.now() + waitMs;
  while ((await rows()).length < jobs && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshot = await scene.settled();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { snapshot: await scene.settled(), jobs: (await rows()).map((row) => ({ jobId: row.job_id, trigger: row.trigger, frozen: JSON.parse(row.plan) as FrozenJob })), first: snapshot };
}
const fills = (extension: FakeExtension) => extension.asked().filter((asked) => asked.method === EXECUTOR_METHODS.fill).map((asked) => asked.payload as FillRequest);

describe('自动重新去报销', () => {
  it('starts over on a fresh form after a stop before 暂存, asks ERP first, and ends at the draft', async () => {
    const extension = await executor([readbackMismatch, drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot, jobs } = await after(scene, 2);

    expect(jobs.map((job) => job.trigger)).toEqual(['start', 'rerun']);
    const [first, second] = jobs;
    const invoiceNos = first!.frozen.judge.invoices.map((invoice) => invoice.identity?.number);
    expect(second!.frozen.plan).toMatchObject({ replaceAbandonedForm: true, rerun: { invoiceNos, marks: [draftMarkOf(first!.jobId)] } });
    expect(second!.frozen.rerunOf).toEqual({ jobId: first!.jobId, code: 'strict_readback_failed', no: 1 });
    expect(fills(extension).map((fill) => fill.trigger)).toEqual(['start', 'rerun']);
    expect(fills(extension)[1]!.plan).toMatchObject({ draft: { mark: draftMarkOf(second!.jobId) } });
    expect(snapshot).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted' } });
  });

  it('starts over at most twice in a row, then waits in 对账 as before', async () => {
    await executor([readbackMismatch]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot, jobs } = await after(scene, 3);

    expect(jobs.map((job) => job.trigger)).toEqual(['start', 'rerun', 'rerun']);
    expect(jobs[2]!.frozen.rerunOf).toMatchObject({ jobId: jobs[1]!.jobId, no: 2 });
    expect(jobs[2]!.frozen.plan.rerun!.marks).toEqual(jobs.slice(0, 2).reverse().map((job) => draftMarkOf(job.jobId)));
    expect(snapshot).toMatchObject({ stage: 'reconcile', reconcile: { allowedActions: ['wait', 'hand_off'] } });
    expect(snapshot.erp.rerunNotice).toBe('应用已自动换新单重新填报 2 次，仍然没有完成，需要你来决定下一步。');
  });

  it('stops for 对账 when ERP shows a bill already holds the invoices', async () => {
    await executor([readbackMismatch, invoiceHeld]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot, jobs } = await after(scene, 2);

    expect(jobs.map((job) => job.trigger)).toEqual(['start', 'rerun']);
    expect(snapshot).toMatchObject({ stage: 'reconcile', reconcile: { allowedActions: ['wait', 'hand_off'] } });
    // Its own sentence: the re-run wrote nothing, so 「写入结果不确定」 would be false about it.
    expect(snapshot.erp.abortReason).toBe('没有自动重新去报销：这次的发票已经关联在费用报销单 FYBX20260911000011 上。报销系统没有被改动。');
    expect(snapshot.erp.rerunNotice).toBeNull();
  });

  it('never starts over after 暂存 was pressed', async () => {
    await executor([uncertainDraft, drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot, jobs } = await after(scene, 2, 500);

    expect(jobs.map((job) => job.trigger)).toEqual(['start']);
    expect(snapshot).toMatchObject({ stage: 'reconcile', reconcile: { allowedActions: ['wait', 'hand_off'] } });
  });

  it('never starts over on the 浏览器扩展: the employee\'s own tab is theirs', async () => {
    await executor([readbackMismatch, drafted], 'extension');
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { jobs } = await after(scene, 2, 500);

    expect(jobs.map((job) => job.trigger)).toEqual(['start']);
  });

  it('stays off when the app is told so', async () => {
    await server.close();
    server = await scenarioServer({ erpExecutor: 'extension', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32), autoRerun: false });
    alice = await server.signIn('alice');
    await executor([readbackMismatch, drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { jobs } = await after(scene, 2, 500);

    expect(jobs.map((job) => job.trigger)).toEqual(['start']);
  });
});
