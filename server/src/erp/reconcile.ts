// ERP 对账 (reconcile): the server-side classifier that places the current expense form in exactly one of the six
// 对账中断点 (reconcile buckets) and gives one of the two actions (ADR-0016: the executor only observes, the server
// judges). Origin: 50931a3:kernel/src/erpreconcile.mjs (BUCKETS, ACTIONS, sumColumn, classifyReconciliation, attemptRecord);
// contract: docs/research/erp-expense-flow/save-contract.md "erp-reconcile 判定契约" (issue #36).
//
// Every reading carries its own `readable`: "empty" is a conclusion, "unreadable" is a refusal to conclude.

import { RECONCILE_ACTIONS, RECONCILE_BUCKETS, type ReconcileBucket } from '@baox/contract';
import type { Readings } from './protocol';
import { matchTaskLines, toCents } from './readback';

export { toCents };

export const BUCKETS = RECONCILE_BUCKETS;
export const ACTIONS = RECONCILE_ACTIONS;
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

/** The receipt grid is summed on this column, the detail grid on the other; both include tax (the one identity). */
export const RECEIPTS_COLUMN = '价税合计';
export const DETAIL_COLUMN = '申请报销金额';
/** Side evidence: never part of the identity, a mismatch never turns red. */
export const PAYABLE_COLUMN = '申请付款金额';
/**
 * The 明细 columns the ERP refuses 保存 without and that this same grid can be read for
 * (`docs/research/erp-expense-flow/save-contract.md` 「字段与顺序」: 项目, 费用项目, 发票类型, 费用承担部门 are all
 * 必填). Only the two the detail grid renders as its own columns are checked; 发票类型 is checked by the strict
 * per-line match and 费用承担部门 is not in the grid, so a full 必填 proof is the strict match's job, not this one's.
 */
export const REQUIRED_DETAIL_COLUMNS = ['项目', '费用项目'] as const;

/** The 必填 cells of the detail grid: readable says whether the columns could be read, blank lists what is empty. */
export type RequiredCells = { readable: boolean; blank: Array<{ row: number; column: string }>; reason?: string };

/**
 * Read the 必填 cells off the detail grid. An empty cell is a conclusion ("this row cannot be saved"); a column the
 * header does not carry is a refusal to conclude, exactly as `sumColumn` treats its own column.
 */
export function requiredDetailCells(grid: GridLike): RequiredCells {
  if (!grid || grid.ok !== true) return { readable: false, blank: [], reason: grid?.reason ?? '读不到明细网格' };
  const labels = new Set((grid.columns ?? []).map((c) => c.label));
  const missing = REQUIRED_DETAIL_COLUMNS.filter((column) => !labels.has(column));
  if (missing.length > 0) {
    return { readable: false, blank: [], reason: `明细网格的表头里认不出${missing.map((c) => `「${c}」`).join('')}列，判不出必填项填没填` };
  }
  const blank: Array<{ row: number; column: string }> = [];
  for (const [i, row] of (grid.rows ?? []).filter((r) => r.kind === 'data').entries()) {
    for (const column of REQUIRED_DETAIL_COLUMNS) {
      if (String(row.values?.[column] ?? '').trim() === '') blank.push({ row: i + 1, column });
    }
  }
  return { readable: true, blank };
}

/**
 * The reader's words for "there is no 费用报销单 on the page at all" (`executor/reader.ts` formTabs, and the
 * `noFormOpen` fake). A page with no form open is a normal state — the employee closed the tab, or the browser was
 * cleaned — and it is not the same unreadable as two forms open at once, which is why the disposition layer needs to
 * tell them apart. Pinned by a test that runs the real reader over a zero-tab page.
 */
export const NO_FORM_OPEN_REASON = '页面上没有打开的费用报销单';

/** True when 对账 found no 费用报销单 open at all: no reading was taken, and none says anything about the task. */
export function noFormOpen(readings: ReconcileReadings): boolean {
  return !readings.formMode?.readable && (readings.formMode?.reason ?? '').startsWith(NO_FORM_OPEN_REASON);
}

type GridLike = { ok: boolean; reason?: string; columns?: Array<{ label: string }>; rows?: Array<{ kind: string; values?: Record<string, string> }> } | null | undefined;

