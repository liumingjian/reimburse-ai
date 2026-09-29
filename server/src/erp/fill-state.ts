// The 去报销 (fill ERP) state of a task, derived from stored facts (ADR-0014): the latest `erp_job`, its persisted
// executor events, its cancel, and the task's `erp_attempt` rows. Nothing about the phase is stored. The views below
// turn the record into the snapshot's `erp`, `readback`, `reconcile` and `catalog` sections.

import { ERP_PROGRESS_STEPS, HUMAN_REVIEW_NOTICE, READBACK_FIELD_LABELS, RECONCILE_ACTION_LABELS, type Catalog, type Erp, type ErpCapture, type ErpProgressStage, type ErpStep, type Line, type Readback, type ReadbackField, type ReadbackRow, type Reconcile, type ReconcileBucket } from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from '../db/database';
import type { ErpHandOffTable, ErpJobTable, TaskLifecycle } from '../db/schema';
import { erpActionsOf, reconcileActionsOf, type ErpFacts, type ErpPhase } from '../task-policy';
import type { FrozenJob } from './fill-plan';
import { ExecutorEventSchema, type ApprovedPreview, type ErpAccount, type ExecutorEvent, type Preconditions, type ReadbackEvent, type ResultEvent } from '@baox/erp-executor/protocol';
import { noFormOpen, type ReconcileVerdict } from './reconcile';
import { reconcileFromEvents } from './reconcile-job';
import { EXTENSION_CONNECTION_LOST_CODE, EXTENSION_OFFLINE_CODE } from '../extension/channel';

// One judged reconcile read-back: the verdict (after the form-instance / target check), the bill number it read, and
// the two terminals it can prove. `saved`: the draft saved exactly as approved (已保存, identity holds, strict
// per-line match passed). `handedOver`: the form is filled and ready to save exactly as approved
// (未保存·就绪待保存 plus the same strict per-line match) — ERP 单据已交接 (bill handed over), the resume path to the
// same terminal a clean run reaches (ADR-0028).
// `noForm`: 对账 found no 费用报销单 open on the page at all — the employee closed the tab, or the ERP browser was
// cleaned. It is a normal state, not evidence about this task, and it is told apart from every other 未知 because
// nothing else can be read once the form is gone.
export type ReconcileJudgement = { verdict: ReconcileVerdict; billNo: string | null; saved: boolean; handedOver: boolean; noForm: boolean };

// The latest reconcile run on the fill job: running until its result, and the newest judgement of any run.
export type ReconcileState = { jobId: string; result: ResultEvent | null; judged: ReconcileJudgement | null };

export type ErpRecord = {
  // null when the task never started 去报销.
  facts: ErpFacts | null;
  // Any ERP action attempt of the task (from any job): the freeze point of ADR-0014.
  attempted: boolean;
  job: ErpJobTable | null;
  frozen: FrozenJob | null;
  events: ExecutorEvent[];
  result: ResultEvent | null;
  // The ERP account and 账套 of the task's latest attempt: recorded, shown, never compared (ADR-0016).
  erpAccount: ErpAccount | null;
  // The preview the judge approved after import, if the job got that far.
  preview: ApprovedPreview | null;
  // What the latest attempt of the fill job observed right before its mutation (form-instance UUID, CDP target).
  attempt: Preconditions | null;
  // 对账 (#192) on the latest fill job, and the task's 转人工.
  reconcile: ReconcileState | null;
  handOff: ErpHandOffTable | null;
};

export const NO_ERP: ErpRecord = { facts: null, attempted: false, job: null, frozen: null, events: [], result: null, erpAccount: null, preview: null, attempt: null, reconcile: null, handOff: null };

const eventsOf = async (tx: Db, jobId: string): Promise<ExecutorEvent[]> =>
  (await tx.selectFrom('erp_job_event').select('payload').where('job_id', '=', jobId).orderBy('seq').execute()).map((row) => ExecutorEventSchema.parse(JSON.parse(row.payload)));
const lastResult = (events: readonly ExecutorEvent[]): ResultEvent | null => [...events].reverse().find((event): event is ResultEvent => event.type === 'result') ?? null;

/**
 * Judge a reconcile job's read-back against the fill it reconciles. The job reads whatever single form is open, so a
 * form under another form-instance UUID or in another CDP target than the fill's last attempt proves nothing about
 * this task: 未知 (wait), with the reason. Null when the job produced no read-back.
 */
