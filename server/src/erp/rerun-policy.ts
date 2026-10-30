import type { ResultEvent } from '@baox/erp-executor/protocol';

export type FillFailure = { code: string; lineId: string; column: string | null };

const LOCATED_FAILURES = new Set(['field_write_failed', 'money_model_not_settled', 'computed_total_mismatch',
  'tax_clear_failed', 'add_row_failed', 'ERP_DETAIL_ROW_NOT_ADDED', 'ERP_DETAIL_GRID_UNREADABLE']);

export function failureOf(result: ResultEvent | null): FillFailure | null {
  if (!result?.code || !result.context || !LOCATED_FAILURES.has(result.code)) return null;
  return { code: result.code, lineId: result.context.lineId, column: result.context.column };
}

/** A fresh form is recovery only while it can change the outcome. Unknown failures retain the existing limit. */
export function rerunStopReason(result: ResultEvent | null, previous?: FillFailure | null): string | null {
  if (result?.code === 'INVOICE_IMPORT_REJECTED') {
    return '报销系统已明确拒绝导入发票，应用没有自动换新单。请查看报销系统的具体原因并对账。';
  }
  const current = failureOf(result);
  if (!current || !previous || current.code !== previous.code || current.lineId !== previous.lineId || current.column !== previous.column) return null;
  return `自动换新单后，同一条明细${current.column ? `的「${current.column}」` : ''}再次因同类错误停止，应用不再自动换新单。请查看最后上报的位置和错误详情并对账。`;
}
