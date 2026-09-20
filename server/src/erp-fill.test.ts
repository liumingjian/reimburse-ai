import { ABANDON_TASK_COPY, ERP_ACTION_ERRORS, ERP_HANDOVER_STEP_COPY, TaskListSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { abortBeforeAttempt, catalogMismatch, gated, handedOver, loginWall, readbackMismatch, scripted, TEST_ERP_ACCOUNT, type ScriptedExecutor } from './erp/testing/fake-executor';
import { api, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 12 (#191): 去报销 (fill ERP) end to end on a fake executor. The job runs in the background; the snapshot is
// derived from the persisted job facts (ADR-0014/0016): login pause, cancel, catalog mismatch, write result unknown,
// hand-over. The global ERP lease is held only while a job runs.

const CATALOG = fixtureCatalog([
  { number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false },
  { number: 'P-3312', name: '产品调研', audited: true, forbidden: false },
]);

let server: TestServer;
let alice: TestClient;
let executor: ScriptedExecutor;
beforeEach(async () => {
  executor = scripted(loginWall);
  server = await createTestServer({ projectCatalog: CATALOG, erpExecutor: executor });
  alice = await server.signIn('alice');
  for (const number of ['P-2307', 'P-3312']) expect((await alice.post('/api/project-book/intake', { number, name: number === 'P-2307' ? '华东客户交付' : '产品调研' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

// Hotel e-invoice + its 全季 folio: one accommodation line, confirmed on P-2307 → actions / choose_action.
async function confirmed(): Promise<TaskSnapshot> {
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  expect(done.lines.length).toBeGreaterThan(0);
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  const ready = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
  expect(ready).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' } });
  return ready;
}

// Waits until the background ERP job stopped running.
async function settledErp(taskId: string, timeoutMs = 10_000): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running') return snapshot;
    if (Date.now() > deadline) throw new Error('ERP job still running');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function start(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
  await client.accepted(await client.act(snapshot, 'start-erp-write'));
  return settledErp(snapshot.task.taskId);
}

async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

const taskList = async () => TaskListSchema.parse(await (await alice.request('/api/tasks')).json());

describe('去报销 on a fake executor', () => {
  it('pauses for login: stage erp, step erp_login, no attempt, lease released; confirm-login re-probes once', async () => {
    const ready = await confirmed();
    const waiting = await start(ready);
    expect(waiting).toMatchObject({ stage: 'erp', step: { kind: 'erp_login' }, erp: { status: 'waiting_login', loginNotice: null } });
    expect(waiting.erp.steps.find((step) => step.key === 'login')?.status).toBe('waiting');
    expect(server.erpLease.holder()).toBeNull();
    expect(executor.runs().map((run) => run.trigger)).toEqual(['start']);
    // The plan carries the confirmed lines' projects and the voucher invoices by content.
    expect(executor.runs()[0]!.plan).toMatchObject({ kind: 'fill', taskId: ready.task.taskId, purpose: '上海产品评审出差', catalog: { projects: [{ code: 'P-2307', name: '华东客户交付' }], expenseItems: [{ code: 'FY010001', name: '住宿' }] } });
    expect(executor.runs()[0]!.plan.invoices).toHaveLength(1);

    // Still not logged in: stays, with a notice.
    const again = await client.accepted(await client.act(waiting, 'confirm-login'));
    const still = await settledErp(again.task.taskId);
    expect(still).toMatchObject({ stage: 'erp', step: { kind: 'erp_login' }, erp: { status: 'waiting_login' } });
    expect(still.erp.loginNotice).toEqual(expect.any(String));
    expect(executor.runs().map((run) => run.trigger)).toEqual(['start', 'confirm_login']);

    executor.queue(handedOver());
    await client.accepted(await client.act(still, 'confirm-login'));
    const done = await settledErp(still.task.taskId);
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', draftNo: null } });
  });

  it('cancel-erp-write returns to write-pending and the task can start again', async () => {
    const waiting = await start(await confirmed());
    const cancelled = await client.accepted(await client.act(waiting, 'cancel-erp-write'));
    expect(cancelled).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle', abortReason: null }, confirmation: { status: 'confirmed' } });
    await refused(await client.act(cancelled, 'cancel-erp-write'), 400, 'not_waiting_login');
    await refused(await client.act(cancelled, 'confirm-login'), 400, 'not_waiting_login');

    executor.queue(handedOver());
    expect((await start(cancelled)).stage).toBe('done');
  });

  it('answers every mutation other than confirm-login / cancel-erp-write with 409 during the login pause', async () => {
    const waiting = await start(await confirmed());
    const id = waiting.task.taskId;
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
      const response = await client.act(waiting, name, body);
      expect(response.status, name).toBe(409);
    }
    expect((await client.uploadRaw(id, [sample('m03')])).status).toBe(409);
    expect((await alice.post(`/api/tasks/${id}/abandon`, {})).status).toBe(409);
    // Nothing changed: the same step still stands.
    expect((await client.current(id)).step.stepToken).toBe(waiting.step.stepToken);
  });

  it('a catalog mismatch aborts before import, with no attempt, and returns to project assignment', async () => {
    executor.queue(catalogMismatch);
    const mismatch = await start(await confirmed());
    expect(mismatch).toMatchObject({ stage: 'project', step: { kind: 'assign_projects' }, erp: { status: 'idle' }, catalog: { status: 'mismatch' } });
    expect(mismatch.catalog.problems).toEqual([expect.objectContaining({ subject: '项目号 P-2307', resolver: '要你处理' })]);
    expect(mismatch.catalog.problems[0]!.reason).toContain('改过名的项目');
    expect(server.erpLease.holder()).toBeNull();
    expect((await taskList()).tasks[0]).toMatchObject({ abandonable: true });

    // Reassigning and resubmitting leaves the mismatch behind: review again, confirm, write again.
    const resubmitted = await client.accepted(await client.act(mismatch, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(mismatch.lines.map((line) => [line.lineId, 'P-3312'])) }));
    expect(resubmitted).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, catalog: { status: 'pending' } });
    const reconfirmed = await client.accepted(await client.act(resubmitted, 'confirm-review', { digest: resubmitted.confirmation.digest }));
    executor.queue(handedOver());
    expect((await start(reconfirmed)).stage).toBe('done');
  });

  it('a read-back mismatch after an attempt is ERP 写入结果未知: reconcile, frozen, not voidable', async () => {
    executor.queue(readbackMismatch);
    const unknown = await start(await confirmed());
    expect(unknown).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending' } });
    expect(unknown.erp.abortReason).toContain('金额相等不能代替逐行一致');
    expect(unknown.erp.erpAccount).toEqual(TEST_ERP_ACCOUNT);
    expect(server.erpLease.holder()).toBeNull();

    await refused(await client.act(unknown, 'set-home-city', { homeCity: '上海' }), 400, 'erp_started');
    await refused(await client.act(unknown, 'start-erp-write'), 400, 'erp_started');
    const voided = await alice.post(`/api/tasks/${unknown.task.taskId}/abandon`, {});
    expect(voided.status).toBe(400);
    expect(await voided.json()).toMatchObject({ error: { code: 'erp_started', message: ABANDON_TASK_COPY.blockedReason } });
    expect((await taskList()).tasks[0]).toMatchObject({ stage: 'reconcile', abandonable: false, abandonBlockedReason: ABANDON_TASK_COPY.blockedReason });
    // Still the account's one non-terminal task.
    await refused(await alice.post('/api/tasks', { homeCity: '杭州' }), 400, 'active_task_exists');
  });

  it('完全重置 never voids a task that touched ERP: it keeps holding its invoices', async () => {
    executor.queue(readbackMismatch);
    const unknown = await start(await confirmed());
    expect(unknown.stage).toBe('reconcile');

    // Reset is a bulk 任务作废 and may not release invoices the abandon action itself refuses to release (story 21).
    const reset = await alice.post('/api/reset', {});
    expect(reset.status).toBe(200);
    expect(TaskListSchema.parse(await reset.json()).tasks).toEqual([expect.objectContaining({ taskId: unknown.task.taskId, stage: 'reconcile', abandonable: false })]);
    expect((await client.current(unknown.task.taskId)).stage).toBe('reconcile');
  });

  it('完全重置 still voids a task that never touched ERP', async () => {
    const ready = await confirmed();
    const reset = await alice.post('/api/reset', {});
    expect(TaskListSchema.parse(await reset.json()).tasks).toEqual([]);
    expect((await client.current(ready.task.taskId)).stage).toBe('voided');
  });

  it('a filled, unsaved form that passed the strict read-back is done (ERP 单据已交接), a terminal', async () => {
    executor.queue(handedOver());
    const done = await start(await confirmed());
    // Nothing was saved, so there is no 单据编号 to report — the read-back rows are the whole of the evidence.
    expect(done).toMatchObject({ stage: 'done', step: { kind: 'none' }, erp: { status: 'done', draftNo: null, erpAccount: TEST_ERP_ACCOUNT }, readback: { status: 'matched' } });
    expect(done.readback.rows).toHaveLength(done.lines.length);
    expect(done.readback.rows.every((row) => row.matched)).toBe(true);
    expect(done.erp.steps.every((step) => step.status === 'done')).toBe(true);
    // The list closes on the hand-over step, and its copy comes from the contract: the web mock's step list reads the
    // same constant, so the two lists cannot drift apart (ADR-0028).
    expect(done.erp.steps.at(-1)).toMatchObject({ ...ERP_HANDOVER_STEP_COPY, status: 'done' });
    expect(done.erp.steps.some((step) => step.title.includes('保存'))).toBe(false);
    expect(server.erpLease.holder()).toBeNull();

    expect((await taskList()).tasks[0]).toMatchObject({ stage: 'done', erpDraftNo: null, abandonable: false });
    await refused(await client.act(done, 'set-home-city', { homeCity: '上海' }), 400, 'task_closed');
    // 去打印 never needs ERP (stories 57 and 63), so the paper bundle is still available once the form is handed over.
    expect((await alice.post(`/api/tasks/${done.task.taskId}/actions/generate-print-sheet`, {})).status).toBe(200);
    expect((await client.current(done.task.taskId)).printSheet.status).toBe('generated');
    // The hand-over is terminal: the account may start the next task.
    expect((await alice.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  }, 120_000);

  it('a failure before the first attempt_started returns to write-pending and allows retry', async () => {
    executor.queue(abortBeforeAttempt, handedOver());
    const aborted = await start(await confirmed());
    expect(aborted).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, confirmation: { status: 'confirmed' } });
    expect(aborted.erp.abortReason).toContain('报销系统的版本与上次核对时不一致');
    expect(server.erpLease.holder()).toBeNull();
    expect((await taskList()).tasks[0]).toMatchObject({ abandonable: true });
    // Nothing was written, so the task is still editable.
    expect((await client.act(aborted, 'set-home-city', { homeCity: '杭州' })).status).toBe(200);

    const retried = await start(await client.current(aborted.task.taskId));
    expect(retried.stage).toBe('done');
  });

  it('holds the global lease while the job runs: 409 stale for this task, 409 erp_in_use for another account', async () => {
    const gate = gated(handedOver());
    executor.queue(gate.script);
    const ready = await confirmed();
    const running = await client.accepted(await client.act(ready, 'start-erp-write'));
    await gate.running;
    expect(running).toMatchObject({ stage: 'erp', step: { kind: 'none' }, erp: { status: 'running' } });
    expect(server.erpLease.holder()).toEqual({ accountId: alice.account.accountId, taskId: ready.task.taskId, jobId: expect.any(String) });

    const current = await client.current(ready.task.taskId);
    expect((await client.act(current, 'set-home-city', { homeCity: '上海' })).status).toBe(409);

    const bob = await server.signIn('bob');
    const bobTask = await api(() => bob).createTask('杭州');
    const blocked = await bob.post(`/api/tasks/${bobTask.task.taskId}/actions/start-erp-write`, { stepToken: bobTask.step.stepToken });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse } });

    gate.release();
    expect((await settledErp(ready.task.taskId)).stage).toBe('done');
    expect(server.erpLease.holder()).toBeNull();
  });

  // A 住宿 line needs its 离店日期, which only the folio carries; the hotel invoice on its own cannot be written.
  it('refuses to start when a confirmed line cannot be written to ERP, before any job', async () => {
    const { task } = await client.createTask('杭州');
    const uploaded = await client.upload(task.taskId, [sample('m01')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const done = await client.withoutStayGaps(await client.settled(task.taskId));
    const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
    const ready = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    const response = await client.act(ready, 'start-erp-write');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('erp_preflight');
    expect(body.error.message).toContain('离店日期');
    expect(executor.runs()).toEqual([]);
  });

  // ERP's 发票类型 enum has no 铁路电子客票 entry, but it does have 火车票, and that is what a rail e-ticket writes as.
  it('writes a 铁路电子客票 line as 火车票, the ERP enum entry for it, instead of refusing it', async () => {
    const { task } = await client.createTask('杭州');
    const uploaded = await client.upload(task.taskId, [sample('m07')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const done = await client.settled(task.taskId);
    const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
    const ready = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    expect(ready.lines.map((line) => line.invoiceType)).toEqual(['火车票']);
    await client.accepted(await client.act(ready, 'start-erp-write'));
    await settledErp(task.taskId);
    expect(executor.runs()).toHaveLength(1);
  });
});