export function judgeReconcile(events: ExecutorEvent[], preview: ApprovedPreview | null, attempt: Preconditions | null): ReconcileJudgement | null {
  const derived = reconcileFromEvents(events, preview);
  if (!derived) return null;
  const readback = [...events].reverse().find((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'reconcile')!;
  const read = { ...readback.readings, ...readback.form };
  const elsewhere: string[] = [];
  if (attempt) {
    if (read.formInstanceId && read.formInstanceId !== attempt.formInstanceId) elsewhere.push(`报销系统里打开的表单实例（${read.formInstanceId}）不是这次写入的那一张（${attempt.formInstanceId}），读到的内容不能说明这次写入的结果`);
    if (read.targetId && attempt.targetId && read.targetId !== attempt.targetId) elsewhere.push('报销系统所在的浏览器标签页不是这次写入时的那一个，读到的内容不能说明这次写入的结果');
  }
  const verdict: ReconcileVerdict = elsewhere.length ? { ...derived.verdict, bucket: '未知', action: '原地等待', reasons: [...elsewhere, ...derived.verdict.reasons] } : derived.verdict;
  // Both terminals rest on the same strict per-line match (`taskMatch`); only the bucket differs. The classifier is
  // untouched: it says what the ERP shows, this layer says what that means for the task (ADR-0027).
  const strictMatch = elsewhere.length === 0 && preview !== null && verdict.action === '原地等待' && derived.readings.taskMatch?.ok === true;
  const saved = strictMatch && verdict.bucket === '已保存';
  const handedOver = strictMatch && verdict.bucket === '未保存·就绪待保存';
  return { verdict, billNo: read.billNo.readable ? read.billNo.value : null, saved, handedOver, noForm: noFormOpen(derived.readings) };
}

/** The job's phase from its result (none yet = running) and whether its login pause was cancelled. */
export function phaseOf(result: ResultEvent | null, cancelled: boolean): ErpPhase {
  if (!result) return 'running';
  switch (result.status) {
    case 'waiting_login':
      return cancelled ? 'cancelled' : 'waiting_login';
    case 'catalog_mismatch':
      return 'catalog_mismatch';
    case 'handed_over':
      return 'handed_over';
    case 'saved':
      return 'saved';
    case 'unknown':
      return 'unknown';
    default:
      // `aborted`, and `read` which a fill job never sends: nothing was written.
      return 'aborted';
  }
}

export async function loadErp(tx: Db, taskId: string): Promise<ErpRecord> {
  const attempt = await tx.selectFrom('erp_attempt').select(['erp_account', 'erp_tenant', 'erp_display_name']).where('task_id', '=', taskId).orderBy('started_at', 'desc').executeTakeFirst();
  const erpAccount = attempt ? { displayName: attempt.erp_display_name, account: attempt.erp_account, tenant: attempt.erp_tenant } : null;
  const handOff = (await tx.selectFrom('erp_hand_off').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst()) ?? null;
  const job = await tx.selectFrom('erp_job').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  if (!job) return { ...NO_ERP, attempted: attempt !== undefined, erpAccount, handOff };
  const events = await eventsOf(tx, job.job_id);
  let result = lastResult(events);
  const cancelled = (await tx.selectFrom('erp_job_cancel').select('cancel_id').where('job_id', '=', job.job_id).executeTakeFirst()) !== undefined;
  let phase = phaseOf(result, cancelled);
  // A later job that wrote nothing does not settle what an earlier one left behind: once any attempt of this task is
  // durable, the task's ERP write result stays unknown until 对账 says otherwise (ADR-0016). Without this, a
  // 重新去报销 that stops before its first attempt (no Chromium, say) would report 「报销系统没有被改动，可以再去
  // 报销」 while every exit is refused — 去报销 and 作废 by the ADR-0014 freeze, 重新去报销 and 对账 and 转人工 by
  // the phase — leaving the task with no way out at all.
  if (phase === 'aborted' && attempt !== undefined) phase = 'unknown';
  const approved = await tx.selectFrom('erp_approved_preview').select('preview').where('job_id', '=', job.job_id).executeTakeFirst();
  const preview = approved ? (JSON.parse(approved.preview) as ApprovedPreview) : null;
  const lastAttempt = await tx.selectFrom('erp_attempt').select('preconditions').where('job_id', '=', job.job_id).orderBy(sql`rowid`, 'desc').executeTakeFirst();
  const attemptPre = lastAttempt ? (JSON.parse(lastAttempt.preconditions) as Preconditions) : null;
  // The newest reconcile run decides running / its notice; the newest run that read the form decides the bucket.
  let reconcile: ReconcileState | null = null;
  for (const run of await tx.selectFrom('erp_reconcile_job').select('job_id').where('fill_job_id', '=', job.job_id).orderBy('revision', 'desc').execute()) {
    const runEvents = await eventsOf(tx, run.job_id);
    reconcile ??= { jobId: run.job_id, result: lastResult(runEvents), judged: null };
    const judged = judgeReconcile(runEvents, preview, attemptPre);
    if (judged) {
      reconcile.judged = judged;
      break;
    }
  }
  // A reconcile that proves the draft saved exactly as approved (the same strict test a fill's `saved` passed) is
  // ERP 单据已交接: done, not a hand-off.
  if (phase === 'unknown' && reconcile?.judged?.saved) {
    phase = 'saved';
    result = { type: 'result', status: 'saved', code: 'reconciled', message: null, billNo: reconcile.judged.billNo, capture: null };
  }
  // The resume path to the same terminal a clean run reaches: a reconcile that proves the form is filled, ready to
  // save, and equal to the approved preview on every row is ERP 单据已交接 (bill handed over), not a breakpoint. Since
  // nothing was saved there is no 单据编号 (bill number) to report.
  if (phase === 'unknown' && reconcile?.judged?.handedOver) {
    phase = 'handed_over';
    result = { type: 'result', status: 'handed_over', code: 'reconciled', message: null, billNo: null, capture: null };
  }
  // A catalog mismatch sends the task back to project assignment until a new submission answers it.
  let reassign = false;
  if (phase === 'catalog_mismatch') {
    const submission = await tx.selectFrom('project_submission').select('revision').where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
    reassign = !submission || submission.revision < job.revision;
  }
  const reconciling = phase === 'unknown' && reconcile !== null && reconcile.result === null;
  return {
    facts: { jobId: job.job_id, trigger: job.trigger, revision: job.revision, phase, reassign, reconciling },
    attempted: attempt !== undefined,
    job,
    frozen: JSON.parse(job.plan) as FrozenJob,
    events,
    result,
    erpAccount,
    preview,
    attempt: attemptPre,
    reconcile,
    handOff,
  };
}

// ---- views ----

// Executor events are only interpreted here. The client receives the resulting stage and never infers progress from
// event names or event order.
const DISPLAY_EVENT_STEPS: Readonly<Record<ErpProgressStage, readonly string[]>> = {
  chromium: ['chromium'],
  login: ['login'],
  catalog: ['catalog'],
  navigate: ['navigate', 'compatibility'],
  import: ['import'],
  receipt: ['readback'],
  fill: ['fill'],
  handover: ['save', 'handover'],
};

const DISPLAY_STEPS: ReadonlyArray<{ key: ErpProgressStage; title: string; description: string; from: readonly string[] }> =
  ERP_PROGRESS_STEPS.map((step) => ({ ...step, from: DISPLAY_EVENT_STEPS[step.key] }));

function stepsOf(record: ErpRecord): ErpStep[] {
  const phase = record.facts?.phase;
  const latest = new Map<string, 'running' | 'done' | 'failed'>();
  for (const event of record.events) if (event.type === 'step') latest.set(event.step, event.status);
  const steps = DISPLAY_STEPS.map(({ key, title, description, from }): ErpStep => {
    let status: ErpStep['status'] = 'todo';
    for (const step of from) {
      const seen = latest.get(step);
      if (seen === 'failed') status = 'failed';
      else if (seen === 'running' && status !== 'failed') status = 'running';
      else if (seen === 'done' && status === 'todo') status = 'done';
    }
    if (phase === 'handed_over' || phase === 'saved') status = 'done';
    if (phase === 'waiting_login' && key === 'login') status = 'waiting';
    return { key, title, description, status };
  });
  if (phase === 'running' && steps.every((step) => step.status === 'todo')) steps[0] = { ...steps[0]!, status: 'running' };
  return steps;
}

function currentStageOf(steps: readonly ErpStep[]): Erp['currentStage'] {
  const active = steps.find((step) => step.status === 'waiting' || step.status === 'running' || step.status === 'failed');
  if (active) return active.key as ErpProgressStage;
  const complete = [...steps].reverse().find((step) => step.status === 'done');
  return complete ? complete.key as ErpProgressStage : null;
}

const EXTENSION_WAIT_CODES = new Set([EXTENSION_OFFLINE_CODE, EXTENSION_CONNECTION_LOST_CODE, 'extension_reconnect_expired']);

function externalWaitOf(record: ErpRecord): Erp['externalWait'] {
  if (record.facts?.phase === 'waiting_login') return 'employee_login';
  if (record.facts?.phase === 'running') return 'erp_response';
  return record.result?.code && EXTENSION_WAIT_CODES.has(record.result.code) ? 'extension_connection' : 'none';
}

// The executor's code for "报销信息核对 could not read the catalog" (`erp-executor/src/job.ts`). Nothing was written and
// nothing about the claim is wrong, so it gets its own sentence rather than the generic abort one.
const CATALOG_QUERY_FAILED = 'catalog_query_failed';
const CATALOG_QUERY_FAILED_REASON = '没能在报销系统里查到项目与费用项目，报销信息核对没有做完。报销系统没有被改动，明细也不用改：等报销系统能正常查询后再去报销。原因：';

/**
 * The executor's code for 「发票全部导入成功，但表单上盖着关不掉的窗口，费用明细没有开始填」
 * (`erp-executor/src/job.ts`). The phase is `unknown` because a durable attempt exists (ADR-0016) and the 费用报销单 is
 * not finished — but the import itself is NOT in doubt: it was judged on 处理结果 and confirmed by the
 * `after_import` read-back before this stop. Telling that employee 「写入报销系统的结果不确定」 would be false
 * about the part that is certain and useless about the part that is not, so this code keeps the executor's own
 * sentence, which names both: the invoices are bound, and a window is in the way.
 */
const FORM_OBSTRUCTED_BEFORE_FILL = 'form_obstructed_before_fill';

const LOGIN_NOT_DETECTED = '还没有检测到登录。请在为这次报销打开的报销系统标签页里登录本人账号（登录页上显示的上次账号不算已登录），完成后再点一次「我已登录，继续」。';

export function erpView(record: ErpRecord): Erp {
  const idle: Erp = {
    status: 'idle',
    steps: [],
    currentStage: null,
    externalWait: 'none',
    outcome: 'none',
    allowedActions: [],
    draftNo: null,
    abortReason: null,
    loginNotice: null,
    erpAccount: record.erpAccount,
  };
  const facts = record.facts;
  if (!facts) return idle;
  const steps = stepsOf(record);
  const readState = {
    steps,
    currentStage: currentStageOf(steps),
    externalWait: externalWaitOf(record),
    allowedActions: erpActionsOf(facts.phase),
  };
  const reason = record.result?.message ?? record.result?.code ?? '';
  switch (facts.phase) {
    case 'running':
      return { ...idle, ...readState, status: 'running' };
    case 'waiting_login':
      return { ...idle, ...readState, status: 'waiting_login', loginNotice: facts.trigger === 'confirm_login' ? LOGIN_NOT_DETECTED : null };
    case 'aborted':
      return {
        ...idle,
        ...readState,
        abortReason:
          record.result?.code === CATALOG_QUERY_FAILED
            ? `${CATALOG_QUERY_FAILED_REASON}${reason}`
            : `上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：${reason}`,
      };
    case 'handed_over':
      return { ...idle, ...readState, status: 'done', outcome: 'filled', draftNo: null };
    case 'saved':
      return { ...idle, ...readState, status: 'done', outcome: 'saved', draftNo: record.result?.billNo ?? null };
    case 'unknown':
      return { ...idle, ...readState, status: 'aborted', draftNo: record.result?.billNo ?? null,
        abortReason: record.result?.code === FORM_OBSTRUCTED_BEFORE_FILL
          ? reason
          : `写入报销系统的结果不确定，应用已停止写入，不会重放。原因：${reason}` };
    default:
      // Cancelled login pause, or a catalog mismatch (its problems are in the catalog section): nothing was written.
      return idle;
  }
}

const EMPTY_READBACK: Readback = { status: 'none', rows: [], summary: null, localTotal: null, erpTotal: null };

const money = (cents: number) => (cents / 100).toFixed(2);
const centsOf = (amount: string | null | undefined) => {
  const [whole = '0', fraction = ''] = String(amount ?? '0').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/**
 * The strict read-back the terminal rests on. A `handed_over` result exists only after the server judged the filled
 * form equal to the approved preview on every row and all nine fields, and a `saved` one only after the same
 * comparison on the saved form, so each field's ERP side equals its local side. At hand-over these rows are the
 * evidence the employee is asked to trust before they click 保存 (save). Net and tax come from the approved preview
 * (a rail line's come from ERP's receipt), the receipt number from its bindings.
 */
export function readbackView(record: ErpRecord, lines: readonly Line[]): Readback {
  const phase = record.facts?.phase;
  if (phase !== 'handed_over' && phase !== 'saved') return EMPTY_READBACK;
  const previewLine = new Map((record.preview?.lines ?? []).map((line) => [line.lineId, line]));
  const receipt = new Map((record.preview?.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding.receiptNumber]));
  const rows: ReadbackRow[] = lines.map((line) => {
    const approved = previewLine.get(line.lineId);
    const values: Record<(typeof READBACK_FIELD_LABELS)[number], string | null> = {
      申请报销金额: line.grossAmount,
      项目: line.projectName,
      费用项目: line.expenseItemName,
      开始日期: line.date,
      结束日期: line.endDate ?? line.date,
      费用金额: approved?.netAmount ?? line.netAmount,
      税额: approved?.taxAmount ?? line.taxAmount,
      收票单号: receipt.get(line.voucherMaterialId) ?? null,
      // The ERP 发票类型 the fill wrote (the face 票种 mapped onto ERP's enum, `fill-plan.ts`).
      发票类型: approved?.invoiceType ?? line.invoiceType,
    };
    const fields: ReadbackField[] = READBACK_FIELD_LABELS.map((label) => ({ label, local: values[label], erp: values[label], matched: true }));
    return { no: line.no, description: line.description, matched: true, fields, reasons: [] };
  });
  const total = money(lines.reduce((sum, line) => sum + centsOf(line.grossAmount), 0));
  return { status: 'matched', rows, summary: `明细 ${rows.length}/${rows.length} 一致`, localTotal: total, erpTotal: total };
}

// Reasons the strict comparison gave about one particular line ("任务第 3 行没有一条同时匹配…").
const LINE_REASON = /任务第 (\d+) 行/;

/**
 * Per-line evidence for the 对账 page, built from the confirmed lines exactly as `readbackView` builds the saved
 * draft's rows. Only 已保存 gets rows: that is the one bucket where the draft exists and the strict per-line
 * comparison actually ran, so "this line did not match, and here is why" means something. Before a save there is
 * nothing in ERP to compare a line against, and inventing rows would suggest otherwise.
 *
 * A reconcile read-back proves a whole form, not a value per field, so a line that drew a reason shows no ERP side
 * rather than echoing the local one back as if it had been read.
 */
function reconcileRows(record: ErpRecord, judged: ReconcileJudgement | null, lines: readonly Line[]): ReadbackRow[] {
  if (!judged || judged.verdict.bucket !== '已保存' || lines.length === 0) return [];
  const previewLine = new Map((record.preview?.lines ?? []).map((line) => [line.lineId, line]));
  const receipt = new Map((record.preview?.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding.receiptNumber]));
  const perLine = new Map<number, string[]>();
  for (const reason of judged.verdict.reasons) {
    const no = Number(LINE_REASON.exec(reason)?.[1] ?? 0);
    if (no > 0) perLine.set(no, [...(perLine.get(no) ?? []), reason]);
  }
  return lines.map((line, index) => {
    const approved = previewLine.get(line.lineId);
    const values: Record<(typeof READBACK_FIELD_LABELS)[number], string | null> = {
      申请报销金额: line.grossAmount,
      项目: line.projectName,
      费用项目: line.expenseItemName,
      开始日期: line.date,
      结束日期: line.endDate ?? line.date,
      费用金额: approved?.netAmount ?? line.netAmount,
      税额: approved?.taxAmount ?? line.taxAmount,
      收票单号: receipt.get(line.voucherMaterialId) ?? null,
      发票类型: approved?.invoiceType ?? line.invoiceType,
    };
    const reasons = judged.saved ? [] : (perLine.get(index + 1) ?? []);
    const matched = judged.saved || reasons.length === 0;
    const fields: ReadbackField[] = READBACK_FIELD_LABELS.map((label) => ({ label, local: values[label], erp: matched ? values[label] : null, matched }));
    return { no: line.no, description: line.description, matched, fields, reasons };
  });
}

