import { buildErpWritePreview, erpWritePreviewDigest, previewLinesDigest } from './erp-write-preview.mjs';
import { approvalCovers } from './erpwrite.mjs';
import { readReconciliation } from './erpreconcile.mjs';
import {
  leaveEdit, selectOption, writeCell, writeHeader,
} from './erpform-ego.mjs';

// This module is the narrow boundary between a complete local preview and an
// ERP draft. It never imports the CLI, never creates an approval, and never
// retries a save. Browser actions are injected at the save boundary so the
// caller has to make the one authorized save explicit.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INVOICE = /^einvoice-20:(\d{20})$/;
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他']);

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const amountText = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[¥￥,\s]/g, '');
  return MONEY.test(normalized) ? normalized : null;
};
const cents = (value) => {
  const normalized = amountText(value);
  if (normalized === null) return null;
  const [whole, fraction = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const validDate = (value) => {
  const match = DATE.exec(text(value) ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const erpDate = (value) => {
  const match = DATE.exec(text(value) ?? '');
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : null;
};
const sameIdentity = (left, right) => !!left && !!right
  && left.account === right.account && left.tenant === right.tenant;
const validInvoiceTypeSource = (value) => {
  const source = text(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};
const issue = (problems, code, message, extra = {}) => problems.push({ code, message, ...extra });
const dataRows = (grid) => grid?.ok === true && Array.isArray(grid.rows)
  ? grid.rows.filter((row) => row.kind === 'data') : [];
const hasColumn = (grid, label) => grid?.columns?.some((column) => column.label === label) === true;

const requiresRoute = (line) => text(line?.kind) === 'rail_eticket'
  || text(line?.kind) === 'passenger_transport';

/**
 * Routes are facts, not display strings to be split on whitespace. An arrow
 * is accepted only when it gives exactly two non-empty endpoints; otherwise
 * the source must provide explicit origin/destination fields.
 */
export const routePlanOf = (line, event = null) => {
  const direct = [
    [line?.origin, line?.destination, line?.routeSource],
    [event?.origin, event?.destination, event?.routeSource],
    [line?.routePlan?.origin, line?.routePlan?.destination, line?.routePlan?.source],
    [event?.routePlan?.origin, event?.routePlan?.destination, event?.routePlan?.source],
  ];
  for (const [origin, destination, source] of direct) {
    if (text(origin) && text(destination)) {
      return { origin: text(origin), destination: text(destination), source: text(source) ?? 'confirmed_candidate' };
    }
  }
  const route = text(line?.route ?? event?.route);
  if (!route) return null;
  const parts = route.split('→').map((part) => part.trim());
  return parts.length === 2 && parts.every(Boolean)
    ? { origin: parts[0], destination: parts[1], source: 'confirmed_route_arrow' }
    : null;
};

const gateProblems = (gate, preview) => {
  const problems = [];
  if (!gate || typeof gate !== 'object') {
    issue(problems, 'fresh_gate_missing', '缺少当前 ERP 身份与任务范围的 fresh gate');
    return problems;
  }
  if (gate.status !== 'matched') issue(problems, 'fresh_gate_not_matched', 'ERP 当前身份没有 matched');
  if (gate.fresh !== true) issue(problems, 'fresh_gate_not_fresh', 'ERP 身份/范围 gate 不是本次 fresh 核验');
  if (!sameIdentity(gate.identity, preview.identity)) {
    issue(problems, 'fresh_gate_identity_mismatch', 'fresh gate 身份与预览身份不一致');
  }
  if (gate.taskId !== preview.taskId) issue(problems, 'fresh_gate_task_mismatch', 'fresh gate 不属于当前任务');
  if (gate.versionId !== preview.versionId) issue(problems, 'fresh_gate_version_mismatch', 'fresh gate 不属于当前事件版本');
  const scope = gate.scope;
  if (!scope || scope.taskId !== preview.taskId || scope.versionId !== preview.versionId
      || !sameIdentity(scope.identity, preview.identity)) {
    issue(problems, 'fresh_gate_scope_mismatch', 'fresh gate 缺少当前任务、版本和身份的完整范围');
  }
  return problems;
};

const invoiceOf = (binding) => {
  const identity = INVOICE.exec(text(binding?.identityKey) ?? '');
  const invoiceNumber = text(binding?.invoiceNumber);
  return identity && invoiceNumber === identity[1] ? invoiceNumber : null;
};

const normalizeReceiptRow = (row, index) => {
  const identityKey = text(row?.identityKey ?? row?.invoiceIdentityKey);
  const invoiceNumber = invoiceOf({ identityKey, invoiceNumber: row?.invoiceNumber });
  return {
    index,
    voucherMaterialId: text(row?.voucherMaterialId),
    identityKey,
    invoiceNumber,
    receiptNumber: text(row?.receiptNumber ?? row?.receiptNo),
    grossAmount: amountText(row?.grossAmount),
    netAmount: amountText(row?.netAmount),
    taxAmount: amountText(row?.taxAmount),
    source: text(row?.source),
  };
};

const receiptFactsOf = (receiptReadback, preview, problems) => {
  if (!receiptReadback || receiptReadback.fresh !== true) {
    issue(problems, 'receipt_readback_not_fresh', '缺少本次 fresh ERP 收票逐票回读');
    return new Map();
  }
  if (receiptReadback.taskId !== preview.taskId) {
    issue(problems, 'receipt_readback_task_mismatch', 'ERP 收票回读不属于当前任务');
  }
  if (receiptReadback.versionId !== preview.versionId) {
    issue(problems, 'receipt_readback_version_mismatch', 'ERP 收票回读不属于当前事件版本');
  }
  if (!sameIdentity(receiptReadback.identity, preview.identity)) {
    issue(problems, 'receipt_readback_identity_mismatch', 'ERP 收票回读身份与预览不一致');
  }
  const rows = Array.isArray(receiptReadback.rows) ? receiptReadback.rows : null;
  if (!rows) {
    issue(problems, 'receipt_readback_missing', 'ERP 收票回读缺少逐票 rows');
    return new Map();
  }
  const facts = new Map();
  for (const [index, raw] of rows.entries()) {
    const row = normalizeReceiptRow(raw, index);
    if (!row.voucherMaterialId || !row.identityKey || !row.invoiceNumber
        || !row.receiptNumber || !RECEIPT.test(row.receiptNumber)) {
      issue(problems, 'receipt_readback_identity_invalid', `第 ${index + 1} 条 ERP 收票回读身份不完整`);
      continue;
    }
    if (row.grossAmount === null || row.netAmount === null || row.taxAmount === null) {
      issue(problems, 'receipt_readback_amount_missing', `收票 ${row.voucherMaterialId} 缺少 fresh 不含税/税额/价税合计`);
      continue;
    }
    if (cents(row.netAmount) + cents(row.taxAmount) !== cents(row.grossAmount)) {
      issue(problems, 'receipt_readback_not_conserved', `收票 ${row.voucherMaterialId} 的净额、税额和价税合计不守恒`);
    }
    if (row.source !== 'erp_receipt') {
      issue(problems, 'receipt_readback_source_invalid', `收票 ${row.voucherMaterialId} 的净税值没有标记 ERP 来源`);
    }
    if (facts.has(row.voucherMaterialId)) {
      issue(problems, 'receipt_readback_duplicate', `ERP 收票回读凭证 ${row.voucherMaterialId} 重复`);
      continue;
    }
    facts.set(row.voucherMaterialId, row);
  }
  return facts;
};

const previewReceiptMap = (preview) => new Map(
  (preview.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding]),
);

const fieldPlanOf = (preview) => ({
  header: [{ key: 'FCAUSA', value: preview.purpose, source: 'selection.purpose' }],
  order: ['项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地',
    '出发地', '目的地', '费用金额', '税额'],
  details: preview.lines.map((line, row) => {
    const fields = [
      { column: '项目', value: line.projectCode, readback: line.projectName, source: 'erp_catalog_confirmed' },
      { column: '费用项目', value: line.expenseItemCode, readback: line.expenseItemName, source: 'erp_catalog_confirmed' },
      { column: '发票类型', option: line.invoiceType, readback: line.invoiceType, source: line.invoiceTypeSource },
      { column: '开始日期', value: erpDate(line.date), readback: erpDate(line.date), source: 'line.date' },
      { column: '结束日期', value: erpDate(line.endDate), readback: erpDate(line.endDate), source: line.endDateSource },
    ];
    if (text(line.city)) fields.push({ column: '住宿/出差地', value: line.city, readback: line.city, source: 'line.city' });
    if (line.routePlan) {
      fields.push({ column: '出发地', value: line.routePlan.origin, readback: line.routePlan.origin, source: line.routePlan.source });
      fields.push({ column: '目的地', value: line.routePlan.destination, readback: line.routePlan.destination, source: line.routePlan.source });
    }
    fields.push(
      { column: '费用金额', value: line.netAmount, readback: line.netAmount, source: line.netAmountSource },
      { column: '税额', value: line.taxAmount, readback: line.taxAmount, source: line.taxAmountSource },
    );
    return { lineId: line.lineId, row, voucherMaterialId: line.voucherMaterialId, fields };
  }),
});

/**
 * Build the only preview that the fill/save functions accept. The receipt
 * readback is deliberately separate from the persisted receipt check: a
 * gross-only check cannot manufacture the railway net/tax values.
 */
export function buildErpDraftPreview(args = {}) {
  const base = buildErpWritePreview(args);
  const problems = [...(base.problems ?? [])];
  if (!base.ready) return { ready: false, expectedPreview: null, fieldPlan: null, problems };
  const preview = structuredClone(base.expectedPreview);
  problems.push(...gateProblems(args.freshGate, preview));
  if (!args.catalog?.versionId || args.catalog.versionId !== preview.versionId) {
    issue(problems, 'catalog_not_fresh', 'ERP 项目目录核验缺少当前事件版本');
  }
  if (!args.catalog?.linesDigest || args.catalog.linesDigest !== previewLinesDigest(args.built)) {
    issue(problems, 'catalog_scope_not_fresh', 'ERP 项目目录核验缺少当前明细范围指纹');
  }
  if (!sameIdentity(args.catalog?.identity, preview.identity)) {
    issue(problems, 'catalog_identity_not_fresh', 'ERP 项目目录核验身份与当前任务不一致');
  }
  const facts = receiptFactsOf(args.receiptReadback, preview, problems);
  const bindingByMaterial = previewReceiptMap(preview);
  const eventById = new Map((args.built?.events ?? []).map((event) => [event.eventId, event]));
  const linesByMaterial = new Map();
  for (const line of preview.lines) {
    const routePlan = routePlanOf(line, eventById.get(line.eventId));
    if (requiresRoute(line) && !routePlan) {
      issue(problems, 'route_structure_missing', `明细 ${line.lineId} 缺少可核实的起点和终点；不按空格猜路线`);
    }
    if (routePlan) line.routePlan = routePlan;
    if (!validDate(line.date) || !validDate(line.endDate)) {
      issue(problems, 'date_plan_invalid', `明细 ${line.lineId} 的 ERP 开始/结束日期不可核实`);
    }
    if (!ERP_INVOICE_TYPES.has(text(line.invoiceType)) || !text(line.invoiceTypeSource)) {
      issue(problems, 'invoice_type_mapping_missing', `明细 ${line.lineId} 缺少有出处的 ERP 发票类型映射`);
    }
    const group = linesByMaterial.get(line.voucherMaterialId) ?? [];
    group.push(line);
    linesByMaterial.set(line.voucherMaterialId, group);
  }

  for (const [materialId, lines] of linesByMaterial) {
    const fact = facts.get(materialId);
    const binding = bindingByMaterial.get(materialId);
    if (!fact) {
      issue(problems, 'receipt_readback_binding_missing', `明细凭证 ${materialId} 没有对应 fresh ERP 收票身份`);
      continue;
    }
    if (!binding || fact.identityKey !== binding.identityKey
        || fact.invoiceNumber !== binding.invoiceNumber || fact.receiptNumber !== binding.receiptNumber
        || cents(fact.grossAmount) !== cents(binding.grossAmount)) {
      issue(problems, 'receipt_readback_identity_mismatch', `明细凭证 ${materialId} 的收票身份不是预览绑定的同一张票`);
      continue;
    }
    const gross = lines.reduce((sum, line) => sum + (cents(line.totalAmount) ?? 0), 0);
    if (gross !== cents(fact.grossAmount)) {
      issue(problems, 'receipt_line_gross_mismatch', `凭证 ${materialId} 的明细价税合计与 ERP 收票不一致`);
    }
    const unknownNet = lines.filter((line) => line.netAmount === null);
    const unknownTax = lines.filter((line) => line.taxAmount === null);
    if (unknownNet.length > 0 || unknownTax.length > 0) {
      if (lines.length !== 1 || unknownNet.length !== 1 || unknownTax.length !== 1) {
        issue(problems, 'receipt_unknown_split', `凭证 ${materialId} 的未知净税无法唯一对应到一条明细`);
      } else {
        const line = lines[0];
        line.netAmount = fact.netAmount;
        line.taxAmount = fact.taxAmount;
        line.netAmountSource = 'erp_receipt';
        line.taxAmountSource = 'erp_receipt';
      }
    }
    const net = lines.reduce((sum, line) => sum + (cents(line.netAmount) ?? 0), 0);
    const tax = lines.reduce((sum, line) => sum + (cents(line.taxAmount) ?? 0), 0);
    if (lines.some((line) => line.netAmount === null || line.taxAmount === null)) continue;
    if (net !== cents(fact.netAmount)) issue(problems, 'receipt_line_net_mismatch', `凭证 ${materialId} 的明细不含税金额与 ERP 收票不一致`);
    if (tax !== cents(fact.taxAmount)) issue(problems, 'receipt_line_tax_mismatch', `凭证 ${materialId} 的明细税额与 ERP 收票不一致`);
    binding.netAmount = fact.netAmount;
    binding.taxAmount = fact.taxAmount;
    binding.netAmountSource = 'erp_receipt';
    binding.taxAmountSource = 'erp_receipt';
  }
  for (const materialId of facts.keys()) {
    if (!linesByMaterial.has(materialId)) issue(problems, 'receipt_readback_extra', `ERP 收票 ${materialId} 不在当前预览中`);
  }
  if (problems.length) return { ready: false, expectedPreview: null, fieldPlan: null, problems };
  preview.fieldPlan = fieldPlanOf(preview);
  preview.previewDigest = erpWritePreviewDigest(preview);
  return {
    ready: true,
    expectedPreview: preview,
    fieldPlan: preview.fieldPlan,
    receiptReadback: [...facts.values()],
    problems: [],
  };
}

const completePreviewProblems = (preview) => {
  const problems = [];
  if (!preview || typeof preview !== 'object') return [{ code: 'preview_missing', message: '缺少完整 ERP 草稿预览' }];
  if (preview.previewDigest !== erpWritePreviewDigest(preview)) {
    issue(problems, 'preview_digest_mismatch', '草稿预览已被修改，摘要与内容不一致');
  }
  if (preview.projectSource !== 'erp_catalog_confirmed' || preview.projectsFrom !== 'project_book') {
    issue(problems, 'preview_project_source_invalid', '预览项目来源不是 ERP 已核验的本人 project_book');
  }
  if (!Array.isArray(preview.lines) || !preview.lines.length) issue(problems, 'preview_lines_missing', '预览没有明细');
  const bindings = new Map((preview.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding]));
  for (const line of preview.lines ?? []) {
    if (!text(line.projectCode) || !text(line.projectName)) issue(problems, 'preview_project_missing', `明细 ${line.lineId} 缺少完整项目`);
    if (!text(line.expenseItemCode) || !text(line.expenseItemName)) issue(problems, 'preview_expense_missing', `明细 ${line.lineId} 缺少完整费用项目`);
    if (!ERP_INVOICE_TYPES.has(text(line.invoiceType)) || !validInvoiceTypeSource(line.invoiceTypeSource)) issue(problems, 'preview_invoice_type_missing', `明细 ${line.lineId} 缺少有出处票种`);
    if (!validDate(line.date) || !validDate(line.endDate)) issue(problems, 'preview_date_missing', `明细 ${line.lineId} 缺少有效开始/结束日期`);
    if (cents(line.netAmount) === null || cents(line.taxAmount) === null || cents(line.totalAmount) === null) {
      issue(problems, 'preview_amount_missing', `明细 ${line.lineId} 缺少最终净额、税额或价税合计`);
    }
    if (requiresRoute(line) && (!text(line.routePlan?.origin) || !text(line.routePlan?.destination))) {
      issue(problems, 'preview_route_missing', `明细 ${line.lineId} 缺少起终点结构`);
    }
    if (!bindings.has(line.voucherMaterialId)) issue(problems, 'preview_receipt_missing', `明细 ${line.lineId} 缺少收票绑定`);
  }
  const receiptBindings = Array.isArray(preview.receiptBindings) ? preview.receiptBindings : [];
  if (!receiptBindings.length) issue(problems, 'preview_receipts_missing', '预览没有逐票收票绑定');
  const seenMaterials = new Set();
  const seenInvoices = new Set();
  const seenReceipts = new Set();
  for (const binding of receiptBindings) {
    const invoiceNumber = invoiceOf(binding);
    const receiptNumber = text(binding.receiptNumber);
    if (!text(binding.voucherMaterialId) || !invoiceNumber || !receiptNumber || !RECEIPT.test(receiptNumber)) {
      issue(problems, 'preview_receipt_identity_missing', `收票 ${binding.voucherMaterialId ?? '?'} 缺少合法发票身份或收票号`);
    }
    if (seenMaterials.has(binding.voucherMaterialId)) issue(problems, 'preview_receipt_identity_duplicate', `收票材料 ${binding.voucherMaterialId} 重复`);
    if (invoiceNumber && seenInvoices.has(invoiceNumber)) issue(problems, 'preview_receipt_identity_duplicate', `发票号 ${invoiceNumber} 重复`);
    if (receiptNumber && seenReceipts.has(receiptNumber)) issue(problems, 'preview_receipt_identity_duplicate', `收票号 ${receiptNumber} 重复`);
    seenMaterials.add(binding.voucherMaterialId);
    if (invoiceNumber) seenInvoices.add(invoiceNumber);
    if (receiptNumber) seenReceipts.add(receiptNumber);
    if (cents(binding.netAmount) === null || cents(binding.taxAmount) === null) {
      issue(problems, 'preview_receipt_amount_missing', `收票 ${binding.voucherMaterialId} 缺少净税金额`);
    }
    if (binding.netAmountSource !== 'erp_receipt' || binding.taxAmountSource !== 'erp_receipt') {
      issue(problems, 'preview_receipt_source_missing', `收票 ${binding.voucherMaterialId} 缺少 ERP 净税来源`);
    }
  }
  return problems;
};

const gateAndApprovalProblems = (preview, gate, approval) => [
  ...completePreviewProblems(preview),
  ...gateProblems(gate, preview ?? {}),
  ...(approvalCovers(approval, preview) ? [] : [{
    code: 'approval_missing_or_stale', message: '批准记录没有覆盖这份完整预览',
  }]),
];

const invoiceMatches = (actual, expected) => {
  const actualText = text(actual)?.replace(/\s+/g, '') ?? '';
  if (actualText === expected) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(actualText);
  return !!masked && expected.startsWith(masked[1]) && expected.endsWith(masked[2]);
};

/** Match the current ERP receipt grid by identity and all three amounts. */
export function matchReceiptRows(grid, preview) {
  const reasons = [];
  if (!grid?.ok) return { ok: false, reasons: [grid?.reason ?? '收票网格不可读'], rowsByMaterial: new Map() };
  const required = ['收票单', '发票号码', '不含税金额', '税额', '价税合计'];
  for (const column of required) if (!hasColumn(grid, column)) reasons.push(`收票网格缺少「${column}」列`);
  const bindings = Array.isArray(preview?.receiptBindings) ? preview.receiptBindings : [];
  if (bindings.length === 0) {
    reasons.push('预览没有逐票收票身份绑定');
  }
  const rows = dataRows(grid);
  if (rows.length !== bindings.length) reasons.push(`ERP 收票实际 ${rows.length} 行，预览要求 ${bindings.length} 行`);
  const used = new Set();
  const rowsByMaterial = new Map();
  for (const binding of bindings) {
    if (!text(binding?.voucherMaterialId) || !invoiceOf(binding) || !text(binding?.receiptNumber)) {
      reasons.push(`收票 ${binding?.voucherMaterialId ?? '?'} 缺少合法发票号和收票号`);
      continue;
    }
    const candidates = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => {
      if (used.has(index)) return false;
      const values = row.values ?? {};
      return text(values['收票单']) === binding.receiptNumber
        && invoiceMatches(values['发票号码'], binding.invoiceNumber);
    });
    if (candidates.length !== 1) {
      reasons.push(`收票 ${binding.voucherMaterialId} 没有唯一匹配的发票号和收票号`);
      continue;
    }
    const { row, index } = candidates[0];
    used.add(index);
    const values = row.values ?? {};
    for (const [column, expected] of [['不含税金额', binding.netAmount], ['税额', binding.taxAmount], ['价税合计', binding.grossAmount]]) {
      if (cents(values[column]) !== cents(expected)) reasons.push(`收票 ${binding.voucherMaterialId} 的「${column}」与预览不一致`);
    }
    rowsByMaterial.set(binding.voucherMaterialId, { row, index });
  }
  for (const [index] of rows.entries()) if (!used.has(index)) reasons.push(`ERP 收票第 ${index + 1} 行没有预览身份绑定`);
  return { ok: reasons.length === 0, reasons, rowsByMaterial };
}

const isEmptyDetailRow = (row) => {
  const values = row?.values ?? {};
  return ['项目', '费用项目', '费用金额', '税额', '申请报销金额', '收票单号']
    .every((column) => !text(values[column]));
};

const detailRowsForFill = (grid, preview) => {
  const reasons = [];
  if (!grid?.ok) return { ok: false, reasons: [grid?.reason ?? '明细网格不可读'], rowByMaterial: new Map(), placeholders: [] };
  const rows = dataRows(grid);
  const bindingByReceipt = new Map((preview.receiptBindings ?? []).map((binding) => [binding.receiptNumber, binding]));
  const rowByMaterial = new Map();
  const placeholders = [];
  for (const [index, row] of rows.entries()) {
    const receiptNumber = text(row.values?.['收票单号']);
    if (!receiptNumber) {
      if (isEmptyDetailRow(row)) placeholders.push(index);
      else reasons.push(`ERP 明细第 ${index + 1} 行没有收票身份，不能靠金额定位`);
      continue;
    }
    const binding = bindingByReceipt.get(receiptNumber);
    if (!binding) {
      reasons.push(`ERP 明细第 ${index + 1} 行的收票单号不在预览中`);
      continue;
    }
    if (rowByMaterial.has(binding.voucherMaterialId)) reasons.push(`ERP 明细凭证 ${binding.voucherMaterialId} 重复`);
    rowByMaterial.set(binding.voucherMaterialId, index);
  }
  return { ok: reasons.length === 0, reasons, rowByMaterial, placeholders };
};

const formTokenOf = (readings) => JSON.stringify({
  mode: readings?.formMode?.value ?? null,
  billNo: readings?.billNo?.value ?? null,
  receipts: dataRows(readings?.receiptsGrid).map((row) => [
    text(row.values?.['收票单']), text(row.values?.['发票号码']),
  ]).sort(),
});

export const formReadbackToken = formTokenOf;

const currentReaderOf = (page, readCurrent) => readCurrent
  ?? ((expectedPreview = null) => readReconciliation(page, { expectedPreview }));

const fail = (phase, problems, extra = {}) => ({ ok: false, phase, problems, ...extra });

/**
 * Fill an approved preview. The first read is a no-write preflight: exactly
 * one new tab, empty bill number, exact receipt identities, and no unlocated
 * detail rows. A missing addRow adapter is a visible blocker rather than a
 * guessed toolbar click.
 */
export async function fillApprovedPreview(page, {
  approvedPreview,
  approval,
  freshGate,
  readCurrent = null,
  addRow = null,
  writeDeps = {},
  ops = {},
} = {}) {
  const problems = gateAndApprovalProblems(approvedPreview, freshGate, approval);
  if (problems.length) return fail('preflight', problems);
  const read = currentReaderOf(page, readCurrent);
  let readings;
  try { readings = await read(null); } catch (error) {
    return fail('preflight', [{ code: error.code ?? 'read_failed', message: error.message }]);
  }
  if (readings.formMode?.value !== 'new') {
    problems.push({ code: 'new_form_required', message: '只有唯一的费用报销单-新增页签允许填充' });
  }
  if (readings.billNo?.readable !== true || readings.billNo.value !== null) {
    problems.push({ code: 'empty_bill_required', message: '新增单单据编号必须可读且为空' });
  }
  const receiptMatch = matchReceiptRows(readings.receiptsGrid, approvedPreview);
  problems.push(...receiptMatch.reasons.map((message) => ({ code: 'receipt_preflight_failed', message })));
  const detail = detailRowsForFill(readings.detailGrid, approvedPreview);
  problems.push(...detail.reasons.map((message) => ({ code: 'detail_preflight_failed', message })));
  if (problems.length) return fail('preflight', problems, { readings });

  const writeHeaderOp = ops.writeHeader ?? writeHeader;
  const writeCellOp = ops.writeCell ?? writeCell;
  const selectOptionOp = ops.selectOption ?? selectOption;
  const leaveEditOp = ops.leaveEdit ?? leaveEdit;
  const header = await writeHeaderOp(page, 'FCAUSA', approvedPreview.purpose, {}, writeDeps);
  if (!header?.ok) return fail('fill', [{ code: 'header_write_failed', message: header?.reason ?? '事由回读失败' }], { readings });

  const rowByMaterial = new Map(detail.rowByMaterial);
  const placeholders = [...detail.placeholders];
  const rowsWritten = [];
  for (const line of approvedPreview.lines) {
    let rowIndex = rowByMaterial.get(line.voucherMaterialId);
    if (rowIndex === undefined && placeholders.length) rowIndex = placeholders.shift();
    if (rowIndex === undefined) {
      if (typeof addRow !== 'function') {
        return fail('fill', [{ code: 'add_row_adapter_required', message: `明细 ${line.lineId} 需要新增行，但没有受控 ego addRow 适配器` }], { readings, rowsWritten });
      }
      const previousRowCount = dataRows(readings.detailGrid).length;
      let added;
      try { added = await addRow(page, { line, current: readings }); } catch (error) {
        return fail('fill', [{ code: error.code ?? 'add_row_failed', message: error.message }], { readings, rowsWritten });
      }
      if (added?.ok === false || added === false) {
        return fail('fill', [{ code: 'add_row_failed', message: added?.reason ?? '新增明细行未确认' }], { readings, rowsWritten });
      }
      readings = await read(null);
      const currentRows = dataRows(readings.detailGrid);
      if (currentRows.length !== previousRowCount + 1) {
        return fail('fill', [{ code: 'add_row_not_observed', message: '新增明细行没有在只读回读中出现' }], { readings, rowsWritten });
      }
      rowIndex = currentRows.length - 1;
    }
    const plan = approvedPreview.fieldPlan.details.find((candidate) => candidate.lineId === line.lineId)
      ?? fieldPlanOf(approvedPreview).details.find((candidate) => candidate.lineId === line.lineId);
    const beforeRow = dataRows(readings.detailGrid)[rowIndex];
    const currentTax = cents(beforeRow?.values?.['税额']);
    if (currentTax !== null && currentTax !== 0) {
      const cleared = await writeCellOp(page, { which: 0, row: rowIndex, column: '税额', value: '0.00', expect: null }, writeDeps);
      if (!cleared?.ok) return fail('fill', [{ code: 'tax_clear_failed', message: cleared?.reason ?? '写入前清空旧税额失败' }], { readings, rowsWritten });
    }
    for (const field of plan.fields) {
      let result;
      if (field.option) {
        result = await selectOptionOp(page, { which: 0, row: rowIndex, column: field.column, option: field.option }, writeDeps);
      } else {
        result = await writeCellOp(page, {
          which: 0, row: rowIndex, column: field.column, value: field.value,
          expect: { mode: 'equals', value: field.readback },
        }, writeDeps);
      }
      if (!result?.ok) {
        return fail('fill', [{ code: 'field_write_failed', message: result?.reason ?? `字段 ${field.column} 回读失败`, lineId: line.lineId, column: field.column }], { readings, rowsWritten });
      }
    }
    rowsWritten.push({ lineId: line.lineId, rowIndex });
  }
  const left = await leaveEditOp(page, { label: '明细信息' }, writeDeps);
  if (!left?.ok || left.stillEditing === true) {
    return fail('fill', [{ code: 'leave_edit_failed', message: left?.reason ?? '明细仍在编辑态' }], { readings, rowsWritten });
  }
  const after = await read(approvedPreview);
  const afterReceipts = matchReceiptRows(after.receiptsGrid, approvedPreview);
  if (!after.taskMatch?.ok || !afterReceipts.ok) {
    return fail('fill', [{ code: 'strict_readback_failed', message: '填充后严格逐行回读或收票身份核对未通过', reasons: [
      ...(after.taskMatch?.reasons ?? []), ...afterReceipts.reasons,
    ] }], { readings: after, rowsWritten });
  }
  return {
    ok: true,
    phase: 'filled',
    previewDigest: approvedPreview.previewDigest,
    formToken: formTokenOf(readings),
    rowsWritten,
    readings: after,
  };
}

/** Save exactly once after fill readback and same-form revalidation. */
export async function saveApprovedPreview(page, {
  approvedPreview,
  approval,
  freshGate,
  fillResult,
  readCurrent = null,
  save = null,
} = {}) {
  const problems = gateAndApprovalProblems(approvedPreview, freshGate, approval);
  if (!fillResult?.ok || fillResult.previewDigest !== approvedPreview?.previewDigest) {
    problems.push({ code: 'fill_result_missing', message: '没有同一完整预览的成功填充回读' });
  }
  if (problems.length) return { ok: false, status: 'blocked', saveAttempts: 0, problems };
  if (typeof save !== 'function') {
    return { ok: false, status: 'blocked', saveAttempts: 0,
      problems: [{ code: 'save_adapter_required', message: '保存动作必须由受控 ego save 适配器显式提供' }] };
  }
  const read = currentReaderOf(page, readCurrent);
  let before;
  try { before = await read(approvedPreview); } catch (error) {
    return { ok: false, status: 'unknown', saveAttempts: 0,
      problems: [{ code: error.code ?? 'pre_save_read_failed', message: error.message }] };
  }
  if (formTokenOf(before) !== fillResult.formToken || before.formMode?.value !== 'new'
      || before.billNo?.value !== null || !before.taskMatch?.ok
      || !matchReceiptRows(before.receiptsGrid, approvedPreview).ok) {
    return { ok: false, status: 'blocked', saveAttempts: 0,
      problems: [{ code: 'same_form_precondition_failed', message: '填充后当前页已不是同一张新增空号单，未保存' }] };
  }
  try {
    await save(page);
  } catch (error) {
    return { ok: false, status: 'unknown', saveAttempts: 1,
      problems: [{ code: error.code ?? 'save_unknown', message: error.message }] };
  }
  let after;
  try { after = await read(approvedPreview); } catch (error) {
    return { ok: false, status: 'unknown', saveAttempts: 1,
      problems: [{ code: error.code ?? 'post_save_read_failed', message: error.message }] };
  }
  const receipt = matchReceiptRows(after.receiptsGrid, approvedPreview);
  if (after.formMode?.value === 'modify' && after.billNo?.readable === true
      && text(after.billNo.value) && after.taskMatch?.ok && receipt.ok) {
    return { ok: true, status: 'saved', saveAttempts: 1, billNo: after.billNo.value, readings: after };
  }
  const readable = after.formMode?.readable === true && after.billNo?.readable === true;
  return {
    ok: false,
    status: readable ? 'failed' : 'unknown',
    saveAttempts: 1,
    problems: [{ code: 'save_postcondition_failed', message: '保存后没有同时读到修改页签、单据编号和严格逐行回读',
      reasons: [...(after.taskMatch?.reasons ?? []), ...receipt.reasons] }],
    readings: after,
  };
}

export { completePreviewProblems };
