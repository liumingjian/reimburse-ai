// The snapshot's `erp`, `readback`, `reconcile` and `catalog` sections, worded from the task's ERP record
// (`erp/fill-state.ts`). Which actions are on offer is the task policy's (`task-policy.ts`); these views only word them.

import { ERP_PROGRESS_STEPS, HUMAN_REVIEW_NOTICE, READBACK_FIELD_LABELS, RECONCILE_ACTION_LABELS, RECONCILE_UNJUDGED_BANNER, type Catalog, type Erp, type ErpCapture, type ErpProgressStage, type ErpStep, type Line, type Readback, type ReadbackField, type ReadbackRow, type Reconcile, type ReconcileBucket } from '@baox/contract';
import type { ResultEvent } from '@baox/erp-executor/protocol';
import type { LegacyTaskTable, TaskLifecycle } from '../db/schema';
import type { ErpRecord, ReconcileJudgement } from '../erp/fill-state';
import { EXTENSION_CONNECTION_LOST_CODE, EXTENSION_OFFLINE_CODE } from '../extension/channel';
import { erpActionsOf, reconcileActionsOf, reconcileReading } from '../task-policy';

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
    if (phase === 'handed_over' || phase === 'drafted' || phase === 'saved') status = 'done';
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
    // ERP 草稿已交接: the draft has no 单据编号 until the employee saves it.
    case 'drafted':
      return { ...idle, ...readState, status: 'done', outcome: 'drafted', draftNo: null };
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
  if (phase !== 'handed_over' && phase !== 'drafted' && phase !== 'saved') return EMPTY_READBACK;
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
 * Reconcile (对账) after the ERP write result is unknown (写入结果未知), and the terminal hand-off (转人工). The
 * dispositions on offer are the task policy's (`reconcileActionsOf`); this view only words them.
 */
export function reconcileView(record: ErpRecord, taskId: string, lifecycle: TaskLifecycle, lines: readonly Line[] = []): Reconcile | null {
  const { judged, draftNo, noForm } = reconcileReading(record);
  const capture = captureOf(record, taskId);
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
  const allowedActions = reconcileActionsOf(record.facts, record);
  if (!judged) {
    return {
      ...base,
      status: 'pending',
      bucket: null,
      action: null,
      actionCode: null,
      allowedActions,
      humanReview: false,
      banner: notice ?? RECONCILE_UNJUDGED_BANNER,
      reasons: fillReasons,
    };
  }
  // 重新去报销 (ADR-0027): the exit out of an import that was never saved, when the policy offers it (see
  // `reconcileActionsOf` for when and why).
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


// An imported legacy task (#195) shows only its stored ERP facts: the saved draft's number, or the 转人工 bucket.
export function legacyErpView(legacy: LegacyTaskTable): Erp {
  const saved = legacy.outcome === 'draft_handed_over';
  return {
    status: saved ? 'done' : 'idle',
    steps: [],
    currentStage: saved ? 'handover' : null,
    externalWait: 'none',
    outcome: saved ? 'saved' : 'none',
    allowedActions: saved ? erpActionsOf('saved') : [],
    draftNo: legacy.bill_no,
    abortReason: null,
    loginNotice: null,
    erpAccount: null,
  };
}

export function legacyReconcileView(legacy: LegacyTaskTable): Reconcile | null {
  if (legacy.outcome !== 'handed_off') return null;
  return { status: 'handed_off', bucket: legacy.reconcile_bucket as ReconcileBucket | null, action: '转人工', actionCode: null, allowedActions: [], humanReview: true, banner: HUMAN_REVIEW_NOTICE, draftNo: legacy.bill_no, rows: [], reasons: [], capture: null };
}
