import {
  ERP_PROGRESS_STEPS,
  HUMAN_REVIEW_NOTICE,
  READBACK_FIELD_LABELS,
  RECONCILE_ACTION_LABELS,
  RECONCILE_UNJUDGED_BANNER,
  type Erp,
  type ErpStep,
  type Line,
  type Readback,
  type ReadbackField,
  type ReadbackRow,
  type Reconcile,
  type ReconcileActionCode,
  type ReconcileBucket,
  type TaskSnapshot,
} from '@baox/contract';

// Mock execution reuses the contract's factual stage list. Its timers only advance the simulated server; no duration
// or percentage is presented as ERP progress.
export const ERP_STEP_DEFS: ReadonlyArray<Pick<ErpStep, 'key' | 'title' | 'description'>> = ERP_PROGRESS_STEPS;

export const ERP_STEP_INDEX = { chromium: 0, login: 1, catalog: 2, navigate: 3, import: 4, receipt: 5, fill: 6, handover: 7 } as const;

export function erpStageAt(active: number): Erp['currentStage'] {
  return (ERP_PROGRESS_STEPS[active]?.key ?? null) as Erp['currentStage'];
}

// 第 active 步处于 status，之前的都已完成，之后的待开始；active 超出范围即全部完成。
export function erpSteps(active: number, status: ErpStep['status'] = 'running'): ErpStep[] {
  return ERP_STEP_DEFS.map((def, index) => ({
    ...def,
    status: index < active ? 'done' : index === active ? status : 'todo',
  }));
}

export function idleErp(): Erp {
  return {
    status: 'idle',
    steps: [],
    currentStage: null,
    externalWait: 'none',
    outcome: 'none',
    allowedActions: [],
    draftNo: null,
    abortReason: null,
    loginNotice: null,
    rerunNotice: null,
    erpAccount: null,
    review: null,
  };
}

export function erpRunning(active: number = ERP_STEP_INDEX.chromium): Erp {
  return {
    ...idleErp(),
    status: 'running',
    steps: erpSteps(active),
    currentStage: erpStageAt(active),
    externalWait: 'erp_response',
    allowedActions: ['refresh'],
  };
}

// 「去报销」之后浏览器已启动、登录步等待（`?seed=erp` 的状态）。
export function erpWaitingLogin(): Erp {
  return {
    ...erpRunning(ERP_STEP_INDEX.login),
    status: 'waiting_login',
    steps: erpSteps(ERP_STEP_INDEX.login, 'waiting'),
    currentStage: 'login',
    externalWait: 'employee_login',
    allowedActions: ['refresh', 'confirm_login', 'cancel'],
  };
}

// 写入时登录的报销系统账号与账套（虚构）：按尝试记录，完成页显示，从不与应用账号比对。
export const MOCK_ERP_ACCOUNT = { displayName: '林颂宜', account: 'lin.songyi', tenant: '安图特科技' } as const;

export function loginNotDetected(attempt: number): string {
  return `还没有检测到登录（第 ${attempt} 次检测）。请确认已在为这次报销打开的报销系统标签页里登录本人账号；登录页上显示的上次账号不算已登录。登录后再点一次「我已登录，继续」。`;
}

// Why the write job stopped (the job result's message; the server shows it as reconcile.reasons before the first
// reconciliation), and the abort reason the server words around it (server/src/task-snapshot/erp.ts erpView).
// The handover stop is the save whose result was never read back; the read-back stop is the strict read-back's total
// check (server/src/erp/readback.ts, which says ERP where employee copy says reimbursement system (报销系统)), here
// for T1's No.6 read back as 74.00 instead of 47.00.
export const HANDOVER_STOP_REASON = '保存后没有读到报销系统的结果';
export const MISMATCH_STOP_REASON = '报销系统明细「申请报销金额」合计 3999.59 与任务合计 3972.59 不一致';
const uncertainAbortReason = (reason: string) => `写入报销系统的结果不确定，应用已停止写入，不会重放。原因：${reason}`;
export const HANDOVER_ABORT_REASON = uncertainAbortReason(HANDOVER_STOP_REASON);
export const MISMATCH_ABORT_REASON = uncertainAbortReason(MISMATCH_STOP_REASON);
// What the ERP page said when the save went unanswered (captured with the stop, shown on the reconcile page).
export const HANDOVER_PAGE_TEXT = '保存未完成：报销系统没有返回处理结果。';
// A stop before anything was written (compatibility_mismatch, worded as the executor does): the ERP was not changed,
// and 去报销 (claim) can simply be started again.
export const BEFORE_WRITE_STOP_REASON = '报销系统的版本与上次核对时不一致，没有继续：期望 8.2.830.9 / ER_ExpReimbursement，实际 8.3.101.2 / ER_ExpReimbursement。报销系统没有被改动。';
export const BEFORE_WRITE_ABORT_REASON = `上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：${BEFORE_WRITE_STOP_REASON}`;