export type ColumnSum = { readable: boolean; totalCents: number | null; rowCount: number | null; reason?: string; rows?: Array<{ row: number; cents: number }>; columns?: string[] };
export type TaskMatch = { ok: boolean; reasons?: string[] };
export type ReconcileReadings = {
  formMode: { readable: boolean; value: 'new' | 'modify' | null; reason?: string };
  billNo: { readable: boolean; value: string | null; reason?: string };
  receipts: ColumnSum;
  detail: ColumnSum;
  payable?: { readable: boolean; totalCents: number | null };
  /** The 必填 cells of the same detail grid: what says whether the ERP would accept 保存 at all. */
  detailRequired?: RequiredCells;
  taskMatch?: TaskMatch | null;
};
export type Identity = { applicable: boolean; receiptsCents: number | null; detailCents: number | null; equal: boolean };
export type ReconcileVerdict = { bucket: ReconcileBucket; action: ReconcileAction; identity: Identity; reasons: string[] };

/**
 * Sum one column of a grid. The three fail-closed rules live here:
 *   - the column is not recognised -> the whole grid is unreadable (no guessing a similar label);
 *   - any row's cell is empty or not money -> the whole grid is unreadable (never 0);
 *   - ERP's own total row disagrees with the row sum -> the whole grid is unreadable.
 */
export function sumColumn(grid: GridLike, column: string): ColumnSum {
  const none = (reason: string, extra: Partial<ColumnSum> = {}): ColumnSum => ({ readable: false, totalCents: null, rowCount: null, reason, ...extra });
  if (!grid || grid.ok !== true) return none(grid?.reason ?? `读不到「${column}」所在的网格`);
  const columns = grid.columns ?? [];
  if (!columns.some((c) => c.label === column)) {
    return none(`网格的表头里认不出「${column}」列`, { columns: columns.map((c) => c.label) });
  }
  const all = grid.rows ?? [];
  const data = all.filter((r) => r.kind === 'data');
  const rows: Array<{ row: number; cents: number }> = [];
  let sum = 0;
  for (const [i, r] of data.entries()) {
    const cents = toCents(r.values?.[column]);
    if (cents === null) return none(`第 ${i + 1} 行的「${column}」是空的或者读不成金额；空单元格判不可读，不当 0`, { rowCount: data.length });
    sum += cents;
    rows.push({ row: i + 1, cents });
  }
  // An unreadable total cell does not count (a 0-row grid has an empty total); a readable one must agree.
  for (const t of all.filter((r) => r.kind === 'total')) {
    const shown = toCents(t.values?.[column]);
    if (shown === null) continue;
    if (shown !== sum) return none(`ERP 自渲染的合计行「${column}」是 ${shown} 分，逐行相加是 ${sum} 分，两者不一致`, { rowCount: data.length });
  }
  return { readable: true, totalCents: sum, rowCount: data.length, rows };
}

/** The identity: both sides include tax, integer cents, zero tolerance. */
function identityOf(receipts: ColumnSum | undefined, detail: ColumnSum | undefined): Identity {
  const applicable = !!(receipts?.readable && detail?.readable);
  return {
    applicable,
    receiptsCents: receipts?.readable ? receipts.totalCents : null,
    detailCents: detail?.readable ? detail.totalCents : null,
    equal: applicable && receipts!.totalCents === detail!.totalCents,
  };
}

/**
 * The six-bucket judgement. Pure: the same readings always give the same bucket.
 *
 * The order is part of the contract, and 未知 (unknown) is evaluated first, or an unreadable value would pose as
 * another bucket. The contract's row 1 ("any reading unreadable -> 未知") and row 4 ("... and (detail unreadable or
 * detail total 0)") overlap; the heavier reading wins: on a new form with no bill number and receipt rows, an
 * unreadable detail means "lines not written" (hand off, the invoices are consumed); any other unreadable reading
 * is 未知 (wait).
 */
