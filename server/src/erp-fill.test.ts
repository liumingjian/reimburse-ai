import { ERP_DRAFT_STEP_COPY, TaskListSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResultEvent } from '@baox/erp-executor/protocol';
import { abortBeforeAttempt, catalogMismatch, drafted, gated, notSignedIn, readbackMismatch, TEST_ERP_ACCOUNT, type Script, type ScriptedExecutor } from './erp/testing/fake-executor';
import { api, sample } from './test/api';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Slice 12 (#191): 去报销 (fill ERP) end to end on a fake executor. The job runs in the background; the snapshot is
// derived from the persisted job facts (ADR-0014/0016): no sign-in, catalog mismatch, write result unknown, and
// ERP 草稿已交接, the one ending (ADR-0037). The account's ERP lease is held only while one of its jobs runs (ADR-0019). Every task starts from the
// scenario builder's default: the 全季 hotel invoice + folio, one accommodation line confirmed on P-2307.

let server: ScenarioServer;
let executor: ScriptedExecutor;
beforeEach(async () => {
  server = await scenarioServer();
  executor = server.erp!;
});
afterEach(() => server.close());

async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

const taskList = async (client: TestClient) => TaskListSchema.parse(await (await client.request('/api/tasks')).json());

describe('去报销 on a fake executor', () => {
  it('nothing waits for a login: a job that cannot sign in stops before any attempt and the task can go again', async () => {
    const scene = await scenario(server).at('actions', { erp: notSignedIn });
    const stopped = await scene.run('start-erp-write');
    expect(stopped).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle', outcome: 'none', externalWait: 'none' }, confirmation: { status: 'confirmed' } });
    expect(stopped.erp.abortReason).toContain('设置页保存报销系统账号和密码');
    expect(stopped.allowedActions).toContain('start_erp_write');
    expect(server.erpLease.holder(scene.client.account.accountId)).toBeNull();
    expect(executor.runs().map((run) => run.trigger)).toEqual(['start']);
    // The plan carries the confirmed lines' projects, the voucher invoices by content, and the marker it 暂存s under.
    expect(executor.runs()[0]!.plan).toMatchObject({ kind: 'fill', taskId: scene.task.taskId, purpose: '上海产品评审出差', catalog: { projects: [{ code: 'P-2307', name: '华东客户交付' }], expenseItems: [{ code: 'FY010001', name: '住宿' }] }, draft: { mark: expect.stringMatching(/^baox-[a-z0-9]{10}$/) } });
    expect(executor.runs()[0]!.plan.invoices).toHaveLength(1);

    // Re-reading the stop cannot dispatch another fill.
    expect((await scene.snapshot()).erp).toEqual(stopped.erp);
    expect(executor.runs()).toHaveLength(1);

    executor.queue(drafted);
    expect((await scene.run('start-erp-write')).stage).toBe('done');
  });

  it('has no 我已登录，继续 and no 取消去报销 any more (ADR-0037)', async () => {
    const scene = await scenario(server).at('actions');
    for (const name of ['confirm-login', 'cancel-erp-write']) expect((await scene.act(name)).status, name).toBe(404);
  });

  it('answers every mutation with 409 while the job runs', async () => {
    const scene = await scenario(server).at('actions');
    const gate = gated(drafted);
    executor.queue(gate.script);
    await scene.accept('start-erp-write');
    await gate.running;
    const waiting = await scene.snapshot();
    const id = scene.task.taskId;
    const line = waiting.lines[0]!;
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['start-inventory', {}],
      ['reopen-upload', {}],
      ['confirm-review', { digest: waiting.confirmation.digest }],
      ['set-home-city', { homeCity: '上海' }],
      ['submit-project-assignment', { purpose: '别的事由', projects: { [line.lineId]: 'P-3312' } }],
      ['assign-project-lines', { lineIds: [line.lineId], projectNumber: 'P-3312', onlyUnassigned: false }],
      ['answer-pending', { itemId: `edit.${line.voucherMaterialId}.description`, answer: { value: '改过的描述' } }],
      ['exclude-material', { materialId: line.voucherMaterialId }],
      ['start-erp-write', {}],
    ];
    for (const [name, body] of mutations) {
      const response = await scene.act(name, body, waiting.step.stepToken);
      expect(response.status, name).toBe(409);
    }
    expect((await api(() => scene.client).uploadRaw(id, [sample('m03')])).status).toBe(409);
    expect((await scene.client.post(`/api/tasks/${id}/abandon`, {})).status).toBe(409);
    // Nothing changed: the same step still stands.
    expect((await scene.snapshot()).step.stepToken).toBe(waiting.step.stepToken);
    gate.release();
    expect((await scene.settled()).stage).toBe('done');
  });

  it('a catalog mismatch aborts before import, with no attempt, and returns to project assignment', async () => {
    const scene = await scenario(server).at('actions');
    executor.queue(catalogMismatch);
    await scene.accept('start-erp-write');
    const mismatch = await scene.settled();
    expect(mismatch).toMatchObject({ stage: 'project', step: { kind: 'assign_projects' }, erp: { status: 'idle' }, catalog: { status: 'mismatch' } });
    expect(mismatch.catalog.problems).toEqual([expect.objectContaining({ subject: '项目号 P-2307', resolver: '要你处理' })]);
    expect(mismatch.catalog.problems[0]!.reason).toContain('改过名的项目');
    expect(server.erpLease.holder(scene.client.account.accountId)).toBeNull();
    expect((await taskList(scene.client)).tasks[0]).toMatchObject({ abandonable: true });

    // Reassigning and resubmitting leaves the mismatch behind: review again, confirm, write again.
    const resubmitted = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(mismatch.lines.map((line) => [line.lineId, 'P-3312'])) });
    expect(resubmitted).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, catalog: { status: 'pending' } });
    await scene.accept('confirm-review', { digest: resubmitted.confirmation.digest });
    executor.queue(drafted);
    await scene.accept('start-erp-write');
    expect((await scene.settled()).stage).toBe('done');
  });

  it('a read-back mismatch after an attempt is ERP 写入结果未知: reconcile, frozen, and still voidable', async () => {
    const scene = await scenario(server).at('reconcile', { erp: readbackMismatch });
    const unknown = scene.reached;
    expect(unknown).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending' } });
    expect(unknown.erp.abortReason).toContain('「申请报销金额」合计 1000.00 与任务合计 1006.00 不一致');
    expect(unknown.erp.erpAccount).toEqual(TEST_ERP_ACCOUNT);
    expect(server.erpLease.holder(scene.client.account.accountId)).toBeNull();

    expect(await scene.refused('set-home-city', { homeCity: '上海' })).toEqual({ status: 400, code: 'erp_started' });
    expect(await scene.refused('start-erp-write')).toEqual({ status: 400, code: 'erp_started' });
    // The facts are frozen, but the task is not a prisoner of them: ADR-0030 lets any state be voided, and the list
    // offers it without a reason to the contrary.
    expect((await taskList(scene.client)).tasks[0]).toMatchObject({ stage: 'reconcile', abandonable: true, abandonBlockedReason: null, erpTouched: true });
    // Still the account's one non-terminal task for as long as it is around.
    await refused(await scene.client.post('/api/tasks', { homeCity: '杭州' }), 400, 'active_task_exists');
    const voided = await scene.client.post(`/api/tasks/${scene.task.taskId}/abandon`, {});
    expect(voided.status).toBe(200);
    expect(TaskListSchema.parse(await voided.json()).tasks).toEqual([]);
    expect((await scene.snapshot()).stage).toBe('voided');
    // Voiding it releases the account: the next task can start.
    expect((await scene.client.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  });

  it('完全重置 voids a task that touched ERP too, because 任务作废 now accepts it', async () => {
    const scene = await scenario(server).at('reconcile', { erp: readbackMismatch });

    // Reset is a bulk 任务作废: since ADR-0030 that clears every lifecycle, ERP-touched ones included. What it does
    // not do is reach into ERP; the bill already over there is the employee's to deal with.
    const reset = await scene.client.post('/api/reset', {});
    expect(reset.status).toBe(200);
    expect(TaskListSchema.parse(await reset.json()).tasks).toEqual([]);
    expect((await scene.snapshot()).stage).toBe('voided');
  });

  it('完全重置 still voids a task that never touched ERP', async () => {
    const scene = await scenario(server).at('actions');
    const reset = await scene.client.post('/api/reset', {});
    expect(TaskListSchema.parse(await reset.json()).tasks).toEqual([]);
    expect((await scene.snapshot()).stage).toBe('voided');
  });

  it('a 暂存 draft found again after the strict read-back is done (ERP 草稿已交接), a terminal', async () => {
    const scene = await scenario(server).at('done');
    const done = scene.reached;
    // A 暂存单 has no 单据编号 until the employee saves it: its 内码 and the read-back rows are the evidence.
    expect(done).toMatchObject({ stage: 'done', step: { kind: 'none' }, erp: { status: 'done', currentStage: 'handover', externalWait: 'none', outcome: 'drafted', allowedActions: ['refresh'], draftNo: null, erpAccount: TEST_ERP_ACCOUNT, review: { draftId: '119946' } }, readback: { status: 'matched' } });
    expect(done.readback.rows).toHaveLength(done.lines.length);
    expect(done.readback.rows.every((row) => row.matched)).toBe(true);
    expect(done.erp.steps.every((step) => step.status === 'done')).toBe(true);
    // The list is the one 本地执行器 list (ADR-0037), and its copy comes from the contract: the web mock's step list
    // reads the same constant, so the two lists cannot drift apart.
    expect(done.erp.steps.at(-1)).toMatchObject({ ...ERP_DRAFT_STEP_COPY, status: 'done' });
    expect(done.erp.steps.some((step) => step.title.includes('保存'))).toBe(false);
    expect(server.erpLease.holder(scene.client.account.accountId)).toBeNull();

    expect((await taskList(scene.client)).tasks[0]).toMatchObject({ stage: 'done', erpDraftNo: null, abandonable: true, erpTouched: true });
    expect(await scene.refused('set-home-city', { homeCity: '上海' })).toEqual({ status: 400, code: 'task_closed' });
    // 去打印 never needs ERP (stories 57 and 63), so the paper bundle is still available once the draft is handed over.
    expect((await scene.client.post(`/api/tasks/${scene.task.taskId}/actions/generate-print-sheet`, {})).status).toBe(200);
    expect((await scene.snapshot()).printSheet.status).toBe('generated');
    // ERP 草稿已交接 is terminal: the account may start the next task.
    expect((await scene.client.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  });

  it('a failure before the first attempt_started returns to write-pending and allows retry', async () => {
    const scene = await scenario(server).at('actions');
    executor.queue(abortBeforeAttempt, drafted);
    await scene.accept('start-erp-write');
    const aborted = await scene.settled();
    expect(aborted).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, confirmation: { status: 'confirmed' } });
    expect(aborted.erp.abortReason).toContain('报销系统的版本与上次核对时不一致');
    expect(server.erpLease.holder(scene.client.account.accountId)).toBeNull();
    expect((await taskList(scene.client)).tasks[0]).toMatchObject({ abandonable: true });
    // Nothing was written, so the task is still editable.
    expect((await scene.act('set-home-city', { homeCity: '杭州' })).status).toBe(200);

    await scene.accept('start-erp-write');
    expect((await scene.settled()).stage).toBe('done');
  });

  it("holds only this account's lease while the job runs: 409 stale for this task, another account untouched", async () => {
    const scene = await scenario(server).at('actions');
    const alice = scene.client;
    const gate = gated(drafted);
    executor.queue(gate.script);
    const running = await scene.accept('start-erp-write');
    await gate.running;
    expect(running).toMatchObject({ stage: 'erp', step: { kind: 'none' }, erp: { status: 'running', currentStage: 'chromium', externalWait: 'erp_response', outcome: 'none', allowedActions: ['refresh'] } });
    expect(server.erpLease.holder(alice.account.accountId)).toEqual({ accountId: alice.account.accountId, taskId: scene.task.taskId, jobId: expect.any(String) });

    const current = await scene.snapshot();
    const reread = await scene.snapshot();
    expect(reread.erp).toEqual(current.erp);
    expect(executor.runs()).toHaveLength(1);
    expect((await scene.act('set-home-city', { homeCity: '上海' })).status).toBe(409);

    // A colleague filing at the same moment is not queued behind her (ADR-0019): the lease she holds is not consulted
    // for his account, and his own is free to take.
    const bob = await server.signIn('bob');
    const bobTask = await api(() => bob).createTask('杭州');
    const unblocked = await bob.post(`/api/tasks/${bobTask.task.taskId}/actions/start-erp-write`, { stepToken: bobTask.step.stepToken });
    expect(((await unblocked.json()) as { error: { code: string } }).error.code).not.toBe('erp_in_use');
    expect(server.erpLease.acquire({ accountId: bob.account.accountId, taskId: bobTask.task.taskId, jobId: 'bob-job' })).toBe(true);
    // Two accounts hold it at once, and neither sees the other's holder.
    expect(server.erpLease.holder(alice.account.accountId)).toMatchObject({ taskId: scene.task.taskId });
    expect(server.erpLease.holder(bob.account.accountId)).toMatchObject({ taskId: bobTask.task.taskId });
    server.erpLease.release('bob-job');

    gate.release();
    expect((await scene.settled()).stage).toBe('done');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  // A 住宿 line needs its 离店日期, which only the folio carries. The hotel invoice on its own never gets that far: its
  // missing 结账单 blocks the list at 待确认项, so 去报销 is refused before any job.
  it('refuses to start for a hotel invoice without its folio, which never leaves 待确认项', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m01'], stayTrio: 'answered' });
    expect(scene.reached).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });
    const response = await scene.act('start-erp-write');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_ready');
    expect(executor.runs()).toEqual([]);
  });

  // ERP's 发票类型 enum has no 铁路电子客票 entry, but it does have 火车票, and that is what a rail e-ticket writes as.
  it('writes a 铁路电子客票 line as 火车票, the ERP enum entry for it, instead of refusing it', async () => {
    const scene = await scenario(server).at('actions', { materials: ['m07'] });
    expect(scene.reached.lines.map((line) => line.invoiceType)).toEqual(['火车票']);
    await scene.accept('start-erp-write');
    await scene.settled();
    expect(executor.runs()).toHaveLength(1);
  });

  // QA 2026-09-19 (738534a): the 发票助手 stuck on its entry menu before the 发票导入单据 click, and the run was
  // recorded as a write, leaving the task in 对账 for good. Nothing was imported, so it must come back to 去报销.
  it('a job stuck in the invoice assistant before the import click writes nothing and returns to 去报销', async () => {
    const scene = await scenario(server).at('actions', { erp: stuckBeforeImport });
    await scene.accept('start-erp-write');
    const back = await scene.settled();
    expect(back).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, reconcile: { status: 'none' } });
    expect((await taskList(scene.client)).tasks[0]).toMatchObject({ abandonable: true, erpTouched: false });
  });
});

// Reaches the 发票助手, fails to get past its entry menu, and stops: no attempt_started, so nothing counts as written.
const stuckBeforeImport: Script = async (_plan, channel) => {
  for (const step of ['chromium', 'login', 'catalog', 'navigate'] as const) {
    await channel.emit({ type: 'step', step, status: 'running' });
    await channel.emit({ type: 'step', step, status: 'done' });
  }
  await channel.emit({ type: 'step', step: 'import', status: 'running' });
  await channel.emit({ type: 'step', step: 'import', status: 'failed' });
  const event: ResultEvent = { type: 'result', status: 'aborted', code: 'invoice_assistant_stuck', message: '发票助手停在入口菜单，没有导入任何发票', billNo: null, capture: null };
  await channel.emit(event);
  return event;
};
