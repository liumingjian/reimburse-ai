import {
  HUMAN_REVIEW_NOTICE,
  READBACK_FIELD_LABELS,
  RECONCILE_ACTION_LABELS,
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

// 写入报销系统、严格回读与对账的夹具（mock 服务端的角色）。步骤划分照内核 erp-write 的阶段（next.mjs erp_write_pending）。
// 故障：readback-mismatch 让 No.6 的申请报销金额在报销系统里读回 74.00；erp-write-aborted 在保存步中止。

export const ERP_STEP_DEFS: ReadonlyArray<Pick<ErpStep, 'key' | 'title' | 'description'>> = [
  { key: 'browser', title: '启动浏览器', description: '打开专用浏览器窗口，使用独立的用户数据目录，不碰你日常的浏览器。' },
  { key: 'login', title: '登录', description: '在该窗口用本人账号登录报销系统。应用不会替你输入账号密码。' },
  { key: 'navigate', title: '打开空白报销单', description: '打开费用报销单新增页，确认是唯一一张空白单据。' },
  { key: 'assistant', title: '选择不生成费用明细', description: '打开发票助手，选择「不生成费用明细」；明细由确认过的数据逐行写入。' },
  { key: 'import', title: '导入发票', description: '按格式分批导入 7 张发票。' },
  { key: 'receipt', title: '收票回读', description: '逐票回读收票单号、发票号码、不含税金额、税额与价税合计。' },
  { key: 'fill', title: '填写明细', description: '按统一业务序号写入 9 行明细，每个值写入后从单元格回读。' },
  { key: 'save', title: '保存草稿', description: '只保存一次草稿，不提交审批。' },
  { key: 'readback', title: '严格回读', description: '保存后逐行回读 9 个字段，与确认过的明细比对，任何不一致即停。' },
];

export const ERP_STEP_INDEX = { browser: 0, login: 1, navigate: 2, assistant: 3, import: 4, receipt: 5, fill: 6, save: 7, readback: 8 } as const;

// 第 active 步处于 status，之前的都已完成，之后的待开始；active 超出范围即全部完成。
export function erpSteps(active: number, status: ErpStep['status'] = 'running'): ErpStep[] {
  return ERP_STEP_DEFS.map((def, index) => ({
    ...def,
    status: index < active ? 'done' : index === active ? status : 'todo',
  }));
}

// 「去报销」之后浏览器已启动、登录步等待（`?seed=erp` 的状态）。
export function erpWaitingLogin(): Erp {
  return { status: 'waiting_login', steps: erpSteps(ERP_STEP_INDEX.login, 'waiting'), draftNo: null, abortReason: null, loginNotice: null };
}

export function loginNotDetected(attempt: number): string {
  return `还没有检测到登录（第 ${attempt} 次检测）。请确认已在专用浏览器窗口里登录本人账号；登录页上显示的上次账号不算已登录。登录后再点一次「我已登录，继续」。`;
}

export const SAVE_ABORT_REASON = '保存草稿时报销系统没有在限定时间内返回结果，保存是否生效不确定。应用已停止写入，不会重放。';
export const MISMATCH_ABORT_REASON = '严格回读发现 1 行与本地确认不一致，应用已停止，不会自动改写报销系统里的行。';

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
  return { status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null, draftNo: null, rows: [], reasons: [] };
}

// 对账判定（内核 classifyReconciliation 的对应）：bucket 决定处置；「已保存」还要看收票与明细合计是否相等、严格逐行是否一致。
// 原地等待只允许重新对账（只读）；转人工的结果是 human_review，只允许转人工。
export function reconcileVerdict(
  bucket: ReconcileBucket,
  savedConsistent = true,
): Pick<Reconcile, 'bucket' | 'action' | 'actionCode' | 'allowedActions' | 'humanReview'> {
  const handOff = bucket === '未保存·已导入未写明细' || bucket === '不自洽' || (bucket === '已保存' && !savedConsistent);
  const code: ReconcileActionCode = handOff ? 'hand_off' : 'wait';
  return { bucket, action: RECONCILE_ACTION_LABELS[code], actionCode: code, allowedActions: [code], humanReview: handOff };
}

// 写入完成：草稿已保存、严格回读逐行一致，阶段推到 done。
export function applyErpDone(snapshot: TaskSnapshot, draftNo: string): void {
  snapshot.erp = { status: 'done', steps: erpSteps(ERP_STEP_DEFS.length), draftNo, abortReason: null, loginNotice: null };
  snapshot.readback = readbackOf(readbackRows(snapshot.lines));
  snapshot.stage = 'done';
  snapshot.step = { kind: 'none', stepToken: `tok-${snapshot.task.taskId}-done` };
}

// 严格回读不一致：草稿已落库但与本地确认不一致，写入就此停下（已保存 + 逐行不一致 ⇒ 转人工，human_review）。
// 任务停在完成页（done 阶段）但不算完成：完成页显示差异行，当前待答 step 是 hand_off，只接受「转人工」。
export function applyReadbackMismatch(snapshot: TaskSnapshot, draftNo: string): void {
  const readback = readbackOf(readbackRows(snapshot.lines, MISMATCH));
  const bad = readback.rows.filter((row) => !row.matched);
  snapshot.erp = { status: 'aborted', steps: erpSteps(ERP_STEP_INDEX.readback, 'failed'), draftNo, abortReason: MISMATCH_ABORT_REASON, loginNotice: null };
  snapshot.readback = readback;
  snapshot.reconcile = {
    status: 'pending',
    ...reconcileVerdict('已保存', false),
    banner: `报销系统中存在草稿 ${draftNo}，${readback.rows.length} 行明细中 ${readback.rows.length - bad.length} 行一致，${bad.length} 行不一致。`,
    draftNo,
    rows: readback.rows,
    reasons: [],
  };
  snapshot.stage = 'done';
  snapshot.step = { kind: 'hand_off', stepToken: `tok-${snapshot.task.taskId}-hand-off` };
}

// 保存步中止：还没读到草稿，保存是否生效不确定（对账中断点「未知」⇒ 原地等待，只能重新对账）。
export function applyAbortAtSave(snapshot: TaskSnapshot): void {
  snapshot.erp = { status: 'aborted', steps: erpSteps(ERP_STEP_INDEX.save, 'failed'), draftNo: null, abortReason: SAVE_ABORT_REASON, loginNotice: null };
  snapshot.readback = emptyReadback();
  snapshot.reconcile = {
    status: 'pending',
    ...reconcileVerdict('未知'),
    banner: '保存步中止后还没有读到报销系统草稿，保存是否生效尚不确定。可以先在报销系统里查看，再点「重新对账」。',
    draftNo: null,
    rows: [],
    reasons: ['保存后没有同时读到修改页签、单据编号和严格逐行回读'],
  };
  snapshot.stage = 'reconcile';
  snapshot.step = { kind: 'reconcile', stepToken: `tok-${snapshot.task.taskId}-reconcile` };
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