export function classifyReconciliation(readings: ReconcileReadings): ReconcileVerdict {
  const { formMode, billNo, receipts, detail, payable } = readings;
  const reasons: string[] = [];
  const verdict = (bucket: ReconcileBucket, action: ReconcileAction): ReconcileVerdict => ({ bucket, action, identity: identityOf(receipts, detail), reasons });

  const mode = formMode?.readable ? formMode.value : null;
  const noBill = billNo?.readable && !billNo.value;
  const hasBill = billNo?.readable && !!billNo.value;

  if (!formMode?.readable) reasons.push(`页签模式读不到：${formMode?.reason ?? '没有原因'}`);
  if (!billNo?.readable) reasons.push(`单据编号读不到：${billNo?.reason ?? '没有原因'}`);
  if (!receipts?.readable) reasons.push(`收票${RECEIPTS_COLUMN}读不到：${receipts?.reason ?? '没有原因'}`);
  if (!detail?.readable) reasons.push(`明细${DETAIL_COLUMN}读不到：${detail?.reason ?? '没有原因'}`);
  if (payable?.readable && detail?.readable && payable.totalCents !== detail.totalCents) {
    // Side evidence: recorded, never moves the bucket.
    reasons.push(`旁证：${PAYABLE_COLUMN}合计 ${payable.totalCents} 分与${DETAIL_COLUMN}合计 ${detail.totalCents} 分不等，不进判定`);
  }

  if (!formMode?.readable || !billNo?.readable || !receipts?.readable) return verdict('未知', '原地等待');

  const imported = (receipts.rowCount ?? 0) > 0;
  if (mode === 'new' && noBill && imported && !detail?.readable) {
    reasons.push('收票已有行、明细读不出来：按「还没写明细」处置，发票已被 ERP 消耗');
    return verdict('未保存·已导入未写明细', '转人工');
  }
  if (!detail?.readable) return verdict('未知', '原地等待');

  // With an expected preview, equal totals and row counts do not prove the task was written right: a failed strict
  // per-line match never reports a new form as ready to save, and a saved form goes to a human.
  if (readings.taskMatch && !readings.taskMatch.ok) {
    reasons.push(...(readings.taskMatch.reasons ?? ['逐行任务回读未通过']));
    return verdict(mode === 'modify' && hasBill ? '已保存' : '不自洽', '转人工');
  }

  if (mode === 'modify' && hasBill) {
    const id = identityOf(receipts, detail);
    reasons.push(`页签是「修改」且单据编号是 ${billNo.value}，草稿已落库`);
    if (id.equal) return verdict('已保存', '原地等待');
    reasons.push(`已落库但恒等式不成立：收票 ${id.receiptsCents} 分 ≠ 明细 ${id.detailCents} 分`);
    return verdict('已保存', '转人工');
  }
  if (mode === 'new' && noBill) {
    if (!imported) {
      reasons.push('收票网格 0 行：ERP 上没落任何东西，发票没被消耗');
      return verdict('未保存·导入前', '原地等待');
    }
    if (detail.totalCents === 0) {
      reasons.push(`收票 ${receipts.rowCount} 行、明细${DETAIL_COLUMN}合计为 0：发票已被 ERP 消耗，明细还没写`);
      return verdict('未保存·已导入未写明细', '转人工');
    }
    if (receipts.totalCents === detail.totalCents) {
      // Equal totals are not a saveable bill. On import the ERP auto-creates aggregated 明细 rows that already carry
      // the full amount with 项目 and 费用项目 empty (measured live: 10 收票 grouped by 发票类型 into 2 rows totalling
      // the whole 7,335.55), so the two sides agree to the cent while 保存 is refused on 必填
      // (`save-contract.md`). 就绪待保存 therefore needs evidence that the bill is saveable, not just that two numbers
      // agree: either the strict per-line match (it compares 项目 and 费用项目 per row), or the 必填 cells of the same
      // grid. Telling an employee to press 保存 on a bill the ERP will refuse is worse than saying nothing, so a
      // missing reading fails to 未知 and an empty cell to the honest bucket.
      if (readings.taskMatch?.ok !== true) {
        const required = readings.detailRequired;
        if (!required?.readable) {
          reasons.push(`明细必填项读不到：${required?.reason ?? '没有原因'}；两边合计相等不足以说明这张单能保存`);
          return verdict('未知', '原地等待');
        }
        if (required.blank.length > 0) {
          const columns = [...new Set(required.blank.map((cell) => cell.column))].map((column) => `「${column}」`).join('');
          reasons.push(`明细 ${detail.rowCount} 行里有 ${required.blank.length} 处必填项${columns}是空的：报销系统会拒绝保存，按「还没写明细」处置`);
          return verdict('未保存·已导入未写明细', '转人工');
        }
      }
      reasons.push(`两边都是 ${receipts.totalCents} 分，按分相等，差保存这一下`);
      return verdict('未保存·就绪待保存', '原地等待');
    }
    reasons.push(`收票 ${receipts.totalCents} 分与明细 ${detail.totalCents} 分不等`);
    return verdict('不自洽', '转人工');
  }
  // New with a bill number, or modify without one: report the readings as they are, no explanation.
  reasons.push(`页签是「${mode === 'modify' ? '修改' : '新增'}」，单据编号${billNo.value ? `是 ${billNo.value}` : '为空'}，两者对不上`);
  return verdict('不自洽', '转人工');
}

