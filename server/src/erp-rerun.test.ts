import { randomBytes } from 'node:crypto';
import { PAIRING_PATH, EXECUTOR_VERSION, PairingViewSchema, PairingTokenSchema, type TaskSnapshot } from '@baox/contract';
import type { ResultEvent } from '@baox/erp-executor/protocol';
import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { EXECUTOR_METHODS, type FillRequest } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenJob } from './erp/fill-plan';
import { draftMarkOf } from './erp/fill-plan';
import { drafted, gated, readbackMismatch, uncertainDraft, TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import { fakeLocalExecutor, type FakeLocalExecutor, type FillRunner } from './erp/testing/fake-local-executor';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// 自动重新去报销 (ADR-0034, erp-headless-v1.md line 2 item 4): a 去报销 on a baox 本地执行器 that stops after its import
// or fill, before 暂存, starts over by itself on a fresh 新增单, at most twice in a row, each time asking ERP first
// whether the bill already landed. Nothing else starts over: not after 暂存.

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer({ erpExecutor: 'paired', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32), autoRerun: true });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

async function executor(scripts: FillRunner[]): Promise<FakeLocalExecutor> {
  const issued = PairingViewSchema.parse(await (await alice.post('/api/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issued.code, browser: 'baox 本地执行器（darwin）', version: EXECUTOR_VERSION }),
  });
  let run = 0;
  const localExecutor = fakeLocalExecutor(server.app.executorHub, PairingTokenSchema.parse(await redeemed.json()).token, {
    trySignIn: async () => ({ ok: true, employeeProfile: { status: 'failed', message: 'Synthetic executor has no personal-information page.' } }),
    fill: (plan, channel, trigger) => scripts[Math.min(run++, scripts.length - 1)]!(plan, channel, trigger),
  });
  await localExecutor.connect();
  await alice.post('/api/erp-credentials', { account: 'zhangsan', password: 'erp-Pa55' });
  return localExecutor;
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
const fills = (localExecutor: FakeLocalExecutor) => localExecutor.asked().filter((asked) => asked.method === EXECUTOR_METHODS.fill).map((asked) => asked.payload as FillRequest);

const stoppedAtField = (code: string, column: string): FillRunner => async (plan, channel) => {
  await channel.emit({ type: 'attempt_started', attemptId: `${plan.jobId}.fill`, action: 'fill',
    preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 1, detailRowCount: 1 },
    expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT });
  const now = new Date().toISOString();
  const event: ResultEvent = { type: 'result', status: 'unknown', code, message: `填写「${column}」停止`, billNo: null, capture: null,
    context: { lineId: 'line-1', row: 1, column, action: 'write', startedAt: now, reportedAt: now, attempt: 1 } };
  await channel.emit(event);
  return event;
};

describe('自动重新去报销', () => {
  it('does not spend a fresh form on an explicit ERP rejection', async () => {
    const localExecutor = await executor([stoppedAtField('INVOICE_IMPORT_REJECTED', '发票')]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');
    const { snapshot, jobs } = await after(scene, 1);
    expect(jobs).toHaveLength(1);
    expect(fills(localExecutor)).toHaveLength(1);
    expect(snapshot.erp.rerunNotice).toContain('明确拒绝');
  });

  it('stops when the same field fails for the same reason on the fresh form', async () => {
    const localExecutor = await executor([stoppedAtField('field_write_failed', '项目')]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');
    const { snapshot, jobs } = await after(scene, 2);
    expect(jobs).toHaveLength(2);
    expect(fills(localExecutor)).toHaveLength(2);
    expect(snapshot.erp.rerunNotice).toContain('同一条明细');
  });

  it('still permits recovery when a fresh form advances to a different field', async () => {
    await executor([stoppedAtField('field_write_failed', '项目'), stoppedAtField('field_write_failed', '税额'), drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');
    const { snapshot, jobs } = await after(scene, 3);
    expect(jobs).toHaveLength(3);
    expect(snapshot.erp.outcome).toBe('drafted');
  });

  it('starts over on a fresh form after a stop before 暂存, asks ERP first, and ends at the draft', async () => {
    const localExecutor = await executor([readbackMismatch, drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot, jobs } = await after(scene, 2);

    expect(jobs.map((job) => job.trigger)).toEqual(['start', 'rerun']);
    const [first, second] = jobs;
    const invoiceNos = first!.frozen.judge.invoices.map((invoice) => invoice.identity?.number);
    expect(second!.frozen.plan).toMatchObject({ replaceAbandonedForm: true, rerun: { invoiceNos, marks: [draftMarkOf(first!.jobId)] } });
    expect(second!.frozen.rerunOf).toEqual({ jobId: first!.jobId, code: 'strict_readback_failed', no: 1 });
    expect(fills(localExecutor).map((fill) => fill.trigger)).toEqual(['start', 'rerun']);
    expect(fills(localExecutor)[1]!.plan).toMatchObject({ draft: { mark: draftMarkOf(second!.jobId) } });
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

  // QA 2026-10-19: the run that filled stopped on 新增行, its re-run was turned away before it wrote anything, and
  // 对账 showed the re-run's reason — 「报销系统没有被改动，可以再去报销」 under 「写入结果不确定」.
  it('tells 对账 why the run that wrote stopped, and the re-run that wrote nothing on a line of its own', async () => {
    const busy = '这台电脑上的 baox 本地执行器正在运行另一次去报销。';
    // Answered, never emitted, as the 本地执行器 turns a job away.
    const turnedAway: FillRunner = async () => ({ type: 'result', status: 'aborted', code: 'local_executor_busy', message: busy, billNo: null, capture: null });
    await executor([readbackMismatch, turnedAway]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { snapshot } = await after(scene, 2);

    expect(snapshot).toMatchObject({ stage: 'reconcile', erp: { status: 'aborted' } });
    expect(snapshot.erp.abortReason).toBe('写入报销系统的结果不确定，应用已停止写入，不会重放。原因：ERP 明细「申请报销金额」合计 1000.00 与任务合计 1006.00 不一致');
    expect(snapshot.erp.rerunNotice).toBe(`应用自动重新去报销了 1 次，但在写入之前就停下了：${busy}`);
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
    server = await scenarioServer({ erpExecutor: 'paired', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, erpCredentialKey: randomBytes(32), autoRerun: false });
    alice = await server.signIn('alice');
    await executor([readbackMismatch, drafted]);
    const scene = await scenario(server, alice).at('actions');
    await scene.accept('start-erp-write');

    const { jobs } = await after(scene, 2, 500);

    expect(jobs.map((job) => job.trigger)).toEqual(['start']);
  });
});
