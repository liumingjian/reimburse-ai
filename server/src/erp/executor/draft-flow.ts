// The narrow boundary between an approved preview and an ERP 费用报销单 (expense reimbursement bill): fill it, read it
// back strictly, and hand it over unsaved (ADR-0028). Nothing here clicks 保存 (save).
// Origin: 50931a3:kernel/src/erp-draft-flow.mjs (fillApprovedPreview, saveApprovedPreview, matchReceiptRows,
// formReadbackToken, completePreviewProblems). It never creates an approval.
// Form actions are injected; `readCurrent` returns raw readings plus the server's strict verdict (`taskMatch`).

import { approvalCovers, erpWritePreviewDigest, fieldPlanOf, type Approval, type ApprovedPreview, type FreshGate } from '../protocol';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INVOICE = /^einvoice-20:(\d{20})$/;
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票']);

export type Problem = { code: string; message: string; [extra: string]: unknown };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const amountText = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[¥￥,\s]/g, '');
  return MONEY.test(normalized) ? normalized : null;
};
const cents = (value: unknown) => {
  const normalized = amountText(value);
  if (normalized === null) return null;
  const [whole, fraction = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const validDate = (value: unknown) => {
  const match = DATE.exec(text(value) ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const sameIdentity = (left: any, right: any) => !!left && !!right && left.account === right.account && left.tenant === right.tenant;
const validInvoiceTypeSource = (value: unknown) => {
  const source = text(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};
const issue = (problems: Problem[], code: string, message: string, extra: Record<string, unknown> = {}) => { problems.push({ code, message, ...extra }); };

type GridLike = { ok: boolean; reason?: string; columns?: Array<{ label: string }>; rows?: Array<{ kind: string; values?: Record<string, string> }> } | null | undefined;
const dataRows = (grid: GridLike) => (grid?.ok === true && Array.isArray(grid.rows) ? grid.rows.filter((row) => row.kind === 'data') : []);
const hasColumn = (grid: GridLike, label: string) => grid?.columns?.some((column) => column.label === label) === true;
const requiresRoute = (line: any) => text(line?.kind) === 'rail_eticket' || text(line?.kind) === 'passenger_transport';

/** The fresh gate must match the preview's task, version and identity scope. */
export const gateProblems = (gate: FreshGate | null | undefined, preview: Partial<ApprovedPreview>): Problem[] => {
  const problems: Problem[] = [];
  if (!gate || typeof gate !== 'object') {
    issue(problems, 'fresh_gate_missing', '缺少当前 ERP 身份与任务范围的 fresh gate');
    return problems;
  }
  if (gate.status !== 'matched') issue(problems, 'fresh_gate_not_matched', 'ERP 当前身份没有 matched');
  if (gate.fresh !== true) issue(problems, 'fresh_gate_not_fresh', 'ERP 身份/范围 gate 不是本次 fresh 核验');
  if (!sameIdentity(gate.identity, preview.identity)) issue(problems, 'fresh_gate_identity_mismatch', 'fresh gate 身份与预览身份不一致');
  if (gate.taskId !== preview.taskId) issue(problems, 'fresh_gate_task_mismatch', 'fresh gate 不属于当前任务');
  if (gate.versionId !== preview.versionId) issue(problems, 'fresh_gate_version_mismatch', 'fresh gate 不属于当前事件版本');
  const scope = gate.scope;
  if (!scope || scope.taskId !== preview.taskId || scope.versionId !== preview.versionId || !sameIdentity(scope.identity, preview.identity)) {
    issue(problems, 'fresh_gate_scope_mismatch', 'fresh gate 缺少当前任务、版本和身份的完整范围');
  }
  return problems;
};

const invoiceOf = (binding: any) => {
  const identity = INVOICE.exec(text(binding?.identityKey) ?? '');
  const invoiceNumber = text(binding?.invoiceNumber);
  return identity && invoiceNumber === identity[1] ? invoiceNumber : null;
};

/** Whether a preview is complete enough to be written; any edit after approval breaks its digest. */
export const completePreviewProblems = (preview: ApprovedPreview | null | undefined): Problem[] => {
  const problems: Problem[] = [];
  if (!preview || typeof preview !== 'object') return [{ code: 'preview_missing', message: '缺少完整 ERP 草稿预览' }];
  if (preview.previewDigest !== erpWritePreviewDigest(preview)) issue(problems, 'preview_digest_mismatch', '草稿预览已被修改，摘要与内容不一致');
  if (preview.projectSource !== 'erp_catalog_confirmed' || preview.projectsFrom !== 'project_book') issue(problems, 'preview_project_source_invalid', '预览项目来源不是 ERP 已核验的本人 project_book');
  if (!Array.isArray(preview.lines) || !preview.lines.length) issue(problems, 'preview_lines_missing', '预览没有明细');
  const bindings = new Map((preview.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding]));
  for (const line of preview.lines ?? []) {
    if (!text(line.projectCode) || !text(line.projectName)) issue(problems, 'preview_project_missing', `明细 ${line.lineId} 缺少完整项目`);
    if (!text(line.expenseItemCode) || !text(line.expenseItemName)) issue(problems, 'preview_expense_missing', `明细 ${line.lineId} 缺少完整费用项目`);
    if (!ERP_INVOICE_TYPES.has(text(line.invoiceType) ?? '') || !validInvoiceTypeSource(line.invoiceTypeSource)) issue(problems, 'preview_invoice_type_missing', `明细 ${line.lineId} 缺少有出处票种`);
    if (!validDate(line.date) || !validDate(line.endDate)) issue(problems, 'preview_date_missing', `明细 ${line.lineId} 缺少有效开始/结束日期`);
    if (cents(line.netAmount) === null || cents(line.taxAmount) === null || cents(line.totalAmount) === null) issue(problems, 'preview_amount_missing', `明细 ${line.lineId} 缺少最终净额、税额或价税合计`);
    if (requiresRoute(line) && (!text(line.routePlan?.origin) || !text(line.routePlan?.destination))) issue(problems, 'preview_route_missing', `明细 ${line.lineId} 缺少起终点结构`);
    if (!bindings.has(line.voucherMaterialId)) issue(problems, 'preview_receipt_missing', `明细 ${line.lineId} 缺少收票绑定`);
  }
  const receiptBindings = Array.isArray(preview.receiptBindings) ? preview.receiptBindings : [];
  if (!receiptBindings.length) issue(problems, 'preview_receipts_missing', '预览没有逐票收票绑定');
  const seenMaterials = new Set<string>();
  const seenInvoices = new Set<string>();
  const seenReceipts = new Set<string>();
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
    if (cents(binding.netAmount) === null || cents(binding.taxAmount) === null) issue(problems, 'preview_receipt_amount_missing', `收票 ${binding.voucherMaterialId} 缺少净税金额`);
    if (binding.netAmountSource !== 'erp_receipt' || binding.taxAmountSource !== 'erp_receipt') issue(problems, 'preview_receipt_source_missing', `收票 ${binding.voucherMaterialId} 缺少 ERP 净税来源`);
  }
  return problems;
};

const gateAndApprovalProblems = (preview: ApprovedPreview, gate: FreshGate | null | undefined, approval: Approval | null | undefined) => [
  ...completePreviewProblems(preview),
  ...gateProblems(gate, preview ?? {}),
  ...(approvalCovers(approval, preview) ? [] : [{ code: 'approval_missing_or_stale', message: '批准记录没有覆盖这份完整预览' }]),
];

const invoiceMatches = (actual: unknown, expected: string) => {
  const actualText = text(actual)?.replace(/\s+/g, '') ?? '';
  if (actualText === expected) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(actualText);
  return !!masked && expected.startsWith(masked[1]!) && expected.endsWith(masked[2]!);
};

/** Match the current receipt grid by identity (invoice number + receipt number) and all three amounts. */
export function matchReceiptRows(grid: GridLike, preview: Partial<ApprovedPreview> | null | undefined) {
  const reasons: string[] = [];
  const rowsByMaterial = new Map<string, { row: unknown; index: number }>();
  if (!grid?.ok) return { ok: false, reasons: [grid?.reason ?? '收票网格不可读'], rowsByMaterial };
  for (const column of ['收票单', '发票号码', '不含税金额', '税额', '价税合计']) if (!hasColumn(grid, column)) reasons.push(`收票网格缺少「${column}」列`);
  const bindings = Array.isArray(preview?.receiptBindings) ? preview.receiptBindings : [];
  if (bindings.length === 0) reasons.push('预览没有逐票收票身份绑定');
  const rows = dataRows(grid);
  if (rows.length !== bindings.length) reasons.push(`ERP 收票实际 ${rows.length} 行，预览要求 ${bindings.length} 行`);
  const used = new Set<number>();
  for (const binding of bindings) {
    if (!text(binding?.voucherMaterialId) || !invoiceOf(binding) || !text(binding?.receiptNumber)) {
      reasons.push(`收票 ${binding?.voucherMaterialId ?? '?'} 缺少合法发票号和收票号`);
      continue;
    }
    const candidates = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => {
      if (used.has(index)) return false;
      const values = row.values ?? {};
      return text(values['收票单']) === binding.receiptNumber && invoiceMatches(values['发票号码'], binding.invoiceNumber);
    });
    if (candidates.length !== 1) { reasons.push(`收票 ${binding.voucherMaterialId} 没有唯一匹配的发票号和收票号`); continue; }
    const { row, index } = candidates[0]!;
    used.add(index);
    const values = row.values ?? {};
    for (const [column, expected] of [['不含税金额', binding.netAmount], ['税额', binding.taxAmount], ['价税合计', binding.grossAmount]] as const) {
      if (cents(values[column]) !== cents(expected)) reasons.push(`收票 ${binding.voucherMaterialId} 的「${column}」与预览不一致`);
    }
    rowsByMaterial.set(binding.voucherMaterialId, { row, index });
  }
  for (const [index] of rows.entries()) if (!used.has(index)) reasons.push(`ERP 收票第 ${index + 1} 行没有预览身份绑定`);
  return { ok: reasons.length === 0, reasons, rowsByMaterial };
}

const isEmptyDetailRow = (row: { values?: Record<string, string> }) => {
  const values = row?.values ?? {};
  return ['项目', '费用项目', '费用金额', '税额', '申请报销金额', '收票单号'].every((column) => !text(values[column]));
};

const detailRowsForFill = (grid: GridLike, preview: ApprovedPreview) => {
  const reasons: string[] = [];
  const rowByMaterial = new Map<string, number>();
  const placeholders: number[] = [];
  if (!grid?.ok) return { ok: false, reasons: [grid?.reason ?? '明细网格不可读'], rowByMaterial, placeholders };
  const bindingByReceipt = new Map((preview.receiptBindings ?? []).map((binding) => [binding.receiptNumber, binding]));
  for (const [index, row] of dataRows(grid).entries()) {
    const receiptNumber = text(row.values?.['收票单号']);
    if (!receiptNumber) {
      if (isEmptyDetailRow(row)) placeholders.push(index);
      else reasons.push(`ERP 明细第 ${index + 1} 行没有收票身份，不能靠金额定位`);
      continue;
    }
    const binding = bindingByReceipt.get(receiptNumber);
    if (!binding) { reasons.push(`ERP 明细第 ${index + 1} 行的收票单号不在预览中`); continue; }
    if (rowByMaterial.has(binding.voucherMaterialId)) reasons.push(`ERP 明细凭证 ${binding.voucherMaterialId} 重复`);
    rowByMaterial.set(binding.voucherMaterialId, index);
  }
  return { ok: reasons.length === 0, reasons, rowByMaterial, placeholders };
};

export type CurrentReadings = {
  formMode?: { readable?: boolean; value?: string | null };
  billNo?: { readable?: boolean; value?: string | null };
  receiptsGrid?: GridLike;
  detailGrid?: GridLike;
  taskMatch?: { ok: boolean; reasons?: string[] } | null;
  [extra: string]: unknown;
};

/** A token of "the same form": mode, bill number and receipt identities. Save refuses when it changed. */
export const formReadbackToken = (readings: CurrentReadings | null | undefined) => JSON.stringify({
  mode: readings?.formMode?.value ?? null,
  billNo: readings?.billNo?.value ?? null,
  receipts: dataRows(readings?.receiptsGrid).map((row) => [text(row.values?.['收票单']), text(row.values?.['发票号码'])]).sort(),
});

export type ActionResult = { ok?: boolean | undefined; reason?: string | undefined; stillEditing?: boolean | null | undefined } | false | null | undefined;
export type FormOps<P> = {
  writeHeader?: (page: P, key: string, value: string, options: Record<string, unknown>, deps?: unknown) => Promise<ActionResult>;
  writeCell?: (page: P, spec: { which: number; row: number; column: string; value: string; expect: { mode: 'equals'; value: string } | null }, deps?: unknown) => Promise<ActionResult>;
  selectOption?: (page: P, spec: { which: number; row: number; column: string; option: string }, deps?: unknown) => Promise<ActionResult>;
  leaveEdit?: (page: P, options: { label: string }, deps?: unknown) => Promise<ActionResult>;
};

const fail = (phase: string, problems: Problem[], extra: Record<string, unknown> = {}) => ({ ok: false as const, phase, problems, ...extra });
const adapterMissing = (name: string): Problem => ({ code: 'form_adapter_required', message: `缺少受控表单操作适配器 ${name}` });

export type FillResult =
  | { ok: true; phase: 'filled'; previewDigest: string | undefined; formToken: string; rowsWritten: Array<{ lineId: string; rowIndex: number }>; readings: CurrentReadings }
  | { ok: false; phase: string; problems: Problem[]; [extra: string]: unknown };

/**
 * Fill an approved preview. The first read is a no-write preflight: one new tab, empty bill number, exact receipt
 * identities, no unlocated detail row. A missing addRow adapter is a visible blocker, never a guessed click.
 */
export async function fillApprovedPreview<P>(page: P, {
  approvedPreview, approval, freshGate, readCurrent, addRow = null, writeDeps = {}, ops = {},
}: {
  approvedPreview: ApprovedPreview; approval: Approval | null | undefined; freshGate: FreshGate | null | undefined;
  readCurrent: (expected: ApprovedPreview | null) => Promise<CurrentReadings>;
  addRow?: ((page: P, detail: { line: ApprovedPreview['lines'][number]; current: CurrentReadings }) => Promise<ActionResult>) | null;
  writeDeps?: unknown; ops?: FormOps<P>;
}): Promise<FillResult> {
  const problems: Problem[] = gateAndApprovalProblems(approvedPreview, freshGate, approval);
  if (problems.length) return fail('preflight', problems);
  let readings: CurrentReadings;
  try { readings = await readCurrent(null); } catch (error: any) {
    return fail('preflight', [{ code: error?.code ?? 'read_failed', message: error?.message ?? String(error) }]);
  }
  if (readings.formMode?.value !== 'new') problems.push({ code: 'new_form_required', message: '只有唯一的费用报销单-新增页签允许填充' });
  if (readings.billNo?.readable !== true || readings.billNo.value !== null) problems.push({ code: 'empty_bill_required', message: '新增单单据编号必须可读且为空' });
  const receiptMatch = matchReceiptRows(readings.receiptsGrid, approvedPreview);
  problems.push(...receiptMatch.reasons.map((message) => ({ code: 'receipt_preflight_failed', message })));
  const detail = detailRowsForFill(readings.detailGrid, approvedPreview);
  problems.push(...detail.reasons.map((message) => ({ code: 'detail_preflight_failed', message })));
  if (problems.length) return fail('preflight', problems, { readings });

  const { writeHeader, writeCell, selectOption, leaveEdit } = ops;
  if (!writeHeader || !writeCell || !selectOption || !leaveEdit) {
    return fail('preflight', [adapterMissing(['writeHeader', 'writeCell', 'selectOption', 'leaveEdit'].filter((name) => !ops[name as keyof FormOps<P>]).join('、'))], { readings });
  }
  const header = await writeHeader(page, 'FCAUSA', approvedPreview.purpose, {}, writeDeps);
  if (!header || !header.ok) return fail('fill', [{ code: 'header_write_failed', message: (header && header.reason) || '事由回读失败' }], { readings });

  const rowByMaterial = new Map(detail.rowByMaterial);
  const placeholders = [...detail.placeholders];
  const rowsWritten: Array<{ lineId: string; rowIndex: number }> = [];
  for (const line of approvedPreview.lines) {
    let rowIndex = rowByMaterial.get(line.voucherMaterialId);
    if (rowIndex === undefined && placeholders.length) rowIndex = placeholders.shift();
    if (rowIndex === undefined) {
      if (typeof addRow !== 'function') {
        return fail('fill', [{ code: 'add_row_adapter_required', message: `明细 ${line.lineId} 需要新增行，但没有受控 addRow 适配器` }], { readings, rowsWritten });
      }
      const previousRowCount = dataRows(readings.detailGrid).length;
      let added: ActionResult;
      try { added = await addRow(page, { line, current: readings }); } catch (error: any) {
        return fail('fill', [{ code: error?.code ?? 'add_row_failed', message: error?.message ?? String(error) }], { readings, rowsWritten });
      }
      if (added === false || (added && added.ok === false)) {
        return fail('fill', [{ code: 'add_row_failed', message: (added && added.reason) || '新增明细行未确认' }], { readings, rowsWritten });
      }
      readings = await readCurrent(null);
      const currentRows = dataRows(readings.detailGrid);
      if (currentRows.length !== previousRowCount + 1) {
        return fail('fill', [{ code: 'add_row_not_observed', message: '新增明细行没有在只读回读中出现' }], { readings, rowsWritten });
      }
      rowIndex = currentRows.length - 1;
    }
    const plan = approvedPreview.fieldPlan?.details.find((candidate) => candidate.lineId === line.lineId)
      ?? fieldPlanOf(approvedPreview).details.find((candidate) => candidate.lineId === line.lineId)!;
    const beforeRow = dataRows(readings.detailGrid)[rowIndex];
    const currentTax = cents(beforeRow?.values?.['税额']);
    if (currentTax !== null && currentTax !== 0) {
      const cleared = await writeCell(page, { which: 0, row: rowIndex, column: '税额', value: '0.00', expect: null }, writeDeps);
      if (!cleared || !cleared.ok) return fail('fill', [{ code: 'tax_clear_failed', message: (cleared && cleared.reason) || '写入前清空旧税额失败' }], { readings, rowsWritten });
    }
    for (const field of plan.fields) {
      const result = field.option
        ? await selectOption(page, { which: 0, row: rowIndex, column: field.column, option: field.option }, writeDeps)
        : await writeCell(page, { which: 0, row: rowIndex, column: field.column, value: String(field.value), expect: { mode: 'equals', value: String(field.readback) } }, writeDeps);
      if (!result || !result.ok) {
        return fail('fill', [{ code: 'field_write_failed', message: (result && result.reason) || `字段 ${field.column} 回读失败`, lineId: line.lineId, column: field.column }], { readings, rowsWritten });
      }
    }
    rowsWritten.push({ lineId: line.lineId, rowIndex });
  }
  const left = await leaveEdit(page, { label: '明细信息' }, writeDeps);
  if (!left || !left.ok || left.stillEditing === true) {
    return fail('fill', [{ code: 'leave_edit_failed', message: (left && left.reason) || '明细仍在编辑态' }], { readings, rowsWritten });
  }
  const after = await readCurrent(approvedPreview);
  const afterReceipts = matchReceiptRows(after.receiptsGrid, approvedPreview);
  if (!after.taskMatch?.ok || !afterReceipts.ok) {
    return fail('fill', [{ code: 'strict_readback_failed', message: '填充后严格逐行回读或收票身份核对未通过',
      reasons: [...(after.taskMatch?.reasons ?? []), ...afterReceipts.reasons] }], { readings: after, rowsWritten });
  }
  return { ok: true, phase: 'filled', previewDigest: approvedPreview.previewDigest, formToken: formReadbackToken(readings), rowsWritten, readings: after };
}

// `status` carries the whole outcome: `handed_over` is the one success, and it is the only status without problems.
export type HandOverResult = {
  status: 'handed_over' | 'blocked' | 'unknown';
  problems?: Problem[]; readings?: CurrentReadings;
};

/**
 * The hand-over gate (ADR-0028): the strict pre-save verification that used to precede the save, now the end of the
 * job. It re-checks the gate and the approval, that the fill read-back covered this very preview on this very form,
 * that the page is still the same 新增 (new) form with an empty 单据编号 (bill number), that every detail line still
 * matches the approved preview field by field, and that the 收票 (receipt) rows are still the approved ones. It takes
 * no save adapter and performs no mutation: baox never clicks 保存 (save), the employee does. The readings it
 * verified come back as the evidence of the hand-over.
 */
export async function handOverApprovedPreview({
  approvedPreview, approval, freshGate, fillResult, readCurrent,
}: {
  approvedPreview: ApprovedPreview; approval: Approval | null | undefined; freshGate: FreshGate | null | undefined;
  fillResult: { ok: boolean; previewDigest?: string | undefined; formToken?: string } | null | undefined;
  readCurrent: (expected: ApprovedPreview | null) => Promise<CurrentReadings>;
}): Promise<HandOverResult> {
  const problems: Problem[] = gateAndApprovalProblems(approvedPreview, freshGate, approval);
  if (!fillResult?.ok || fillResult.previewDigest !== approvedPreview?.previewDigest) {
    problems.push({ code: 'fill_result_missing', message: '没有同一完整预览的成功填充回读' });
  }
  if (problems.length) return { status: 'blocked', problems };
  let before: CurrentReadings;
  try { before = await readCurrent(approvedPreview); } catch (error: any) {
    return { status: 'unknown', problems: [{ code: error?.code ?? 'hand_over_read_failed', message: error?.message ?? String(error) }] };
  }
  if (formReadbackToken(before) !== fillResult!.formToken || before.formMode?.value !== 'new'
    || before.billNo?.value !== null || !before.taskMatch?.ok || !matchReceiptRows(before.receiptsGrid, approvedPreview).ok) {
    return { status: 'blocked', problems: [{ code: 'hand_over_precondition_failed', message: '填充后当前页已不是同一张新增空号单，没有交接' }] };
  }
  return { status: 'handed_over', readings: before };
}
