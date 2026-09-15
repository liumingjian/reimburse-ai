// Server-side judgement of ERP read-backs (ADR-0016: the executor only observes, the server compares).
// Origin: kernel/src/erp-write-readback.mjs (buildReceiptReadback) and kernel/src/erpreconcile.mjs
// (matchTaskLines, the strict per-line comparison). Inputs, codes and messages are kept.

import type { Readings } from './protocol';

const MONEY = /^\d+(?:\.\d{1,2})?$/;
const SAFE_RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type Problem = { code: string; message: string; [extra: string]: unknown };
type GridLike = { ok: boolean; reason?: string; columns?: Array<{ label: string }>; rows?: Array<{ kind: string; values?: Record<string, string> }> } | null | undefined;

const text = (value: unknown) => (value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim());

const amount = (value: unknown) => {
  const normalized = text(value)?.replace(/[¥￥,\s]/g, '') ?? null;
  if (!normalized || !MONEY.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : null;
};

const invoiceNumber = (value: unknown) => text(value)?.replace(/\s+/g, '') ?? null;

const invoiceMatchesFull = (full: string, observed: unknown) => {
  const value = invoiceNumber(observed);
  if (!full || !value) return false;
  if (value === full) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(value);
  return !!masked && full.startsWith(masked[1]!) && full.endsWith(masked[2]!);
};

export type ReadbackInvoice = { materialId: string; identity?: { key?: string; number?: string }; fields?: { invoiceNumber?: string } };

const invoiceOf = (invoice: ReadbackInvoice) => {
  const identity = invoice?.identity;
  const number = text(identity?.number ?? invoice?.fields?.invoiceNumber);
  const identityKey = text(identity?.key);
  return /^einvoice-20:\d{20}$/.test(identityKey ?? '') && /^\d{20}$/.test(number ?? '') && identityKey === `einvoice-20:${number}`
    ? { invoiceNumber: number!, identityKey: identityKey! }
    : null;
};

const problem = (code: string, message: string, extra: Record<string, unknown> = {}): Problem => ({ code, message, ...extra });

export type ReceiptFact = {
  voucherMaterialId: string; identityKey: string; invoiceNumber: string; receiptNumber: string | null;
  grossAmount: string | null; netAmount: string | null; taxAmount: string | null; source: 'erp_receipt';
};

/**
 * Turn the fresh receipt grid (收票网格) into the receipt check and the receipt readback the draft preview needs.
 * Unknown, duplicate, ambiguous-mask or non-conserved rows are all refused; an amount match never binds a row.
 */
export function buildReceiptReadback({ grid, invoices = [], taskId, versionId, identity, readAt = new Date().toISOString() }: {
  grid: GridLike; invoices?: ReadbackInvoice[]; taskId?: string | null; versionId?: string | null;
  identity?: { account: string; tenant: string } | null; readAt?: string;
}) {
  const problems: Problem[] = [];
  const expected = invoices
    .map((invoice) => ({ materialId: text(invoice?.materialId), ...invoiceOf(invoice) }))
    .filter((invoice): invoice is { materialId: string; invoiceNumber: string; identityKey: string } =>
      !!invoice.materialId && !!invoice.invoiceNumber && !!invoice.identityKey);
  if (expected.length !== invoices.length) {
    problems.push(problem('invoice_identity_missing', '准备包中存在缺少完整 20 位发票身份的主要凭证'));
  }
  if (grid?.ok !== true) {
    problems.push(problem('receipt_grid_unreadable', grid?.reason ?? 'ERP 收票网格不可读'));
    return { ok: false as const, problems, receiptCheck: null, receiptReadback: null };
  }
  const rows = Array.isArray(grid.rows) ? grid.rows.filter((row) => row.kind === 'data') : [];
  if (rows.length !== expected.length) {
    problems.push(problem('receipt_row_count_mismatch', `ERP 收票行数 ${rows.length} 与当前主要发票数 ${expected.length} 不一致`));
  }

  const used = new Set<string>();
  const facts: ReceiptFact[] = [];
  for (const [index, row] of rows.entries()) {
    const values = row?.values ?? {};
    const hits = expected.filter((invoice) => invoiceMatchesFull(invoice.invoiceNumber, values['发票号码']));
    if (hits.length !== 1) {
      problems.push(problem(hits.length === 0 ? 'receipt_invoice_unmatched' : 'receipt_invoice_ambiguous',
        `ERP 收票第 ${index + 1} 行无法唯一对应当前主要发票`, { row: index + 1 }));
      continue;
    }
    const matched = hits[0]!;
    if (used.has(matched.materialId)) {
      problems.push(problem('receipt_invoice_duplicate', `ERP 收票重复对应主要凭证 ${matched.materialId}`, { row: index + 1 }));
      continue;
    }
    used.add(matched.materialId);
    const receiptNumber = text(values['收票单']);
    const netAmount = amount(values['不含税金额']);
    const taxAmount = amount(values['税额']);
    const grossAmount = amount(values['价税合计']);
    if (!receiptNumber || !SAFE_RECEIPT.test(receiptNumber)) {
      problems.push(problem('receipt_number_invalid', `ERP 收票第 ${index + 1} 行的收票号不可用`));
    }
    if (netAmount === null || taxAmount === null || grossAmount === null) {
      problems.push(problem('receipt_amount_missing', `ERP 收票第 ${index + 1} 行缺少不含税金额、税额或价税合计`));
    } else if (Number((Number(netAmount) + Number(taxAmount)).toFixed(2)) !== Number(grossAmount)) {
      problems.push(problem('receipt_amount_not_conserved', `ERP 收票第 ${index + 1} 行的金额不守恒`));
    }
    facts.push({
      voucherMaterialId: matched.materialId, identityKey: matched.identityKey, invoiceNumber: matched.invoiceNumber,
      receiptNumber, grossAmount, netAmount, taxAmount, source: 'erp_receipt',
    });
  }
  for (const expectedInvoice of expected) {
    if (!used.has(expectedInvoice.materialId)) {
      problems.push(problem('receipt_binding_missing', `主要凭证 ${expectedInvoice.materialId} 没有对应 ERP 收票行`));
    }
  }
  const receiptNumbers = facts.map((fact) => fact.receiptNumber).filter(Boolean);
  if (new Set(receiptNumbers).size !== receiptNumbers.length) {
    problems.push(problem('receipt_number_duplicate', 'ERP 收票号不唯一'));
  }
  if (problems.length) return { ok: false as const, problems, receiptCheck: null, receiptReadback: null };

  const receiptCheck = {
    taskId: taskId ?? null, versionId: versionId ?? null, identity: identity ?? null, fresh: true, readAt,
    checks: facts.map((fact) => ({
      materialId: fact.voucherMaterialId, identityKey: fact.identityKey, ok: true,
      rows: [[fact.receiptNumber, '', '', fact.grossAmount]] as Array<Array<string | null>>,
    })),
  };
  const receiptReadback = { taskId: taskId ?? null, versionId: versionId ?? null, identity: identity ?? null, fresh: true, readAt, rows: facts };
  return { ok: true as const, problems: [] as Problem[], receiptCheck, receiptReadback };
}

// ---- Strict per-line comparison (origin: kernel/src/erpreconcile.mjs matchTaskLines) ----

const RECEIPTS_COLUMN = '价税合计';
const DETAIL_COLUMN = '申请报销金额';
const NET_COLUMN = '费用金额';
const TAX_COLUMN = '税额';
const PROJECT_COLUMN = '项目';
const EXPENSE_ITEM_COLUMN = '费用项目';
const START_DATE_COLUMN = '开始日期';
const END_DATE_COLUMN = '结束日期';
const INVOICE_TYPE_COLUMN = '发票类型';
const RECEIPT_NET_COLUMN = '不含税金额';
const RECEIPT_NUMBER_COLUMN = '收票单';
const INVOICE_NUMBER_COLUMN = '发票号码';
const DETAIL_RECEIPT_NUMBER_COLUMN = '收票单号';
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票']);

/** Money text -> cents, without floating point; anything unreadable is null (never 0). */
export function toCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[¥￥,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

const textOf = (value: unknown) => (value === null || value === undefined ? '' : String(value)).normalize('NFKC').replace(/\s+/g, ' ').trim();
const amountOf = (value: unknown) => (value === null || value === undefined || textOf(value) === '' ? null : toCents(value));
const dateOf = (value: unknown) => {
  const s = textOf(value);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s) ?? /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
const columnOf = (grid: GridLike, label: string) => grid?.columns?.some((column) => column.label === label) === true;
const dataRowsOf = (grid: GridLike) => (grid?.ok === true && Array.isArray(grid.rows) ? grid.rows.filter((row) => row.kind === 'data') : []);
const sumKnown = (values: Array<number | null>) => (values.every((value) => value !== null) ? (values as number[]).reduce((sum, value) => sum + value, 0) : null);
const receiptNumberOf = (value: unknown) => {
  const s = textOf(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) ? s : null;
};
const invoiceMatches = (actual: unknown, expected: unknown) => {
  const actualText = textOf(actual).replace(/\s+/g, '');
  const expectedText = textOf(expected);
  if (!/^\d{20}$/.test(expectedText)) return false;
  if (actualText === expectedText) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(actualText);
  return !!masked && expectedText.startsWith(masked[1]!) && expectedText.endsWith(masked[2]!);
};
const normalizeReceiptBinding = (raw: any, index: number) => {
  const voucherMaterialId = textOf(raw?.voucherMaterialId);
  const identityKey = textOf(raw?.identityKey ?? raw?.invoiceIdentityKey);
  const identity = /^einvoice-20:(\d{20})$/.exec(identityKey);
  const invoiceNumberText = textOf(raw?.invoiceNumber) || identity?.[1] || '';
  const receiptNumber = receiptNumberOf(raw?.receiptNumber ?? raw?.receiptNo);
  return { index, voucherMaterialId, identityKey, invoiceNumber: invoiceNumberText, receiptNumber,
    valid: !!voucherMaterialId && !!identity && invoiceNumberText === identity[1] && !!receiptNumber };
};
const receiptBindingsOf = (expected: any) => (!Array.isArray(expected?.receiptBindings)
  ? { present: false, bindings: [] as ReturnType<typeof normalizeReceiptBinding>[] }
  : { present: true, bindings: expected.receiptBindings.map(normalizeReceiptBinding) as ReturnType<typeof normalizeReceiptBinding>[] });
const projectSourceConfirmed = (line: any, expected: any) => textOf(expected?.projectSource) === 'erp_catalog_confirmed'
  && textOf(expected?.projectsFrom) === 'project_book'
  && textOf(line?.projectSource) === 'erp_catalog_confirmed'
  && textOf(line?.projectsFrom) === 'project_book';
const accommodationLine = (line: any) => textOf(line?.category) === 'accommodation';
const validInvoiceTypeSource = (value: unknown) => {
  const source = textOf(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};

/**
 * Compare the ERP detail grid line by line with the confirmed preview. No "unique amount wins" fallback:
 * project, expense item, dates, net, tax, receipt link and invoice type must all be equal.
 */
export function matchTaskLines(grid: GridLike, expected: any, receiptsGrid: GridLike = null) {
  const expectedLines: any[] | undefined = Array.isArray(expected) ? expected : expected?.lines;
  const reasons: string[] = [];
  const amountSources: Array<{ line: number; net: string; tax: string }> = [];
  if (!Array.isArray(expectedLines) || expectedLines.length === 0) {
    return { ok: false, reasons: ['没有可用于逐行核对的已确认明细预览'], amountSources };
  }
  if (!grid?.ok) return { ok: false, reasons: ['无法逐行核对当前任务明细'], amountSources };
  if (Array.isArray(expected)) reasons.push('逐行核对必须使用包含来源和 receiptBindings 的 expectedPreview');
  if (textOf(expected?.projectSource) !== 'erp_catalog_confirmed' || textOf(expected?.projectsFrom) !== 'project_book') {
    reasons.push('expectedPreview 缺少 erp_catalog_confirmed/project_book 来源证据');
  }

  const rows = dataRowsOf(grid);
  if (rows.length !== expectedLines.length) reasons.push(`任务要求 ${expectedLines.length} 条明细，ERP 实际为 ${rows.length} 条`);

  const expectedData = expectedLines.map((line, index) => {
    const total = amountOf(line?.totalAmount);
    const net = line?.netAmount === null ? null : amountOf(line?.netAmount);
    const tax = line?.taxAmount === null ? null : amountOf(line?.taxAmount);
    const hasNet = Object.prototype.hasOwnProperty.call(line ?? {}, 'netAmount');
    const hasTax = Object.prototype.hasOwnProperty.call(line ?? {}, 'taxAmount');
    const voucherMaterialId = textOf(line?.voucherMaterialId);
    const kind = textOf(line?.kind);
    const projectCode = textOf(line?.projectCode ?? line?.projectNumber);
    const projectName = textOf(line?.projectName);
    const expenseItemCode = textOf(line?.expenseItemCode);
    const expenseItem = textOf(line?.expenseItemName);
    const invoiceType = textOf(line?.invoiceTypeLabel ?? line?.invoiceType);
    const date = dateOf(line?.date);
    const explicitEndDate = dateOf(line?.endDate ?? line?.checkOut);
    const endDate = explicitEndDate ?? (!accommodationLine(line) ? date : null);
    if (total === null) reasons.push(`任务第 ${index + 1} 行没有有效的价税合计预览`);
    if (!hasNet) reasons.push(`任务第 ${index + 1} 行缺少不含税金额来源（未知值也必须显式为 null）`);
    else if (line.netAmount !== null && net === null) reasons.push(`任务第 ${index + 1} 行的不含税金额预览无效`);
    if (!hasTax) reasons.push(`任务第 ${index + 1} 行缺少税额来源（未知值也必须显式为 null）`);
    else if (line.taxAmount !== null && tax === null) reasons.push(`任务第 ${index + 1} 行的税额预览无效`);
    if (kind !== 'rail_eticket' && (net === null || tax === null)) {
      reasons.push(`任务第 ${index + 1} 行不是铁路客票，却缺少票面不含税金额或税额；不能从收票替代票面事实`);
    }
    if (!voucherMaterialId) reasons.push(`任务第 ${index + 1} 行缺少 voucherMaterialId`);
    if (!projectCode || !projectName) reasons.push(`任务第 ${index + 1} 行缺少已核验的项目编码和完整名称`);
    if (!projectSourceConfirmed(line, expected)) reasons.push(`任务第 ${index + 1} 行的项目来源不是 project_book + erp_catalog_confirmed`);
    if (!expenseItemCode || !expenseItem) reasons.push(`任务第 ${index + 1} 行缺少完整的费用项目编码和名称`);
    if (!date) reasons.push(`任务第 ${index + 1} 行没有有效的费用日期预览`);
    if (!endDate) reasons.push(`任务第 ${index + 1} 行没有有效的结束日期预览`);
    if (!ERP_INVOICE_TYPES.has(invoiceType)) reasons.push(`任务第 ${index + 1} 行缺少有效 ERP 发票类型枚举`);
    if (!validInvoiceTypeSource(line?.invoiceTypeSource)) reasons.push(`任务第 ${index + 1} 行缺少发票类型映射出处`);
    return { index, voucherMaterialId, total, net, tax, projectName, expenseItem, date, endDate, invoiceType,
      groupKey: voucherMaterialId || `line-${index + 1}`, targetNet: null as number | null, targetTax: null as number | null };
  });

  type Item = (typeof expectedData)[number];
  const groups = new Map<string, { key: string; items: Item[] }>();
  for (const item of expectedData) {
    const group = groups.get(item.groupKey) ?? { key: item.groupKey, items: [] };
    group.items.push(item);
    groups.set(item.groupKey, group);
  }

  type ReceiptGroup = { group: { key: string; items: Item[] }; row: { values?: Record<string, string> } | null; actualGross?: number | null; actualNet?: number | null; actualTax?: number | null };
  const receiptGroups = new Map<string, ReceiptGroup>();
  const receiptRows = dataRowsOf(receiptsGrid);
  const receiptUsed = new Set<number>();
  const bindings = receiptBindingsOf(expected);
  const bindingByGroup = new Map<string, ReturnType<typeof normalizeReceiptBinding>>();
  const bindingInvoices = new Set<string>();
  const bindingReceipts = new Set<string>();
  if (receiptsGrid === null) reasons.push('没有提供收票网格，不能核对收票身份和三项金额守恒');
  if (!bindings.present) reasons.push('收票逐凭证核对缺少 expectedPreview.receiptBindings，不能用金额代替唯一身份');
  for (const binding of bindings.bindings) {
    if (!binding.valid) { reasons.push(`第 ${binding.index + 1} 条收票身份绑定缺少可信的 voucherMaterialId、发票号或收票号`); continue; }
    if (!groups.has(binding.voucherMaterialId)) { reasons.push(`收票身份绑定 ${binding.voucherMaterialId} 不在已确认明细预览中`); continue; }
    if (bindingByGroup.has(binding.voucherMaterialId)) { reasons.push(`任务凭证组 ${binding.voucherMaterialId} 有重复的收票身份绑定`); continue; }
    if (bindingInvoices.has(binding.invoiceNumber) || bindingReceipts.has(binding.receiptNumber!)) {
      reasons.push(`收票身份 ${binding.voucherMaterialId} 与另一凭证重复，不能安全核对`);
      continue;
    }
    bindingByGroup.set(binding.voucherMaterialId, binding);
    bindingInvoices.add(binding.invoiceNumber);
    bindingReceipts.add(binding.receiptNumber!);
  }
  for (const group of groups.values()) {
    if (!bindingByGroup.has(group.key)) reasons.push(`任务凭证组 ${group.key} 没有可信的发票号/收票号绑定，不能安全核对`);
  }
  const receiptColumns = [RECEIPTS_COLUMN, RECEIPT_NET_COLUMN, TAX_COLUMN, RECEIPT_NUMBER_COLUMN, INVOICE_NUMBER_COLUMN];
  const receiptsReadable = receiptsGrid?.ok === true;
  for (const column of receiptColumns) {
    if (receiptsReadable && !columnOf(receiptsGrid, column)) reasons.push(`收票网格没有「${column}」列，不能逐凭证核对`);
  }
  const identityColumnsReadable = receiptsReadable && receiptColumns.every((column) => columnOf(receiptsGrid, column));
  if (receiptsGrid !== null && !receiptsReadable) reasons.push('对应收票网格无法读取，不能核对各行身份和金额');

  for (const group of groups.values()) {
    const binding = bindingByGroup.get(group.key);
    if (!identityColumnsReadable || !binding) { receiptGroups.set(group.key, { group, row: null }); continue; }
    const candidates = receiptRows.filter((row, index) => {
      if (receiptUsed.has(index)) return false;
      const values = row.values ?? {};
      return receiptNumberOf(values[RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber && invoiceMatches(values[INVOICE_NUMBER_COLUMN], binding.invoiceNumber);
    });
    if (candidates.length !== 1) {
      const sameReceipt = receiptRows.filter((row, index) => !receiptUsed.has(index) && receiptNumberOf(row.values?.[RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber);
      reasons.push(candidates.length === 0 && sameReceipt.length
        ? `任务凭证组 ${group.key} 的收票号对应发票号与预览不一致`
        : candidates.length === 0
          ? `任务凭证组 ${group.key} 没有唯一对应的 ERP 收票行`
          : `任务凭证组 ${group.key} 对应多条 ERP 收票行，无法安全核对`);
      receiptGroups.set(group.key, { group, row: null });
      continue;
    }
    const row = candidates[0]!;
    receiptUsed.add(receiptRows.indexOf(row));
    const actualGross = amountOf(row.values?.[RECEIPTS_COLUMN]);
    const actualNet = amountOf(row.values?.[RECEIPT_NET_COLUMN]);
    const actualTax = amountOf(row.values?.[TAX_COLUMN]);
    const expectedGross = sumKnown(group.items.map((item) => item.total));
    if (actualGross === null || actualNet === null || actualTax === null) reasons.push(`任务凭证组 ${group.key} 的收票不含税金额、税额或价税合计不可读`);
    if (actualGross !== null && actualNet !== null && actualTax !== null && actualNet + actualTax !== actualGross) {
      reasons.push(`任务凭证组 ${group.key} 的收票不含税金额与税额不守恒`);
    }
    if (expectedGross === null || actualGross === null || expectedGross !== actualGross) reasons.push(`任务凭证组 ${group.key} 的收票价税合计与已确认预览不一致`);
    receiptGroups.set(group.key, { group, row, actualGross, actualNet, actualTax });
  }
  if (identityColumnsReadable) {
    for (const [index] of receiptRows.entries()) if (!receiptUsed.has(index)) reasons.push(`ERP 收票第 ${index + 1} 行没有对应的已确认任务凭证`);
  }

  for (const item of expectedData) {
    const receiptGroup = receiptGroups.get(item.groupKey);
    const singleLine = receiptGroup?.group.items.length === 1;
    const receipt = singleLine ? receiptGroup?.row : null;
    const receiptNet = receipt ? amountOf(receipt.values?.[RECEIPT_NET_COLUMN]) : null;
    const receiptTax = receipt ? amountOf(receipt.values?.[TAX_COLUMN]) : null;
    const targetNet = item.net ?? (singleLine ? receiptNet : null);
    const targetTax = item.tax ?? (singleLine ? receiptTax : null);
    amountSources.push({ line: item.index + 1,
      net: item.net === null ? (targetNet === null ? 'unknown' : 'erp_receipt') : 'expected_preview',
      tax: item.tax === null ? (targetTax === null ? 'unknown' : 'erp_receipt') : 'expected_preview' });
    if (item.net === null && targetNet === null) reasons.push(`任务第 ${item.index + 1} 行不含税金额在票面未知，且对应收票没有可读值；不从合计反推`);
    if (item.tax === null && targetTax === null) reasons.push(`任务第 ${item.index + 1} 行税额在票面未知，且对应收票没有可读值；不从合计反推`);
    item.targetNet = targetNet;
    item.targetTax = targetTax;
  }

  const detailColumns = [DETAIL_COLUMN, NET_COLUMN, TAX_COLUMN, PROJECT_COLUMN, EXPENSE_ITEM_COLUMN, START_DATE_COLUMN, END_DATE_COLUMN, DETAIL_RECEIPT_NUMBER_COLUMN, INVOICE_TYPE_COLUMN];
  for (const column of detailColumns) if (!columnOf(grid, column)) reasons.push(`明细网格没有「${column}」列，不能完整逐行核对`);
  const detailReadable = detailColumns.every((column) => columnOf(grid, column));
  const usedRows = new Set<number>();
  const matchedByGroup = new Map<string, Array<{ actualNet: number | null; actualTax: number | null; actualTotal: number | null }>>();
  for (const item of expectedData) {
    if (item.total === null || item.targetNet === null || item.targetTax === null) continue;
    const binding = bindingByGroup.get(item.groupKey);
    if (!detailReadable || !binding) continue;
    const candidates = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => {
      if (usedRows.has(index)) return false;
      const values = row.values ?? {};
      return amountOf(values[DETAIL_COLUMN]) === item.total
        && textOf(values[PROJECT_COLUMN]) === item.projectName
        && textOf(values[EXPENSE_ITEM_COLUMN]) === item.expenseItem
        && dateOf(values[START_DATE_COLUMN]) === item.date
        && dateOf(values[END_DATE_COLUMN]) === item.endDate
        && amountOf(values[NET_COLUMN]) === item.targetNet
        && amountOf(values[TAX_COLUMN]) === item.targetTax
        && receiptNumberOf(values[DETAIL_RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber
        && textOf(values[INVOICE_TYPE_COLUMN]) === item.invoiceType;
    });
    if (candidates.length !== 1) {
      reasons.push(candidates.length > 1
        ? `任务第 ${item.index + 1} 行有多条 ERP 明细满足相同字段，无法安全逐行对应`
        : `任务第 ${item.index + 1} 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的 ERP 明细；金额相等不能代替逐行一致`);
      continue;
    }
    const chosen = candidates[0]!;
    usedRows.add(chosen.index);
    const values = chosen.row.values ?? {};
    const matched = matchedByGroup.get(item.groupKey) ?? [];
    matched.push({ actualNet: amountOf(values[NET_COLUMN]), actualTax: amountOf(values[TAX_COLUMN]), actualTotal: amountOf(values[DETAIL_COLUMN]) });
    matchedByGroup.set(item.groupKey, matched);
  }
  if (detailReadable) {
    for (const [index] of rows.entries()) if (!usedRows.has(index)) reasons.push(`ERP 明细第 ${index + 1} 行没有对应的已确认任务明细`);
  }

  // Each receipt conserves net, tax and gross separately; a whole-form total is not enough.
  for (const [key, receiptGroup] of receiptGroups) {
    if (!receiptGroup.row) continue;
    const matched = matchedByGroup.get(key) ?? [];
    if (matched.length !== receiptGroup.group.items.length) continue;
    const detailNet = sumKnown(matched.map((line) => line.actualNet));
    const detailTax = sumKnown(matched.map((line) => line.actualTax));
    const detailGross = sumKnown(matched.map((line) => line.actualTotal));
    if (detailNet === null || detailTax === null || detailGross === null) { reasons.push(`任务凭证组 ${key} 的明细金额不可读，不能验证三项守恒`); continue; }
    if (detailNet !== receiptGroup.actualNet) reasons.push(`任务凭证组 ${key} 的明细不含税金额合计与对应收票不一致`);
    if (detailTax !== receiptGroup.actualTax) reasons.push(`任务凭证组 ${key} 的明细税额合计与对应收票不一致`);
    if (detailGross !== receiptGroup.actualGross) reasons.push(`任务凭证组 ${key} 的明细价税合计与对应收票不一致`);
  }

  return { ok: reasons.length === 0, reasons, amountSources };
}

/** Strict read-back of a whole form against the approved preview: the verdict the server returns to the executor. */
export function judgeReadings(readings: Readings, preview: unknown) {
  return matchTaskLines(readings.detailGrid as GridLike, preview, readings.receiptsGrid as GridLike);
}
