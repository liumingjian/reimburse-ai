// The 去报销 (fill ERP) state of a task, derived from stored facts (ADR-0014): the latest `erp_job`, its persisted
// executor events, its cancel, and the task's `erp_attempt` rows. Nothing about the phase is stored. The views below
// turn the record into the snapshot's `erp`, `readback`, `reconcile` and `catalog` sections.

import { HUMAN_REVIEW_NOTICE, READBACK_FIELD_LABELS, RECONCILE_ACTION_LABELS, type Catalog, type Erp, type ErpCapture, type ErpStep, type Line, type Readback, type ReadbackField, type ReadbackRow, type Reconcile, type ReconcileBucket } from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from '../db/database';
import type { ErpHandOffTable, ErpJobTable, TaskLifecycle } from '../db/schema';
import type { ErpFacts, ErpPhase } from '../projection';
import type { FrozenJob } from './fill-plan';
import { ExecutorEventSchema, type ApprovedPreview, type ErpAccount, type ExecutorEvent, type Preconditions, type ReadbackEvent, type ResultEvent } from './protocol';
import type { ReconcileVerdict } from './reconcile';
import { reconcileFromEvents } from './reconcile-job';

// One judged reconcile read-back: the verdict (after the form-instance / target check), the bill number it read, and
// whether it proves the draft saved exactly as approved (已保存, identity holds, strict per-line match passed).
export type ReconcileJudgement = { verdict: ReconcileVerdict; billNo: string | null; saved: boolean };

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
  const saved = elsewhere.length === 0 && preview !== null && verdict.bucket === '已保存' && verdict.action === '原地等待' && derived.readings.taskMatch?.ok === true;
  return { verdict, billNo: read.billNo.readable ? read.billNo.value : null, saved };
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
  // ERP 草稿已交接: done, not a hand-off.
  if (phase === 'unknown' && reconcile?.judged?.saved) {
    phase = 'saved';
    result = { type: 'result', status: 'saved', code: 'reconciled', message: null, billNo: reconcile.judged.billNo, capture: null };
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

// The progress list of the ERP page. Executor steps map onto these; `compatibility` belongs to opening the form, and
// the executor's `readback` step is the receipt read-back after import.
const DISPLAY_STEPS: ReadonlyArray<{ key: string; title: string; description: string; from: readonly string[] }> = [
  { key: 'chromium', title: '启动浏览器', description: '打开报销专用浏览器窗口（独立的用户数据目录，不碰你日常用的浏览器）。', from: ['chromium'] },
  { key: 'login', title: '登录', description: '在专用浏览器窗口里用本人账号登录报销系统。应用不会替你输入账号密码。', from: ['login'] },
  { key: 'catalog', title: '报销信息核对', description: '只读核对项目与费用项目：在报销系统里存在、名称一致、已审核且未禁用。', from: ['catalog'] },
  { key: 'navigate', title: '打开空白报销单', description: '打开费用报销单新增页，核对报销系统版本，确认是唯一一张空白单据。', from: ['navigate', 'compatibility'] },
  { key: 'import', title: '导入发票', description: '在发票助手里选择「不生成费用明细」，导入这次的发票。', from: ['import'] },
  { key: 'receipt', title: '收票回读', description: '逐票回读收票单号、发票号码、不含税金额、税额与价税合计。', from: ['readback'] },
  { key: 'fill', title: '填写明细', description: '按统一业务序号逐行写入明细，每个值写入后从单元格回读。', from: ['fill'] },
  // `save` is the step name fill jobs emitted before ADR-0028; `handover` is what they emit now.
  { key: 'save', title: '保存草稿', description: '只保存一次草稿，不提交审批；保存后逐行严格回读。', from: ['save', 'handover'] },
];

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

// The executor's code for "报销信息核对 could not read the catalog" (`executor/job.ts`). Nothing was written and
// nothing about the claim is wrong, so it gets its own sentence rather than the generic abort one.
const CATALOG_QUERY_FAILED = 'catalog_query_failed';
const CATALOG_QUERY_FAILED_REASON = '没能在报销系统里查到项目与费用项目，报销信息核对没有做完。报销系统没有被改动，明细也不用改：等报销系统能正常查询后再去报销。原因：';

const LOGIN_NOT_DETECTED = '还没有检测到登录。请在报销专用浏览器窗口里登录报销系统（登录页上显示的上次账号不算已登录），完成后再点一次「我已登录，继续」。';

export function erpView(record: ErpRecord): Erp {
  const idle: Erp = { status: 'idle', steps: [], draftNo: null, abortReason: null, loginNotice: null, erpAccount: record.erpAccount };
  const facts = record.facts;
  if (!facts) return idle;
  const reason = record.result?.message ?? record.result?.code ?? '';
  switch (facts.phase) {
    case 'running':
      return { ...idle, status: 'running', steps: stepsOf(record) };
    case 'waiting_login':
      return { ...idle, status: 'waiting_login', steps: stepsOf(record), loginNotice: facts.trigger === 'confirm_login' ? LOGIN_NOT_DETECTED : null };
    case 'aborted':
      return {
        ...idle,
        abortReason:
          record.result?.code === CATALOG_QUERY_FAILED
            ? `${CATALOG_QUERY_FAILED_REASON}${reason}`
            : `上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：${reason}`,
      };
    case 'handed_over':
      // ERP 单据已交接: nothing was saved, so there is no 单据编号 (bill number) to report.
      return { ...idle, status: 'done', steps: stepsOf(record), draftNo: null };
    case 'saved':
      return { ...idle, status: 'done', steps: stepsOf(record), draftNo: record.result?.billNo ?? null };
    case 'unknown':
      return { ...idle, status: 'aborted', steps: stepsOf(record), draftNo: record.result?.billNo ?? null, abortReason: `写入报销系统的结果不确定，应用已停止写入，不会重放。原因：${reason}` };
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
  '未保存·导入前': () => '报销系统里还没有导入发票，也没有保存草稿，发票没有被报销系统占用。',
  // Two readings share this bucket. With no 单据编号 nothing was persisted: the invoices are held by the unsaved
  // bill and the import can be replayed onto a fresh one (ADR-0026, ADR-0027). With one, the employee saved, and
  // re-importing would act on a bill that exists.
  '未保存·已导入未写明细': (billNo) => (billNo
    ? `报销系统里已有单据 ${billNo}，发票已导入、明细还没有写。只能转人工处理。`
    : '发票已导入报销系统、明细还没有写。占着这些发票的是刚才那张没有保存的单据，不是被报销掉了：重新去报销会重开一张单据再导一次，报销系统会覆盖掉原来的收票记录。那张没保存的单据没有单据编号，关掉也不会留下单据，不需要你去清理。'),
  '未保存·就绪待保存': () => '明细已写好，收票与明细合计一致，还没有保存。应用不会替你保存；请在报销系统里核对，或转人工。',
  已保存: (billNo) => `报销系统里已有草稿${billNo ? ` ${billNo}` : ''}，但不能证明它与这次确认的明细逐行一致。`,
  不自洽: () => '报销系统里这张单据前后对不上。只能转人工处理。',
};

// Why the latest reconcile run has no read-back, as the page says it.
function runNotice(result: ResultEvent | null): string | null {
  if (!result || result.status === 'read') return null;
  if (result.status === 'waiting_login') return '对账前请先在报销专用浏览器窗口里登录报销系统，然后再对账。';
  return `这次对账没有读到报销系统，可以再对账一次。原因：${result.message ?? result.code ?? ''}`;
}

/** ERP's own words and the cropped screenshot of the write that stopped (#32), as the page shows them. */
function captureOf(record: ErpRecord, taskId: string): ErpCapture | null {
  const capture = record.result?.capture;
  if (!capture || (capture.erpText.length === 0 && !capture.screenshot)) return null;
  return { erpText: capture.erpText, screenshotUrl: capture.screenshot ? `/api/tasks/${taskId}/erp-capture` : null };
}

/**
 * 对账 (reconcile) after ERP 写入结果未知, and the terminal 转人工. Before any read and after a 原地等待 verdict the user
 * may reconcile (read-only) again or hand off; a 转人工 verdict (incl. 已导入未写明细) allows only the hand-off.
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
  if (!judged) {
    return {
      ...base,
      status: 'pending',
      bucket: null,
      action: null,
      actionCode: null,
      allowedActions: ['wait', 'hand_off'],
      humanReview: false,
      banner: notice ?? '写入报销系统的结果不确定：应用已停止写入，不会重放。请先在报销系统里查看这张报销单，再点「开始对账」只读核对；也可以直接转人工。',
      reasons: fillReasons,
    };
  }
  // 重新去报销 (ADR-0027): the exit out of an import that was never saved. The gate is observational and lives
  // here, in the one view that decides allowed actions, because the reading it needs is the one this view already
  // holds. It is not gated on the attempt log: baox never saves (ADR-0028), so "this job started no save attempt"
  // is vacuously true and carries no information. A 单据编号 means the employee saved and re-importing would act on
  // a bill that exists, so that reading keeps 转人工. An unreadable 单据编号 cell also reads as null here, and that
  // is the conservative side of the reading only because the bucket itself already required 新增 mode with no bill.
  const refillable = judged.verdict.bucket === '未保存·已导入未写明细' && judged.billNo === null;
  // Offering the recovery is not a 转人工 outcome, whatever the classifier suggested for the bucket: the disposition
  // is 原地等待 (the code says which of its two exits is suggested) and humanReview is false.
  if (refillable) {
    return {
      ...base,
      status: 'pending',
      bucket: judged.verdict.bucket,
      action: RECONCILE_ACTION_LABELS.refill,
      actionCode: 'refill',
      allowedActions: ['refill', 'hand_off'],
      humanReview: false,
      banner: notice ?? BUCKET_BANNER[judged.verdict.bucket](judged.billNo),
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
    allowedActions: handOffOnly ? ['hand_off'] : ['wait', 'hand_off'],
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
