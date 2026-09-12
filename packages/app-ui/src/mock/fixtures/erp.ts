import type { Erp, ErpStep, Line, Readback, ReadbackRow, Reconcile, TaskSnapshot } from '../../contract/snapshot';

// ERP 填报、严格回读与对账的夹具（mock 服务端的角色）。步骤名照 spec #99 故事 26，说明沿用原型 ERP_STEPS。
// 故障：readback-mismatch 让 No.8 的 ERP 回读金额不同；erp-write-aborted 在保存步中止。

export const ERP_STEP_DEFS: ReadonlyArray<Pick<ErpStep, 'key' | 'title' | 'description'>> = [
  { key: 'browser', title: '启动浏览器', description: '打开专用浏览器窗口，使用独立的用户数据目录，不碰你日常的浏览器。' },
  { key: 'login', title: '登录', description: '在该窗口用本人账号登录 ERP。应用不会替你输入账号密码。' },
  { key: 'import', title: '导入发票', description: '7 张发票走 ERP 发票识别导入。' },
  { key: 'fill', title: '填明细', description: '按统一业务序号写入 9 行明细，每个值写入后从单元格回读。' },
  { key: 'save', title: '保存', description: '只保存草稿，不提交审批。' },
  { key: 'readback', title: '严格回读', description: '逐行回读 ERP 草稿并与本地确认数据比对，任何不一致即停。' },
];

export const ERP_STEP_INDEX = { browser: 0, login: 1, import: 2, fill: 3, save: 4, readback: 5 } as const;

// 第 active 步处于 status，之前的都已完成，之后的待开始；active 超出范围即全部完成。
export function erpSteps(active: number, status: ErpStep['status'] = 'running'): ErpStep[] {
  return ERP_STEP_DEFS.map((def, index) => ({
    ...def,
    status: index < active ? 'done' : index === active ? status : 'todo',
  }));
}

export function erpIdle(): Erp {
  return { status: 'idle', steps: erpSteps(-1), draftNo: null, abortReason: null, loginNotice: null };
}

export function loginNotDetected(attempt: number): string {
  return `还没有检测到登录（第 ${attempt} 次检测）。请确认已在专用浏览器窗口里登录本人账号；登录页上显示的上次账号不算已登录。登录后再点一次「我已登录，继续」。`;
}

export const SAVE_ABORT_REASON = '保存草稿时 ERP 没有在限定时间内返回结果，保存是否生效不确定。应用已停止写入，不会重放。';
export const MISMATCH_ABORT_REASON = '严格回读发现 1 行与本地确认不一致，应用已停止，不会自动改写 ERP 里的行。';

// readback-mismatch 故障：No.8（出租车 47.00）在 ERP 里读回 74.00。
export const MISMATCH = { no: 8, erp: '74.00' } as const;

function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function money(value: number): string {
  return (value / 100).toFixed(2);
}

export function readbackRows(lines: readonly Line[], mismatch: { no: number; erp: string } | null = null): ReadbackRow[] {
  return lines.map((line) => {
    const erp = mismatch && mismatch.no === line.no ? mismatch.erp : line.grossAmount;
    return { no: line.no, description: line.description, local: line.grossAmount, erp, matched: erp === line.grossAmount };
  });
}

