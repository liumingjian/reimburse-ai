const MONEY = /^\d+(?:\.\d{1,2})?$/;
const SAFE_RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const text = (value) => value === null || value === undefined || String(value).trim() === ''
  ? null : String(value).trim();

const amount = (value) => {
  const normalized = text(value)?.replace(/[¥￥,\s]/g, '') ?? null;
  if (!normalized || !MONEY.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : null;
};

const invoiceNumber = (value) => text(value)?.replace(/\s+/g, '') ?? null;

const invoiceMatches = (full, observed) => {
  const value = invoiceNumber(observed);
  if (!full || !value) return false;
  if (value === full) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(value);
  return !!masked && full.startsWith(masked[1]) && full.endsWith(masked[2]);
};

const invoiceOf = (invoice) => {
  const identity = invoice?.identity;
  const number = text(identity?.number ?? invoice?.fields?.invoiceNumber);
  const identityKey = text(identity?.key);
  return /^einvoice-20:\d{20}$/.test(identityKey ?? '')
    && /^\d{20}$/.test(number ?? '') && identityKey === `einvoice-20:${number}`
    ? { invoiceNumber: number, identityKey }
    : null;
};

const problem = (code, message, extra = {}) => ({ code, message, ...extra });

/**
 * Turn the fresh receipt grid into the two contracts consumed by the strict
 * draft builder. Unknown, duplicate, masked-but-not-unique, or non-conserved
 * rows are all rejected; an amount match alone is never enough to bind a row.
 */
export function buildReceiptReadback({
  grid,
  invoices = [],
  taskId,
  versionId,
  identity,
  readAt = new Date().toISOString(),
} = {}) {
  const problems = [];
  const expected = invoices.map((invoice) => ({
    materialId: text(invoice?.materialId),
    ...invoiceOf(invoice),
  })).filter((invoice) => invoice.materialId && invoice.invoiceNumber && invoice.identityKey);
  if (expected.length !== invoices.length) {
    problems.push(problem('invoice_identity_missing', '准备包中存在缺少完整 20 位发票身份的主要凭证'));
  }
  if (grid?.ok !== true) {
    problems.push(problem('receipt_grid_unreadable', grid?.reason ?? 'ERP 收票网格不可读'));
    return { ok: false, problems, receiptCheck: null, receiptReadback: null };
  }
  const rows = Array.isArray(grid.rows) ? grid.rows.filter((row) => row.kind === 'data') : [];
  if (rows.length !== expected.length) {
    problems.push(problem('receipt_row_count_mismatch',
      `ERP 收票行数 ${rows.length} 与当前主要发票数 ${expected.length} 不一致`));
  }

  const used = new Set();
  const facts = [];
  for (const [index, row] of rows.entries()) {
    const values = row?.values ?? {};
    const hits = expected.filter((invoice) => invoiceMatches(invoice.invoiceNumber, values['发票号码']));
    if (hits.length !== 1) {
      problems.push(problem(hits.length === 0 ? 'receipt_invoice_unmatched' : 'receipt_invoice_ambiguous',
        `ERP 收票第 ${index + 1} 行无法唯一对应当前主要发票`, { row: index + 1 }));
      continue;
    }
    const [matched] = hits;
    if (used.has(matched.materialId)) {
      problems.push(problem('receipt_invoice_duplicate',
        `ERP 收票重复对应主要凭证 ${matched.materialId}`, { row: index + 1 }));
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
    if ([netAmount, taxAmount, grossAmount].some((value) => value === null)) {
      problems.push(problem('receipt_amount_missing', `ERP 收票第 ${index + 1} 行缺少不含税金额、税额或价税合计`));
    } else if (Number((Number(netAmount) + Number(taxAmount)).toFixed(2)) !== Number(grossAmount)) {
      problems.push(problem('receipt_amount_not_conserved', `ERP 收票第 ${index + 1} 行的金额不守恒`));
    }
    facts.push({
      voucherMaterialId: matched.materialId,
      identityKey: matched.identityKey,
      invoiceNumber: matched.invoiceNumber,
      receiptNumber,
      grossAmount,
      netAmount,
      taxAmount,
      source: 'erp_receipt',
    });
  }
  for (const expectedInvoice of expected) {
    if (!used.has(expectedInvoice.materialId)) {
      problems.push(problem('receipt_binding_missing',
        `主要凭证 ${expectedInvoice.materialId} 没有对应 ERP 收票行`));
    }
  }
  const receiptNumbers = facts.map((fact) => fact.receiptNumber).filter(Boolean);
  if (new Set(receiptNumbers).size !== receiptNumbers.length) {
    problems.push(problem('receipt_number_duplicate', 'ERP 收票号不唯一'));
  }
  if (problems.length) return { ok: false, problems, receiptCheck: null, receiptReadback: null };

  const receiptCheck = {
    taskId: taskId ?? null,
    versionId: versionId ?? null,
    identity: identity ?? null,
    fresh: true,
    readAt,
    checks: facts.map((fact) => ({
      materialId: fact.voucherMaterialId,
      identityKey: fact.identityKey,
      ok: true,
      rows: [[fact.receiptNumber, '', '', fact.grossAmount]],
    })),
  };
  const receiptReadback = {
    taskId: taskId ?? null,
    versionId: versionId ?? null,
    identity: identity ?? null,
    fresh: true,
    readAt,
    rows: facts,
  };
  return { ok: true, problems: [], receiptCheck, receiptReadback };
}
