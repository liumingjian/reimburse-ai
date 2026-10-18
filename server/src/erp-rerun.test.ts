import { randomBytes } from 'node:crypto';
import { PAIRING_PATH, CLIENT_VERSION, PairingViewSchema, PairingTokenSchema, type TaskSnapshot } from '@baox/contract';
import type { ResultEvent } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, type FillRequest } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenJob } from './erp/fill-plan';
import { draftMarkOf } from './erp/remote-executor';
import { drafted, gated, readbackMismatch, uncertainDraft } from './erp/testing/fake-executor';
import { fakeExtension, type FakeExtension, type FillRunner } from './erp/testing/fake-extension';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// 自动重新去报销 (ADR-0034, erp-headless-v1.md line 2 item 4): a 去报销 on a baox 本地执行器 that stops after its import
// or fill, before 暂存, starts over by itself on a fresh 新增单, at most twice in a row, each time asking ERP first
// whether the bill already landed. Nothing else starts over: not after 暂存.

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer({ erpExecutor: 'extension', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32), autoRerun: true });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

async function executor(scripts: FillRunner[]): Promise<FakeExtension> {
  const issued = PairingViewSchema.parse(await (await alice.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: CLIENT_VERSION }),
  });
  let run = 0;
  const extension = fakeExtension(server.app.extensionChannel, PairingTokenSchema.parse(await redeemed.json()).token, {
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

  // The bar of the new run (spec #412 A, conflict review): it starts again from the new job's own events, not from
  // where the stopped job froze.
  it('starts the bar again from the new run, not from where the stopped run froze', async () => {
    const stopsMidFill: FillRunner = async (plan, channel) => {
      for (const step of ['chromium', 'login', 'catalog', 'compatibility', 'navigate', 'import', 'readback'] as const) {
        await channel.emit({ type: 'step', step, status: 'running' });
        await channel.emit({ type: 'step', step, status: 'done' });
      }
      await channel.emit({ type: 'step', step: 'fill', status: 'running', progress: { done: 1, total: 2 } });
      return readbackMismatch(plan, channel);
    };
    const next = gated(drafted);
    await executor([stopsMidFill, next.script]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    await next.running;
    const live = await scene.snapshot();

    expect(live.erp.progress).toEqual({ label: '启动后台浏览器', percent: 0 });
    next.release();
    const { snapshot } = await after(scene, 2);
    expect(snapshot.erp).toMatchObject({ outcome: 'drafted', progress: { percent: 100 } });
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