// The server-side sentence of each 对账中断点.
const BUCKET_BANNER: Readonly<Record<ReconcileBucket, (billNo: string | null) => string>> = {
  未知: () => '对账没有读清报销系统里这张单据的状态。请在报销系统里打开这次的报销单查看，再点「重新对账」；也可以转人工。',
  '未保存·导入前': () => '报销系统里还没有导入发票，也还没有写明细，发票没有被报销系统占用。',
  // Two readings share this bucket. With no 单据编号 nothing was persisted: the invoices are held by the unsaved
  // bill and the import can be replayed onto a fresh one (ADR-0026, ADR-0027). With one, the employee saved, and
  // re-importing would act on a bill that exists.
  '未保存·已导入未写明细': (billNo) => (billNo
    ? `报销系统里已有单据 ${billNo}，发票已导入、明细还没有写。只能转人工处理。`
    : '发票已导入报销系统、明细还没有写。占着这些发票的是刚才那张没有保存的单据，不是被报销掉了：重新去报销会重开一张单据再导一次，报销系统会覆盖掉原来的收票记录。那张没保存的单据没有单据编号，关掉也不会留下单据，不需要你去清理。'),
  // Unreachable while the strict per-line match holds: that pair promotes to the hand-over terminal (#241), which
  // renders HANDOVER_COMPLETED_NOTICE instead of a banner. The entry survives because BUCKET_BANNER is exhaustive
  // over ReconcileBucket, and because the bucket is still reachable without the match (a reconcile that read a
  // ready-to-save form it cannot prove line by line), which is the case this sentence is written for.
  '未保存·就绪待保存': () => '明细已写好，收票与明细合计一致，还没有保存。应用不会替你保存；请在报销系统里逐行核对后自己点「保存」，或转人工。',
  已保存: (billNo) => `报销系统里已有草稿${billNo ? ` ${billNo}` : ''}，但不能证明它的合计与这次确认的明细一致。`,
  不自洽: () => '报销系统里这张单据前后对不上。只能转人工处理。',
};