/**
 * Turn the executor's raw readings (the protocol `Readings`) into the classifier's four readings plus side evidence.
 * With an expected preview (the approved draft preview of the fill), the strict per-line match becomes `taskMatch`.
 * Origin: the summing half of kernel readReconciliation.
 */
export function reconcileReadings(readings: Readings, expectedPreview: unknown = null): ReconcileReadings {
  const receiptsGrid = readings.receiptsGrid as GridLike;
  const detailGrid = readings.detailGrid as GridLike;
  const payable = sumColumn(detailGrid, PAYABLE_COLUMN);
  const reason = (value: Record<string, unknown>) => (typeof value.reason === 'string' ? { reason: value.reason } : {});
  return {
    formMode: { readable: readings.formMode.readable, value: readings.formMode.value, ...reason(readings.formMode) },
    billNo: { readable: readings.billNo.readable, value: readings.billNo.value, ...reason(readings.billNo) },
    receipts: sumColumn(receiptsGrid, RECEIPTS_COLUMN),
    detail: sumColumn(detailGrid, DETAIL_COLUMN),
    payable: { readable: payable.readable, totalCents: payable.totalCents },
    detailRequired: requiredDetailCells(detailGrid),
    taskMatch: expectedPreview ? matchTaskLines(detailGrid, expectedPreview, receiptsGrid) : null,
  };
}

/** Readings -> bucket in one call: what the server does with a reconcile job's read-back. */
export const classifyReadings = (readings: Readings, expectedPreview: unknown = null) =>
  classifyReconciliation(reconcileReadings(readings, expectedPreview));

/**
 * The audit record of one reconcile: readings, bucket, action. Only desensitised facts (cents, row counts, reasons);
 * no copy of the page. Origin: kernel attemptRecord.
 */
export function reconcileRecord({ bucket, action, identity, reasons }: ReconcileVerdict, readings: ReconcileReadings, at: Date = new Date()) {
  const cell = (r: ColumnSum | undefined) => ({ readable: !!r?.readable, totalCents: r?.readable ? r.totalCents : null,
    rowCount: r?.readable ? r.rowCount : null, reason: r?.reason ?? null });
  return {
    at: at.toISOString(),
    kind: 'erp-reconcile' as const,
    bucket, action, identity, reasons,
    readings: {
      formMode: { readable: !!readings.formMode?.readable, value: readings.formMode?.value ?? null, reason: readings.formMode?.reason ?? null },
      // The bill number is ERP's own document number, not reimbursement content; kept to rebuild the judgement.
      billNo: { readable: !!readings.billNo?.readable, value: readings.billNo?.value ?? null, reason: readings.billNo?.reason ?? null },
      receipts: cell(readings.receipts),
      detail: cell(readings.detail),
      payable: { readable: !!readings.payable?.readable, totalCents: readings.payable?.totalCents ?? null },
      // Which 必填 cells were empty is why a bucket says the bill is not saveable; the audit needs it to rebuild that.
      detailRequired: readings.detailRequired ?? null,
      taskMatch: readings.taskMatch ?? null,
    },
  };
}