// readback-mismatch 故障：No.6（出租车 47.00）的申请报销金额在报销系统里读回 74.00。
export const MISMATCH = { no: 6, erp: '74.00' } as const;

function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function money(value: number): string {
  return (value / 100).toFixed(2);
}

// 收票单号（虚构）：导入后报销系统给每张发票一个收票单，按发票短标签编号。
export function receiptNumberOf(invoiceLabel: string): string {
  const n = Number(invoiceLabel.replace(/\D/g, '')) || 0;
  return `SPD20260911${String(n).padStart(4, '0')}`;
}

export function mismatchReason(no: number): string {
  return `任务第 ${no} 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的报销系统明细；金额相等不能代替逐行一致`;
}

type FieldValues = Readonly<Record<(typeof READBACK_FIELD_LABELS)[number], string | null>>;

// 按 9 个字段逐项比对：erpOverrides 里给出的字段取报销系统里读到的不同值，其余与本地相同。
function readbackRow(no: number, description: string, local: FieldValues, erpOverrides: Partial<FieldValues> = {}): ReadbackRow {
  const fields: ReadbackField[] = READBACK_FIELD_LABELS.map((label) => {
    const erp = label in erpOverrides ? (erpOverrides[label] ?? null) : local[label];
    return { label, local: local[label], erp, matched: erp !== null && erp === local[label] };
  });
  const matched = fields.every((field) => field.matched);
  return { no, description, matched, fields, reasons: matched ? [] : [mismatchReason(no)] };
}

function lineFields(line: Line): FieldValues {
  return {
    申请报销金额: line.grossAmount,
    项目: line.projectName,
    费用项目: line.expenseItemName,
    开始日期: line.date,
    结束日期: line.endDate ?? line.date,
    费用金额: line.netAmount,
    税额: line.taxAmount,
    收票单号: receiptNumberOf(line.invoiceLabel),
    发票类型: line.invoiceType,
  };
}

export function readbackRows(lines: readonly Line[], mismatch: { no: number; erp: string } | null = null): ReadbackRow[] {
  return lines.map((line) =>
    readbackRow(line.no, line.description, lineFields(line), mismatch && mismatch.no === line.no ? { 申请报销金额: mismatch.erp } : {}),
  );
}

function grossOf(row: ReadbackRow, side: 'local' | 'erp'): string | null {
  return row.fields.find((field) => field.label === '申请报销金额')?.[side] ?? null;
}

// 回读结果：一致与否、摘要与两边申请报销金额合计都由服务端给出。
export function readbackOf(rows: readonly ReadbackRow[]): Readback {
  const matched = rows.filter((row) => row.matched).length;
  const mismatched = rows.length - matched;
  const local = rows.reduce((sum, row) => sum + cents(grossOf(row, 'local') ?? '0'), 0);
  const erp = rows.reduce((sum, row) => sum + cents(grossOf(row, 'erp') ?? '0'), 0);
  return {
    status: mismatched === 0 ? 'matched' : 'mismatched',
    rows: [...rows],
    summary: mismatched === 0 ? `明细 ${matched}/${rows.length} 一致` : `明细 ${matched}/${rows.length} 一致，${mismatched} 行不一致`,
    localTotal: money(local),
    erpTotal: money(erp),
  };
}

export function emptyReadback(): Readback {
  return { status: 'none', rows: [], summary: null, localTotal: null, erpTotal: null };
}

export function emptyReconcile(): Reconcile {
  return { status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null, draftNo: null, rows: [], reasons: [], capture: null };
}