// 回读结果：一致与否、摘要与两边合计都由服务端给出。
export function readbackOf(rows: readonly ReadbackRow[]): Readback {
  const matched = rows.filter((row) => row.matched).length;
  const mismatched = rows.length - matched;
  const local = rows.reduce((sum, row) => sum + cents(row.local), 0);
  const erp = rows.reduce((sum, row) => sum + (row.erp === null ? 0 : cents(row.erp)), 0);
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

export function mismatchReason(no: number): string {
  return `任务第 ${no} 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的 ERP 明细；金额相等不能代替逐行一致`;
}

// 写入完成：草稿已保存、严格回读逐行一致，阶段推到 done。
export function applyErpDone(snapshot: TaskSnapshot, draftNo: string): void {
  snapshot.erp = { status: 'done', steps: erpSteps(ERP_STEP_DEFS.length), draftNo, abortReason: null, loginNotice: null };
  snapshot.readback = readbackOf(readbackRows(snapshot.lines));
  snapshot.stage = 'done';
  snapshot.step = { kind: 'none', stepToken: `tok-${snapshot.task.taskId}-done` };
}

// 严格回读不一致：草稿已落库但与本地确认不一致，停在对账（已保存 + 逐行不一致 ⇒ 建议转人工）。
export function applyReadbackMismatch(snapshot: TaskSnapshot, draftNo: string): void {
  const readback = readbackOf(readbackRows(snapshot.lines, MISMATCH));
  const bad = readback.rows.filter((row) => !row.matched);
  snapshot.erp = { status: 'aborted', steps: erpSteps(ERP_STEP_INDEX.readback, 'failed'), draftNo, abortReason: MISMATCH_ABORT_REASON, loginNotice: null };
  snapshot.readback = readback;
  snapshot.reconcile = {
    status: 'pending',
    bucket: '已保存',
    action: '转人工',
    banner: `ERP 中存在草稿 ${draftNo}，${readback.rows.length} 行明细中 ${readback.rows.length - bad.length} 行一致，${bad.length} 行金额不一致。`,
    draftNo,
    rows: readback.rows,
    reasons: bad.map((row) => mismatchReason(row.no)),
  };
  snapshot.stage = 'reconcile';
  snapshot.step = { kind: 'reconcile', stepToken: `tok-${snapshot.task.taskId}-reconcile-mismatch` };
}

// 保存步中止：还没读到草稿，保存是否生效不确定（对账中断点「未知」⇒ 原地等待）。
export function applyAbortAtSave(snapshot: TaskSnapshot): void {
  snapshot.erp = { status: 'aborted', steps: erpSteps(ERP_STEP_INDEX.save, 'failed'), draftNo: null, abortReason: SAVE_ABORT_REASON, loginNotice: null };
  snapshot.readback = emptyReadback();
  snapshot.reconcile = abortedReconcile();
  snapshot.stage = 'reconcile';
  snapshot.step = { kind: 'reconcile', stepToken: `tok-${snapshot.task.taskId}-reconcile` };
}

function abortedReconcile(): Reconcile {
  return {
    status: 'pending',
    bucket: '未知',
    action: '原地等待',
    banner: '保存步中止后还没有读到 ERP 草稿，保存是否生效尚不确定。可以先在 ERP 里查看，再点「重新对账」；也可以转人工。',
    draftNo: null,
    rows: [],
    reasons: ['保存后没有同时读到修改页签、单据编号和严格逐行回读'],
  };
}

// T2（对账中）：原型 §1.10 的五行，No.3 金额不一致；合计 1264.00。
export const T2_ROWS: readonly ReadbackRow[] = [
  { no: 1, description: 'G6512 上海虹桥 → 深圳北', local: '553.00', erp: '553.00', matched: true },
  { no: 2, description: '亚朵酒店 2 晚', local: '396.00', erp: '396.00', matched: true },
  { no: 3, description: '滴滴 · 深圳北 → 科技园', local: '182.00', erp: '128.00', matched: false },
  { no: 4, description: '出租车 · 科技园 → 宝安机场', local: '63.00', erp: '63.00', matched: true },
  { no: 5, description: 'G6513 深圳北 → 上海虹桥', local: '70.00', erp: '70.00', matched: true },
];

export function handedOffBanner(draftNo: string | null): string {
  return draftNo
    ? `已转人工处理：应用不再写入 ERP，对账记录已保留。草稿 ${draftNo} 请你在 ERP 中核对并处理。`
    : '已转人工处理：应用不再写入 ERP，对账记录已保留。请你在 ERP 中核对这次写入的结果。';
}