// 对账 found no 费用报销单 open at all. Said in place of the generic 未知 sentence, which only tells the employee to
// go open the bill: there may be no bill left to open, and this reading has its own exit.
const NO_FORM_OPEN_BANNER = '报销系统里现在没有打开任何费用报销单。没有保存过的单据一关就不存在了，也不需要你去清理；'
  + '这次导入的发票还占在那张单上，重新去报销会重开一张新单再导一次，报销系统会覆盖掉原来的收票记录。'
  + '如果你自己已经把这次的单据保存过了，请不要重新去报销，改为转人工。';

// Why the latest reconcile run has no read-back, as the page says it.
function runNotice(result: ResultEvent | null): string | null {
  if (!result || result.status === 'read') return null;
  if (result.status === 'waiting_login') return '对账前请先在为这次报销打开的报销系统标签页里登录，然后再对账。';
  return `这次对账没有读到报销系统，可以再对账一次。原因：${result.message ?? result.code ?? ''}`;
}

/** ERP's own words and the cropped screenshot of the write that stopped (#32), as the page shows them. */
function captureOf(record: ErpRecord, taskId: string): ErpCapture | null {
  const capture = record.result?.capture;
  if (!capture || (capture.erpText.length === 0 && !capture.screenshot)) return null;
  return { erpText: capture.erpText, screenshotUrl: capture.screenshot ? `/api/tasks/${taskId}/erp-capture` : null };
}

