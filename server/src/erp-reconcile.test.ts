import { HUMAN_REVIEW_NOTICE, OCCUPANCY_COPY, TaskListSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDirBlobs } from './erp/cdp-executor';
import { runFillJob } from '@baox/erp-executor/job';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { createFakeErp, type FakeErp, type FakeErpOptions, type FakeReceiptLedger } from '@baox/erp-executor/testing/fake-erp';
import type { FillExecutor } from './erp/fill-jobs';
import type { ExecutorChannel, ExecutorEvent, FillPlan, Mutation, ResultEvent } from '@baox/erp-executor/protocol';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { COMPATIBILITY, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './erp/testing/scenario';
import { handedOver, noFormOpen, scripted, TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import { api, sample } from './test/api';
import { tempDataDir, testClient, type TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer, type Scene } from './test/scenario';
import { join } from 'node:path';

// Slice 13 (#192): any loss after `attempt_started` lands in reconcile, never in a replay. Faults are injected into
// the real executor on the fake ERP at each mutation point (import, fill): the attempt is durable, then the job dies.
// The read-only reconcile job then reads the same fake ERP and the server places it in one 对账中断点.
//
// Every task is the scenario builder's default (hotel e-invoice + folio, confirmed on P-2307); the fake ERP knows the
// invoice by its bytes and by the face values the task read from it.

const RECEIPT_NUMBER = 'SPD202609150001';
// ERP's verbatim refusal of an invoice bound to a 历史费用报销单 (a past reimbursement bill).
const DUPLICATE_REFUSAL = '重复报销，禁止导入：该发票已被历史费用报销单占用。';

// Where the fill job dies: right after the attempt of that mutation is durable (before ERP changes), or once the
// strict hand-over read-back is durable. The job never saves (ADR-0028), so there is no
// `save` attempt to die at.
type Fault = Exclude<Mutation, 'save'> | 'before_hand_over';

let server: ScenarioServer;
let alice: TestClient;
let bobClient: TestClient;
// Built on the first fill run, from the task it fills.
let fakeOptions: FakeErpOptions | null = null;
let importRefusal: string | undefined;
let fake: FakeErp | null = null;
let fault: Fault | null = null;
let fillRuns = 0;
// Every plan a fill run was handed, in order: what tells 去报销 from 重新去报销 on the executor's side.
let plans: FillPlan[] = [];
// The 收票单 (receipt records) ERP holds. A fill run gets a new page instance (V-45: the 发票助手 is usable once per
// page instance), and this ledger is what outlives it: ADR-0026's finding is precisely that the 收票单 an abandoned
// unsaved bill created is still there, and that re-importing its invoice overwrites it instead of adding a second.
let receiptLedger: FakeReceiptLedger = new Map();

// The channel as the executor sees it, with the crash injected after the server has persisted the event.
function faulty(channel: ExecutorChannel): ExecutorChannel {
  const emit = async (event: ExecutorEvent) => {
    const reply = await (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);
    if (event.type === 'attempt_started' && event.action === fault) throw new Error(`injected fault at ${event.action}`);
    if (event.type === 'readback' && event.stage === 'before_hand_over' && fault === 'before_hand_over') throw new Error('injected fault at before_hand_over');
    return reply;
  };
  return { emit: emit as ExecutorChannel['emit'] };
}

// The fake ERP's view of the task's one invoice: its bytes, and the face values and amounts the task confirmed.
function fakeErpFor(task: TaskSnapshot): FakeErpOptions {
  const [line] = task.lines;
  if (!line) throw new Error('expected one line');
  const face = Object.fromEntries(task.materials.find((m) => m.materialId === line.voucherMaterialId)!.fields.map((field) => [field.key, field.value]));
  return fakeErpOptions({
    invoices: [{ bytes: new Uint8Array(sample('m01').bytes), invoiceNumber: face['invoiceNumber']!, receiptNumber: RECEIPT_NUMBER, seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date, net: line.netAmount, tax: line.taxAmount, gross: line.grossAmount, category: '全电普通发票', ...(importRefusal ? { importRefusal } : {}) }],
    projects: [{ code: 'P-2307', name: '华东客户交付' }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
    assumeReceiptLink: true,
    receiptLedger,
  });
}

// A run that stops before it touches anything (no Chromium, say): a result and no attempt at all.
let stopBeforeWrite = false;
const fillExecutor: FillExecutor = async (plan, channel) => {
  fillRuns += 1;
  plans.push(plan);
  if (stopBeforeWrite) {
    const event: ResultEvent = { type: 'result', status: 'aborted', code: 'chromium_unavailable', message: '报销专用 Chromium 浏览器不可用', billNo: null, capture: null };
    await channel.emit(event);
    return event;
  }
  fakeOptions ??= fakeErpFor(await api(() => alice).current(plan.taskId));
  fake = await createFakeErp(fakeOptions);
  return runFillJob(plan, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel: faulty(channel), pace: FAST_PACE, probeWaitMs: 0 });
};
// True once the ERP browser has been cleaned (what `reset-erp-tabs.ts` does): no 费用报销单 is open any more, and an
// unsaved one does not outlive its tab.
let erpTabsClosed = false;
// The reconcile job reads whatever the fill left on the same fake ERP — unless the browser was cleaned first.
const reconcileExecutor: ReconcileExecutor = async (plan, channel) =>
  (erpTabsClosed ? noFormOpen(plan, channel) : runReconcileJob(plan, { browser: fake!.browser, channel, pace: FAST_PACE, probeWaitMs: 0 }));

beforeEach(async () => {
  fakeOptions = null;
  importRefusal = undefined;
  fake = null;
  fault = null;
  fillRuns = 0;
  plans = [];
  erpTabsClosed = false;
  stopBeforeWrite = false;
  receiptLedger = new Map();
  server = await scenarioServer({ erpExecutor: fillExecutor, reconcileExecutor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
  bobClient = await server.signIn('bob');
});
afterEach(() => server.close());

// Alice's task, stopped in 对账 by a fill job that died at `point`.
const crashedAt = (point: Fault): Promise<Scene> => {
  fault = point;
  return scenario(server, alice).at('reconcile');
};

const taskList = async () => TaskListSchema.parse(await (await alice.request('/api/tasks')).json());

// The 收票信息 grid as a page reader sees it: the 收票单 (receipt number) of each data row, and the grid's
// 价税合计 total. Duplication shows in both.
const RECEIPTS_GRID = '.kd-grid-panel[data-grid="receipts"]';
const receiptNumbers = (erp: FakeErp) =>
  [...erp.document.querySelectorAll(`${RECEIPTS_GRID} tbody tr`)]
    .filter((tr) => !tr.classList.contains('k-footer-template'))
    .map((tr) => String(tr.children[0]?.textContent ?? '').trim());
const receiptTotal = (erp: FakeErp) => String(erp.document.querySelector(`${RECEIPTS_GRID} tr.k-footer-template`)?.children[6]?.textContent ?? '').trim();
// The audit trail below (job ids, triggers, attempts) is not in the snapshot, so these read the facts directly.
const jobIds = async (taskId: string) => (await server.db.selectFrom('erp_job').select(['job_id']).where('task_id', '=', taskId).where('kind', '=', 'fill').orderBy('started_at').execute()).map((row) => row.job_id);

describe('fault injection at each ERP mutation point', () => {
  it.each([
    // The fake ERP's blank form keeps one empty detail row, which reads as unreadable: 未知 (unverified on a real ERP).
    ['import', '未知', ['wait', 'hand_off']],
    ['fill', '未保存·已导入未写明细', ['refill', 'hand_off']],
  ] as const)('a fault at %s stops in reconcile, and the reconcile job lands in %s', async (point, bucket, allowed) => {
    const scene = await crashedAt(point);
    // Write result unknown: reconcile before any read, offering only 开始对账 and 转人工.
    expect(scene.reached).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', bucket: null, allowedActions: ['wait', 'hand_off'] } });
    expect(scene.reached.erp.abortReason).toContain(`injected fault at ${point}`);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    const mutationsBefore = fake!.mutations.length;

    const judged = await scene.run('reconcile');
    expect(judged).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, reconcile: { bucket, allowedActions: allowed } });
    expect(judged.reconcile.reasons.length).toBeGreaterThan(0);
    // Read-only: nothing changed in ERP, the fill job never ran again, the lease is free again.
    expect(fake!.mutations.length).toBe(mutationsBefore);
    expect(fillRuns).toBe(1);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('已导入未写明细 with no 单据编号 is recoverable: the exits are 重新去报销 and 转人工, and it is not a 转人工 outcome', async () => {
    const scene = await crashedAt('fill');
    const judged = await scene.run('reconcile');
    expect(judged.reconcile).toMatchObject({
      bucket: '未保存·已导入未写明细', action: '原地等待', actionCode: 'refill',
      allowedActions: ['refill', 'hand_off'], humanReview: false, draftNo: null,
    });
    // The banner says what ADR-0027 asks it to say: the invoices are held by the unsaved bill, not spent, and the
    // abandoned form needs no cleanup.
    expect(judged.reconcile.banner).toContain('没有保存的单据');
    expect(judged.reconcile.banner).toContain('不需要你去清理');
    // 原地等待 here is 重新去报销, not 再对一次账: 重新对账 is refused exactly as it was before this exit existed.
    expect(await scene.refused('reconcile')).toEqual({ status: 400, code: 'action_not_allowed' });

    // 转人工 is the other exit, and it is still terminal.
    const handedOff = await scene.accept('hand-off');
    expect(handedOff).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off', bucket: '未保存·已导入未写明细', allowedActions: [], humanReview: true, banner: HUMAN_REVIEW_NOTICE } });
    expect((await taskList()).tasks[0]).toMatchObject({ stage: 'reconcile', erpOutcome: 'handed_off', abandonable: true, erpTouched: true });
    expect(await scene.refused('refill')).toEqual({ status: 400, code: 'task_closed' });
    // 去打印 never needs ERP (stories 57 and 63): 转人工 hands the ERP draft to a person, and that person still
    // wants the paper bundle, so print stays open on a handed-off task.
    expect((await alice.post(`/api/tasks/${scene.task.taskId}/actions/generate-print-sheet`, {})).status).toBe(200);
    expect((await scene.snapshot()).printSheet.status).toBe('generated');
    // Handed off is terminal: the account may start its next task; the handed-off task still holds its invoices.
    expect((await alice.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  });

  it('重新去报销 runs the fill again on a fresh 新增单 and hands over, with the 收票网格 holding N rows and not 2N', async () => {
    const scene = await crashedAt('fill');
    const judged = await scene.run('reconcile');
    const taskId = scene.task.taskId;
    const [firstJob] = await jobIds(taskId);
    // What the abandoned bill left in ERP: one 收票行 per invoice, and the total of those rows.
    expect(receiptNumbers(fake!)).toEqual([RECEIPT_NUMBER]);
    const importedTotal = receiptTotal(fake!);

    // The recovery takes the account's ERP lease like any other fill job.
    server.erpLease.acquire({ accountId: alice.account.accountId, taskId: 'another-task', jobId: 'another-job' });
    expect(await scene.refused('refill')).toEqual({ status: 409, code: 'erp_in_use' });
    server.erpLease.release('another-job');

    fault = null;
    const started = await scene.accept('refill');
    expect(started).toMatchObject({ stage: 'erp', erp: { status: 'running' } });
    const over = await scene.settled();
    expect(over).toMatchObject({ stage: 'done', erp: { status: 'done', draftNo: null }, readback: { status: 'matched' } });
    expect(fillRuns).toBe(2);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    // Only the recovery is told to replace an open 新增: live, ERP keeps the abandoned bill's tab, and reusing it
    // put the re-import on a form that already held its 收票行 (2026-09-21). 去报销 still reuses a blank one.
    expect(plans.map((plan) => plan.replaceAbandonedForm ?? false)).toEqual([false, true]);

    // The second run imported the same invoice into a fresh 新增单. ERP still holds the 收票单 it minted for the bill
    // that was abandoned unsaved, so this import overwrote it rather than minting a second one: N rows, not 2N, and
    // the grid's total is the one invoice's, not twice it.
    expect(receiptNumbers(fake!)).toEqual([RECEIPT_NUMBER]);
    expect(receiptTotal(fake!)).toBe(importedTotal);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    // The app's own duplicate gate did not block the re-import: the occupancy belongs to this same 报销任务.
    expect(over.blockers).toEqual([]);

    // A new fill job on the same task, with its own attempts; the 对账 job still points at the fill job it read.
    const jobs = await jobIds(taskId);
    expect(jobs).toHaveLength(2);
    const recoveryJob = jobs[1]!;
    expect(recoveryJob).not.toBe(firstJob);
    // The audit trail tells the recovery from the original 去报销 by what is on the row, not by row order.
    expect(await server.db.selectFrom('erp_job').select(['job_id', 'trigger']).where('task_id', '=', taskId).orderBy('started_at').execute()).toEqual([
      { job_id: firstJob, trigger: 'start' },
      { job_id: recoveryJob, trigger: 'refill' },
    ]);
    const attempts = await server.db.selectFrom('erp_attempt').select(['job_id', 'action']).where('task_id', '=', taskId).execute();
    expect(attempts.filter((attempt) => attempt.job_id === recoveryJob).map((attempt) => attempt.action)).toEqual(['import', 'fill']);
    expect(attempts.filter((attempt) => attempt.job_id === firstJob).length).toBeGreaterThan(0);
    expect((await server.db.selectFrom('erp_reconcile_job').select(['fill_job_id']).where('task_id', '=', taskId).execute()).map((row) => row.fill_job_id)).toEqual([firstJob]);

    // Nothing was re-confirmed: the same confirmation, the same lines.
    expect(await server.db.selectFrom('review_confirmation').select(['digest']).where('task_id', '=', taskId).execute()).toHaveLength(1);
    expect(over.confirmation.status).toBe('confirmed');
    expect(over.lines.map((line) => line.lineId)).toEqual(judged.lines.map((line) => line.lineId));
  });

  it('对账 with no 费用报销单 open keeps 重新去报销: cleaning the ERP browser is not evidence and is not terminal', async () => {
    const scene = await crashedAt('fill');
    // What the abandoned bill left behind stays behind: the 收票单 outlives the tab, the unsaved bill does not.
    expect(receiptNumbers(fake!)).toEqual([RECEIPT_NUMBER]);
    erpTabsClosed = true;

    const judged = await scene.run('reconcile');
    expect(judged.reconcile).toMatchObject({
      bucket: '未知', action: '原地等待', actionCode: 'refill',
      allowedActions: ['refill', 'wait', 'hand_off'], humanReview: false, draftNo: null,
    });
    expect(judged.reconcile.banner).toContain('没有打开任何费用报销单');
    // 再对一次账 stays open too: the employee may open the bill again and have it read properly.
    await scene.run('reconcile');

    // And the recovery runs: a fresh 新增单, the same invoice re-imported over its own 收票单, one row and not two.
    erpTabsClosed = false;
    fault = null;
    const started = await scene.accept('refill');
    expect(started).toMatchObject({ stage: 'erp', erp: { status: 'running' } });
    const over = await scene.settled();
    expect(over).toMatchObject({ stage: 'done', erp: { status: 'done', draftNo: null }, readback: { status: 'matched' } });
    expect(receiptNumbers(fake!)).toEqual([RECEIPT_NUMBER]);
    expect(fillRuns).toBe(2);
  });

  it('a 重新去报销 that stops before writing leaves the exits open, and never claims the task can just go again', async () => {
    const scene = await crashedAt('fill');
    await scene.run('reconcile');
    fault = null;
    stopBeforeWrite = true;
    const stopped = await scene.run('refill');
    expect(fillRuns).toBe(2);

    // This job wrote nothing, but the import the first one made is still unsettled: the task stays in 对账, which is
    // the only thing that can settle it. The copy must not offer 去报销, which the ADR-0014 freeze refuses.
    expect(stopped).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' } });
    expect(stopped.erp.abortReason).toContain('报销专用 Chromium 浏览器不可用');
    expect(stopped.erp.abortReason).not.toContain('可以再去报销');
    expect(stopped.reconcile.allowedActions).toEqual(['wait', 'hand_off']);
    expect(await scene.refused('start-erp-write')).toEqual({ status: 400, code: 'erp_started' });

    // And the exits work: 对账 reads the bill the first run left, and offers the recovery again.
    stopBeforeWrite = false;
    const again = await scene.run('reconcile');
    expect(again.reconcile).toMatchObject({ bucket: '未保存·已导入未写明细', actionCode: 'refill' });
  });

  it('重新去报销 is absent once the readings carry a 单据编号, and 转人工 remains offered', async () => {
    const scene = await crashedAt('before_hand_over');
    // The employee saved the form themselves, and what ERP holds no longer adds up to what was confirmed.
    driftDetailCell('税额', '999.99');
    fake!.employeeSaves();
    const judged = await scene.run('reconcile');
    expect(judged.reconcile).toMatchObject({ bucket: '已保存', actionCode: 'hand_off', allowedActions: ['hand_off'], humanReview: true });
    expect(judged.reconcile.draftNo).toEqual(expect.any(String));
    expect(await scene.refused('refill')).toEqual({ status: 400, code: 'action_not_allowed' });
    expect((await scene.accept('hand-off')).reconcile.status).toBe('handed_off');
  });

  it('重新去报销 is refused when the snapshot did not offer it, and 去报销 stays refused on an attempted task', async () => {
    const scene = await crashedAt('import');
    const judged = await scene.run('reconcile');
    expect(judged.reconcile.allowedActions).toEqual(['wait', 'hand_off']);
    expect(await scene.refused('refill')).toEqual({ status: 400, code: 'action_not_allowed' });
    // The bypass belongs to 重新去报销 alone: the start path still refuses a task whose ERP was already attempted.
    expect(await scene.refused('start-erp-write')).toEqual({ status: 400, code: 'erp_started' });
    expect(fillRuns).toBe(1);
  });

  it('an invoice ERP refuses as 重复报销，禁止导入 aborts, carrying its words through, and offers only 转人工', async () => {
    importRefusal = DUPLICATE_REFUSAL;
    const scene = await scenario(server, alice).at('reconcile');
    const stopped = scene.reached;
    expect(stopped).toMatchObject({ stage: 'reconcile', erp: { status: 'aborted' } });
    // ERP's own words, verbatim: the invoice is bound to a 历史费用报销单 and this run cannot fix it.
    expect(stopped.reconcile.capture?.erpText.join(' ')).toContain(DUPLICATE_REFUSAL);
    expect(stopped.reconcile.allowedActions).not.toContain('refill');
    expect(stopped.reconcile.allowedActions).toContain('hand_off');
    expect(await scene.refused('refill')).toEqual({ status: 400, code: 'action_not_allowed' });
    expect(receiptNumbers(fake!)).toEqual([]);
    expect((await scene.accept('hand-off')).reconcile.status).toBe('handed_off');
  });

  it('an invoice held by a different 报销任务 is still a hard block', async () => {
    // The recovery is offered on alice's task, so its own occupancy does not block its own re-import.
    const judged = await (await crashedAt('fill')).run('reconcile');
    expect(judged.reconcile.allowedActions).toContain('refill');
    // Another task holding the same invoice is a different matter: ADR-0007's hard block is unchanged, and the
    // other account's task is never named (ADR-0018).
    const blocked = (await scenario(server, bobClient).at('inventory', { materials: ['m01'] })).reached;
    expect(blocked.blockers).toHaveLength(1);
    expect(blocked.blockers[0]).toMatchObject({ kind: 'duplicate_across_tasks', resolver: '要你处理', reason: OCCUPANCY_COPY.otherAccount, tasks: [] });
  });

  it('a form the employee saved themselves reconciles to 已保存 and, matching the approved preview line by line, is done', async () => {
    const scene = await crashedAt('before_hand_over');
    // baox never clicks 保存 (ADR-0028); the employee does, and 对账 is how that save becomes evidence.
    fake!.employeeSaves();
    const judged = await scene.run('reconcile');
    expect(judged).toMatchObject({ stage: 'done', erp: { status: 'done' }, readback: { status: 'matched' } });
    expect(judged.erp.draftNo).toEqual(expect.any(String));
  });

  it('a filled, unsaved form that matches the approved preview line by line reconciles to the hand-over terminal', async () => {
    const scene = await crashedAt('before_hand_over');
    // The resume path: nobody saved, so 对账 reads 未保存·就绪待保存 with the strict per-line match satisfied. That is
    // ERP 单据已交接 (bill handed over), the same terminal a clean run reaches — not a breakpoint.
    const judged = await scene.run('reconcile');
    expect(judged).toMatchObject({ stage: 'done', erp: { status: 'done', draftNo: null }, readback: { status: 'matched' } });
    // Nothing is offered to deal with: the employee never sees a reconcile page for this task.
    expect(judged.step.kind).not.toBe('reconcile');
    expect(judged.reconcile).toMatchObject({ status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null });
    // The read-back rows are the evidence the terminal rests on, and no save was ever recorded.
    expect(judged.readback.rows.length).toBeGreaterThan(0);
    expect(fake!.mutations.some((mutation) => mutation.kind === 'save')).toBe(false);
    // Terminal: the account may start its next 报销任务.
    expect((await alice.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  });

  it('the hand-over promotion needs the totals to agree: a detail amount that drifted stays a breakpoint', async () => {
    const scene = await crashedAt('before_hand_over');
    // The unsaved form drifts on one money cell, so the form no longer adds up to the task. Since the owner's
    // 2026-09-20 decision that is the whole test of a form, and it alone must keep the task out of the terminal.
    driftDetailCell('税额', '999.99');
    const judged = await scene.run('reconcile');
    expect(judged.stage).toBe('reconcile');
    expect(judged.step.kind).toBe('reconcile');
    expect(judged.erp.status).not.toBe('done');
    expect(judged.reconcile).toMatchObject({ action: '转人工', actionCode: 'hand_off', humanReview: true });
    expect(judged.readback).toMatchObject({ status: 'none', rows: [] });
  });

  it('a form under another instance UUID than the attempt\'s is never judged: 未知', async () => {
    const scene = await crashedAt('before_hand_over');
    fake!.replaceFormInstance();
    const judged = await scene.run('reconcile');
    expect(judged.reconcile).toMatchObject({ bucket: '未知', allowedActions: ['wait', 'hand_off'] });
    expect(judged.reconcile.reasons.join('')).toContain('表单实例');
  });

  it('hands off before any reconcile, straight from the abort', async () => {
    const scene = await crashedAt('import');
    const handedOff = await scene.accept('hand-off');
    expect(handedOff).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off', humanReview: true } });
    // 转人工 is terminal for the ERP side, not for the task row: it can still be voided out of the list (ADR-0030).
    const voided = await alice.post(`/api/tasks/${scene.task.taskId}/abandon`, {});
    expect(voided.status).toBe(200);
  });

  it("holds the ERP lease while reconcile reads: 409 erp_in_use for another task of the same account, the lease is freed on the result", async () => {
    const scene = await crashedAt('before_hand_over');
    server.erpLease.acquire({ accountId: alice.account.accountId, taskId: 'another-task', jobId: 'another-job' });
    expect(await scene.refused('reconcile')).toEqual({ status: 409, code: 'erp_in_use' });
    server.erpLease.release('another-job');
    await scene.run('reconcile');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });
});

describe('crash recovery', () => {
  it('a restart mid-job comes back in reconcile, and no mutation is replayed', async () => {
    const dir = tempDataDir();
    const database = join(dir, 'baox.sqlite');
    // The first process: the fill job persists its import attempt, then the process dies before any result.
    let hang!: (error: Error) => void;
    const dead = new Promise<never>((_resolve, reject) => { hang = reject; });
    const dying: FillExecutor = async (plan, channel) => {
      await channel.emit({
        type: 'attempt_started', attemptId: `${plan.jobId}.import`, action: 'import',
        preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 1 },
        expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT,
      });
      return dead;
    };
    const first = await scenarioServer({ erpExecutor: dying, database, dataDir: dir });
    const scene = await scenario(first).at('actions');
    const owner = scene.client;
    await scene.accept('start-erp-write');
    await expect.poll(async () => (await first.db.selectFrom('erp_attempt').select('attempt_id').execute()).length).toBe(1);
    expect(await scene.snapshot()).toMatchObject({ stage: 'erp', erp: { status: 'running' } });

    // The second process on the same data: the job gets its result before any request is served.
    const neverRun = scripted(handedOver());
    const second = await scenarioServer({ erpExecutor: neverRun, reconcileExecutor: noFormOpen, database, dataDir: dir });
    const again = await scenario(second, testClient(second.app, owner.account, owner.cookie)).of(scene.task.taskId);
    expect(again.reached).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', allowedActions: ['wait', 'hand_off'] } });
    expect(again.reached.erp.abortReason).toContain('不会重放');
    expect(await again.refused('start-erp-write')).toEqual({ status: 400, code: 'erp_started' });
    // Voiding is open here too (ADR-0030); this test goes on reconciling instead, which is the interesting path.

    // Reconcile only reads; the fill job is never run again and no attempt is added.
    await again.accept('reconcile');
    await expect.poll(async () => (await again.snapshot()).reconcile.bucket).toBe('未知');
    expect(await again.accept('hand-off')).toMatchObject({ stage: 'reconcile', reconcile: { status: 'handed_off' } });
    expect(neverRun.runs()).toEqual([]);
    expect(await second.db.selectFrom('erp_attempt').select('attempt_id').execute()).toHaveLength(1);

    await second.close();
    hang(new Error('process died'));
    await first.close().catch(() => undefined);
  });
});

/** Rewrite one cell of the detail grid's single data row on the fake ERP. */
function driftDetailCell(column: string, text: string) {
  const panel = fake!.document.querySelector('.kd-grid-panel[data-grid="detail"]')!;
  const headers = [...panel.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').replace('*', '').trim());
  const cell = panel.querySelector('tbody tr.k-master-row')!.children[headers.indexOf(column)]!;
  const inner = cell.querySelector('span, a');
  if (inner) inner.textContent = text;
  else cell.textContent = text;
}