// 对账判定（内核 classifyReconciliation 的对应）：bucket 决定建议的处置；「已保存」还要看收票与明细合计是否相等、
// 严格逐行是否一致。action 是建议，allowedActions 是能做的：建议原地等待时也一直可以转人工（服务端
// task-snapshot/erp.ts reconcileView 同此），建议转人工时只能转人工（human_review，不再给「重新对账」）。
export function reconcileVerdict(
  bucket: ReconcileBucket,
  savedConsistent = true,
  billNo: string | null = null,
): Pick<Reconcile, 'bucket' | 'action' | 'actionCode' | 'allowedActions' | 'humanReview'> {
  // 未保存·已导入未写明细：什么都没有落库，出路是「重新去报销」（重开一张单据再走一遍）和「转人工」，不是转人工的结果。
  // 这条出路和服务端（task-snapshot/erp.ts reconcileView）一样看读数：报销系统里一旦有了单据编号，就说明员工自己保存过，
  // 重新导入会动到一张真实存在的单据，只能转人工。
  if (bucket === '未保存·已导入未写明细' && billNo === null) {
    return { bucket, action: RECONCILE_ACTION_LABELS.refill, actionCode: 'refill', allowedActions: ['refill', 'hand_off'], humanReview: false };
  }
  const handOff = bucket === '不自洽' || bucket === '未保存·已导入未写明细' || (bucket === '已保存' && !savedConsistent);
  const code: ReconcileActionCode = handOff ? 'hand_off' : 'wait';
  return { bucket, action: RECONCILE_ACTION_LABELS[code], actionCode: code, allowedActions: handOff ? ['hand_off'] : ['wait', 'hand_off'], humanReview: handOff };
}

// 写入完成：严格回读逐行一致、单据已交接，阶段推到 done。
// 交接时单据还没有保存，所以没有单据编号（服务端 fill-state.ts 的 handed_over 一样给 null）。只有员工自己保存过、
// 再对一次账读到「已保存」，才会有编号，那时由调用方把编号传进来。
export function applyErpDone(snapshot: TaskSnapshot, draftNo: string | null = null): void {
  snapshot.erp = {
    ...erpRunning(ERP_STEP_INDEX.handover),
    status: 'done',
    steps: erpSteps(ERP_STEP_DEFS.length),
    currentStage: 'handover',
    externalWait: 'none',
    outcome: draftNo === null ? 'filled' : 'saved',
    draftNo,
    abortReason: null,
    allowedActions: ['refresh'],
    erpAccount: { ...MOCK_ERP_ACCOUNT },
  };
  snapshot.readback = readbackOf(readbackRows(snapshot.lines));
  snapshot.stage = 'done';
  snapshot.step = { kind: 'none', stepToken: `tok-${snapshot.task.taskId}-done` };
}

// 写入停在严格回读不一致之后、第一次对账读到的结果：报销系统里有一张（员工保存过的）草稿，与本地确认逐行不一致
// （已保存 + 逐行不一致 ⇒ 转人工，human_review）。仍停在对账：done 只留给「已保存且逐行一致」，
// 服务端也从不把它投影成 done（fill-state.ts 只在 phase saved 时给 done）。对账页显示差异行，只接受「转人工」。
export function applyReadbackMismatch(snapshot: TaskSnapshot, draftNo: string): void {
  const readback = readbackOf(readbackRows(snapshot.lines, MISMATCH));
  const bad = readback.rows.filter((row) => !row.matched);
  snapshot.erp = { ...snapshot.erp, draftNo };
  snapshot.readback = readback;
  snapshot.reconcile = {
    status: 'pending',
    ...reconcileVerdict('已保存', false),
    banner: `报销系统中存在草稿 ${draftNo}，${readback.rows.length} 行明细中 ${readback.rows.length - bad.length} 行一致，${bad.length} 行不一致。`,
    draftNo,
    rows: readback.rows,
    reasons: [],
    capture: null,
  };
  snapshot.stage = 'reconcile';
  snapshot.step = { kind: 'reconcile', stepToken: `tok-${snapshot.task.taskId}-reconcile-judged` };
}

// 写入结果不确定、还没对过账（服务端 reconcileView 的 !judged 分支）：对账中断点尚未判定，没有建议的处置；
// 可以「开始对账」（只读核对）或直接转人工。reasons 是写入作业停下时给出的原因。
export function unjudgedReconcile(reasons: readonly string[]): Reconcile {
  return {
    ...emptyReconcile(),
    status: 'pending',
    allowedActions: ['wait', 'hand_off'],
    banner: RECONCILE_UNJUDGED_BANNER,
    reasons: [...reasons],
  };
}

// 写入在 stage 这一步停下、结果不确定：停在对账，等第一次对账。
function applyUncertainStop(snapshot: TaskSnapshot, stage: 'fill' | 'handover', abortReason: string, reason: string, capture: Reconcile['capture'] = null): void {
  snapshot.erp = {
    ...erpRunning(ERP_STEP_INDEX[stage]),
    status: 'aborted',
    steps: erpSteps(ERP_STEP_INDEX[stage], 'failed'),
    currentStage: stage,
    externalWait: 'none',
    outcome: 'none',
    abortReason,
    allowedActions: ['refresh'],
    erpAccount: { ...MOCK_ERP_ACCOUNT },
  };
  snapshot.readback = emptyReadback();
  snapshot.reconcile = { ...unjudgedReconcile([reason]), capture };
  snapshot.stage = 'reconcile';
  snapshot.step = { kind: 'reconcile', stepToken: `tok-${snapshot.task.taskId}-reconcile` };
}