/**
 * 对账 (reconcile) after ERP 写入结果未知, and the terminal 转人工. The dispositions on offer are the task policy's
 * (`reconcileActionsOf`); this view only words them.
 */
export function reconcileView(record: ErpRecord, taskId: string, lifecycle: TaskLifecycle, lines: readonly Line[] = []): Reconcile | null {
  const judged = record.reconcile?.judged ?? null;
  const capture = captureOf(record, taskId);
  const draftNo = judged?.billNo ?? record.result?.billNo ?? null;
  const fillReasons = (record.result?.message ?? '').split('；').filter(Boolean);
  const rows = reconcileRows(record, judged, lines);
  if (lifecycle === 'handed_off' && record.handOff) {
    return {
      status: 'handed_off',
      bucket: (record.handOff.bucket as ReconcileBucket | null) ?? null,
      action: '转人工',
      actionCode: 'hand_off',
      allowedActions: [],
      humanReview: true,
      banner: HUMAN_REVIEW_NOTICE,
      draftNo,
      rows,
      reasons: judged?.verdict.reasons ?? fillReasons,
      capture,
    };
  }
  if (record.facts?.phase !== 'unknown') return null;
  const base = { draftNo, rows, capture };
  if (record.facts.reconciling) {
    return { ...base, status: 'pending', bucket: judged?.verdict.bucket ?? null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: '正在只读核对报销系统里的这张报销单，不会写入。', reasons: judged?.verdict.reasons ?? fillReasons };
  }
  const notice = runNotice(record.reconcile?.result ?? null);
  const allowedActions = reconcileActionsOf(record);
  if (!judged) {
    return {
      ...base,
      status: 'pending',
      bucket: null,
      action: null,
      actionCode: null,
      allowedActions,
      humanReview: false,
      banner: notice ?? '写入报销系统的结果不确定：应用已停止写入，不会重放。请先在报销系统里查看这张报销单，再点「开始对账」只读核对；也可以直接转人工。',
      reasons: fillReasons,
    };
  }
  // 重新去报销 (ADR-0027): the exit out of an import that was never saved, when the policy offers it (see
  // `reconcileActionsOf` for when and why).
  const noForm = judged.noForm && judged.verdict.bucket === '未知';
  // Offering the recovery is not a 转人工 outcome, whatever the classifier suggested for the bucket: the disposition
  // is 原地等待 (the code says which of its two exits is suggested) and humanReview is false.
  if (allowedActions.includes('refill')) {
    return {
      ...base,
      status: 'pending',
      bucket: judged.verdict.bucket,
      action: RECONCILE_ACTION_LABELS.refill,
      actionCode: 'refill',
      allowedActions,
      humanReview: false,
      banner: notice ?? (noForm ? NO_FORM_OPEN_BANNER : BUCKET_BANNER[judged.verdict.bucket](judged.billNo)),
      reasons: judged.verdict.reasons,
    };
  }
  const handOffOnly = judged.verdict.action === '转人工';
  return {
    ...base,
    status: handOffOnly ? 'pending' : 'waiting',
    bucket: judged.verdict.bucket,
    action: judged.verdict.action,
    actionCode: handOffOnly ? 'hand_off' : 'wait',
    allowedActions,
    humanReview: handOffOnly,
    banner: notice ?? BUCKET_BANNER[judged.verdict.bucket](judged.billNo),
    reasons: judged.verdict.reasons,
  };
}

const VERDICT_REASON: Readonly<Record<string, (kind: string, code: string, expected: string, erpName: string | null) => string>> = {
  missing: (kind, code, expected) => `${kind} ${code}「${expected}」在报销系统里查不到`,
  name_mismatch: (kind, code, expected, erpName) => `${kind} ${code} 在报销系统里的名称是「${erpName ?? ''}」，与本地的「${expected}」不一致`,
  unusable: (kind, code, expected) => `${kind} ${code}「${expected}」在报销系统里未审核或已禁用，不能引用`,
  ambiguous: (kind, code) => `${kind}号 ${code} 在报销系统里对应多条记录，不能确定是哪一个`,
};

/** 报销信息核对 problems of a catalog mismatch not yet answered by a new submission. */
export function catalogView(record: ErpRecord): Catalog | null {
  if (!record.facts?.reassign) return null;
  const mismatch = [...record.events].reverse().find((event) => event.type === 'catalog_mismatch');
  const problems = mismatch?.type === 'catalog_mismatch' ? mismatch.problems : [];
  return {
    status: 'mismatch',
    problems: problems.map((problem) => {
      const kind = problem.kind === 'project' ? '项目' : '费用项目';
      const reason = (VERDICT_REASON[problem.verdict] ?? VERDICT_REASON['missing']!)(kind, problem.code, problem.expectedName, problem.erpName);
      return { subject: `${problem.kind === 'project' ? '项目号' : '费用项目'} ${problem.code}`, reference: null, reason, resolver: '要你处理' as const };
    }),
  };
}