// 严格回读不一致（`?fault=readback-mismatch`）：填写明细后的回读对不上，写入就此停下，结果不确定（服务端同此）。
export function applyReadbackStop(snapshot: TaskSnapshot): void {
  applyUncertainStop(snapshot, 'fill', MISMATCH_ABORT_REASON, MISMATCH_STOP_REASON);
}

// 写入前就停下：阶段退回「去打印 / 去报销」，状态回到 idle 而 abortReason 有值（见合同 ErpSchema），
// 所以这不是 aborted。填报页要认得这一种停下，否则用户会被留在一个已经关上的页面上。
// 没有一次写入尝试走到报销系统，所以也没有记下报销系统账号（服务端同此）。
export function applyStopBeforeWrite(snapshot: TaskSnapshot): void {
  snapshot.stage = 'actions';
  snapshot.erp = {
    ...idleErp(),
    steps: erpSteps(ERP_STEP_INDEX.navigate, 'failed'),
    currentStage: 'navigate',
    abortReason: BEFORE_WRITE_ABORT_REASON,
    allowedActions: ['refresh'],
  };
}

// 交接步中止（`?fault=erp-write-aborted`）：写入结果未知，停在对账等第一次对账。
export function applyAbortAtHandover(snapshot: TaskSnapshot): void {
  // The mock has no ERP screenshot to serve, only the captured text.
  applyUncertainStop(snapshot, 'handover', HANDOVER_ABORT_REASON, HANDOVER_STOP_REASON, { erpText: [HANDOVER_PAGE_TEXT], screenshotUrl: null });
}

// T2（对账中）：原型 §1.10 的五行，No.3 的申请报销金额不一致（182.00 / 128.00）；合计 1264.00。
function t2Row(no: number, description: string, values: Omit<FieldValues, '项目' | '发票类型'>, erpGross?: string): ReadbackRow {
  const local: FieldValues = { ...values, 项目: '华东客户交付', 发票类型: '电子发票（普通发票）' };
  return readbackRow(no, description, local, erpGross ? { 申请报销金额: erpGross } : {});
}

export const T2_ROWS: readonly ReadbackRow[] = [
  t2Row(1, 'G6512 上海虹桥 → 深圳北', { 申请报销金额: '553.00', 费用项目: '长途交通费', 开始日期: '2026-07-14', 结束日期: '2026-07-14', 费用金额: '507.34', 税额: '45.66', 收票单号: 'SPD202607180001' }),
  t2Row(2, '亚朵酒店 2 晚', { 申请报销金额: '396.00', 费用项目: '住宿费', 开始日期: '2026-07-14', 结束日期: '2026-07-16', 费用金额: '373.58', 税额: '22.42', 收票单号: 'SPD202607180002' }),
  t2Row(3, '滴滴 · 深圳北 → 科技园', { 申请报销金额: '182.00', 费用项目: '外地市内交通费', 开始日期: '2026-07-14', 结束日期: '2026-07-14', 费用金额: '176.70', 税额: '5.30', 收票单号: 'SPD202607180003' }, '128.00'),
  t2Row(4, '出租车 · 科技园 → 宝安机场', { 申请报销金额: '63.00', 费用项目: '外地市内交通费', 开始日期: '2026-07-16', 结束日期: '2026-07-16', 费用金额: '61.17', 税额: '1.83', 收票单号: 'SPD202607180004' }),
  t2Row(5, 'G6513 深圳北 → 上海虹桥', { 申请报销金额: '70.00', 费用项目: '长途交通费', 开始日期: '2026-07-16', 结束日期: '2026-07-16', 费用金额: '64.22', 税额: '5.78', 收票单号: 'SPD202607180005' }),
];

export function handedOffBanner(draftNo: string | null): string {
  return draftNo
    ? `已转人工处理：应用不再写入报销系统，对账记录已保留。草稿 ${draftNo} 请你在报销系统中核对并处理。`
    : '已转人工处理：应用不再写入报销系统，对账记录已保留。请你在报销系统中核对这次写入的结果。';
}

// 转人工的对账结果在页面上固定显示这句（从契约转出，mock 与测试共用）。
export { HUMAN_REVIEW_NOTICE };
