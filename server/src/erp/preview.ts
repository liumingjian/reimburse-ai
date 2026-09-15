// Server-side construction of the ERP draft preview: the exact field plan the executor realises.
// Origin: kernel/src/erp-write-preview.mjs (buildErpWritePreview, previewLinesDigest) and
// kernel/src/erp-draft-flow.mjs (buildErpDraftPreview, routePlanOf). Codes and messages are kept.
// It reads no files, opens no browser and never saves.

import { createHash } from 'node:crypto';
import { gateProblems } from './executor/draft-flow';
import { erpWritePreviewDigest, fieldPlanOf, type ApprovedPreview, type FreshGate, type PreviewLine, type ReceiptBinding } from './protocol';

const INVOICE_IDENTITY = /^einvoice-20:(\d{20})$/;
const SAFE_RECEIPT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RECEIPT = SAFE_RECEIPT_NUMBER;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票']);

type Problem = { code: string; message: string; [extra: string]: unknown };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const identityOf = (value: any) => {
  const account = text(value?.account);
  const tenant = text(value?.tenant);
  return account && tenant ? { account, tenant } : null;
};
const sameIdentity = (left: any, right: any) => !!left && !!right && left.account === right.account && left.tenant === right.tenant;
const validDate = (value: unknown) => {
  const match = DATE.exec(text(value) ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
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
const issue = (problems: Problem[], code: string, message: string, extra: Record<string, unknown> = {}) => { problems.push({ code, message, ...extra }); };

/** Fingerprint of the candidate lines a selection or catalog check stands on. Equals the kernel's linesDigest. */
export const previewLinesDigest = (built: any): string => {
  const source: any[] = Array.isArray(built?.lineItems) ? built.lineItems : [];
  const shape = source.map((line) => [line.lineId, line.voucherMaterialId, line.date, line.endDate ?? line.checkOut, line.city, line.totalAmount].join('|'));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
};

const mapEntries = (value: any): Array<[string, any]> => {
  if (Array.isArray(value)) return value.map((entry) => [text(entry?.code ?? entry?.number), entry] as [string | null, any]).filter((pair): pair is [string, any] => !!pair[0]);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, entry]) => [text(key), entry] as [string | null, any]).filter((pair): pair is [string, any] => !!pair[0]);
};
const checkRecord = (record: any, code: string) => {
  const entryCode = text(record?.code ?? record?.number);
  const name = text(record?.name ?? record?.erpName);
  const verdict = text(record?.verdict);
  if (!entryCode || entryCode !== code || !name || verdict !== 'confirmed') return null;
  return { code, name };
};
const projectRecordOf = (catalog: any, code: string) => checkRecord({ ...mapEntries(catalog?.projects).find(([key]) => key === code)?.[1], code }, code);
const expenseRecordOf = (catalog: any, expenseItems: any, code: string) => {
  for (const source of [expenseItems, catalog?.expenseItems, catalog?.expenseItemCatalog, catalog?.checked].filter(Boolean)) {
    const record = checkRecord({ ...mapEntries(source).find(([key]) => key === code)?.[1], code }, code);
    if (record) return record;
  }
  return null;
};
const normalizeReceiptCheck = (check: any, index: number) => {
  const identityKey = text(check?.identityKey);
  const identity = INVOICE_IDENTITY.exec(identityKey ?? '');
  const rows = Array.isArray(check?.rows) ? check.rows : null;
  const receiptNumber = rows?.length === 1 && Array.isArray(rows[0]) ? text(rows[0][0]) : null;
  const gross = rows?.length === 1 && Array.isArray(rows[0]) ? cents(rows[0][3]) : null;
  return { index, materialId: text(check?.materialId), identityKey, invoiceNumber: identity?.[1] ?? null, receiptNumber, gross, ok: check?.ok === true };
};
const sameText = (left: unknown, right: unknown) => text(left) === text(right);
const validInvoiceTypeSource = (value: unknown) => {
  const source = text(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};
const accommodationLine = (raw: any, event: any) => raw?.category === 'accommodation' || event?.category === 'accommodation';

export type PreviewInput = {
  task: any; built: any; lines?: any[]; selection: any; catalog: any; expenseItems?: any; receiptCheck: any;
  receiptReadback?: any; freshGate?: FreshGate | null;
};

/**
 * Build the input of the strict read-back matcher. The preview is null unless every line has a project-book
 * project, an ERP-verified project and expense item, a real end date, and a unique receipt binding.
 */
export function buildErpWritePreview({ task, built, lines, selection, catalog, expenseItems = null, receiptCheck }: PreviewInput):
  { ready: true; expectedPreview: ApprovedPreview; problems: Problem[] } | { ready: false; expectedPreview: null; problems: Problem[] } {
  const problems: Problem[] = [];
  const taskIdentity = identityOf(task?.identity);
  const selectedIdentity = identityOf(selection?.identity);
  const previewLines: any[] | undefined = Array.isArray(lines) ? lines : built?.lineItems;
  const events: any[] | null = Array.isArray(built?.events) ? built.events : null;

  if (!text(task?.taskId)) issue(problems, 'task_id_missing', '任务缺少 taskId');
  if (!taskIdentity) issue(problems, 'task_identity_missing', '任务缺少已确认的 account/tenant 身份');
  if (!built || !text(built.versionId)) issue(problems, 'built_version_missing', '事件构建结果缺少 versionId');
  if (task?.currentVersionId && built?.versionId && task.currentVersionId !== built.versionId) issue(problems, 'built_version_stale', '事件构建版本与任务当前版本不一致');
  if (!events?.length) issue(problems, 'events_missing', '事件构建结果缺少已确认 events');
  if (!Array.isArray(previewLines) || !previewLines.length) issue(problems, 'lines_missing', '没有已确认的费用明细行');

  const eventById = new Map<string, any>();
  for (const event of events ?? []) {
    const eventId = text(event?.eventId);
    const materialId = text(event?.voucherMaterialId);
    if (!eventId || !materialId) { issue(problems, 'event_identity_missing', '事件缺少 eventId 或 voucherMaterialId'); continue; }
    if (eventById.has(eventId)) issue(problems, 'event_id_duplicate', `事件 ${eventId} 重复`);
    eventById.set(eventId, event);
  }

  if (!selection) {
    issue(problems, 'selection_missing', '缺少任务选择记录');
  } else {
    if (!sameIdentity(taskIdentity, selectedIdentity)) issue(problems, 'selection_identity_mismatch', '任务选择身份与任务身份不一致');
    if (selection.projectSource !== 'erp_catalog_confirmed') issue(problems, 'project_source_not_ready', '任务选择没有 erp_catalog_confirmed 来源证据');
    if (selection.projectsFrom !== 'project_book') issue(problems, 'projects_from_not_ready', '任务选择不是从本人 project_book 选择');
    if (!text(selection.versionId) || selection.versionId !== built?.versionId) issue(problems, 'selection_version_stale', '任务选择版本与事件版本不一致');
    if (selection.linesDigest !== previewLinesDigest(built)) issue(problems, 'selection_lines_stale', '任务选择明细指纹与当前事件明细不一致');
  }

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    issue(problems, 'catalog_missing', '缺少已核验的 ERP 主数据目录');
  } else {
    if (catalog.versionId && catalog.versionId !== built?.versionId) issue(problems, 'catalog_version_stale', 'ERP 主数据核验版本与事件版本不一致');
    if (catalog.linesDigest && catalog.linesDigest !== previewLinesDigest(built)) issue(problems, 'catalog_lines_stale', 'ERP 主数据核验明细指纹与当前事件明细不一致');
    if (catalog.identity && !sameIdentity(catalog.identity, taskIdentity)) issue(problems, 'catalog_identity_mismatch', 'ERP 主数据核验身份与任务身份不一致');
  }

  const selectedProjects: Record<string, string> = selection?.projects && typeof selection.projects === 'object' ? selection.projects : {};
  const normalizedLines: PreviewLine[] = [];
  const lineIds = new Set<string>();
  const materialIds = new Set<string>();

  for (const [index, raw] of (Array.isArray(previewLines) ? previewLines : []).entries()) {
    const lineId = text(raw?.lineId);
    const eventId = text(raw?.eventId);
    const materialId = text(raw?.voucherMaterialId);
    const event = eventId ? eventById.get(eventId) : undefined;
    const label = lineId ?? index + 1;
    if (!lineId) issue(problems, 'line_id_missing', `第 ${index + 1} 行缺少 lineId`);
    if (lineId && lineIds.has(lineId)) issue(problems, 'line_id_duplicate', `明细 ${lineId} 重复`);
    if (lineId) lineIds.add(lineId);
    if (!event) issue(problems, 'line_event_missing', `明细 ${label} 没有对应事件`);
    if (!materialId) issue(problems, 'line_voucher_missing', `明细 ${label} 缺少 voucherMaterialId`);
    if (event && materialId !== text(event.voucherMaterialId)) issue(problems, 'line_voucher_mismatch', `明细 ${label} 的凭证与事件不一致`);
    if (materialId) materialIds.add(materialId);

    const projectCode = text(raw?.projectCode ?? raw?.project ?? (lineId ? selectedProjects[lineId] : null));
    const projectSource = text(raw?.projectSource);
    const projectsFrom = text(raw?.projectsFrom);
    if (!projectCode) issue(problems, 'project_missing', `明细 ${label} 缺少项目号`);
    if (selection && (!lineId || !Object.prototype.hasOwnProperty.call(selectedProjects, lineId) || !sameText(projectCode, selectedProjects[lineId]))) {
      issue(problems, 'project_selection_mismatch', `明细 ${label} 与任务选择项目号不一致`);
    }
    if (projectSource !== 'erp_catalog_confirmed') issue(problems, 'project_source_not_ready', `明细 ${label} 缺少 erp_catalog_confirmed 来源`);
    if (projectsFrom !== 'project_book') issue(problems, 'projects_from_not_ready', `明细 ${label} 不是 project_book 来源`);
    const project = projectCode ? projectRecordOf(catalog, projectCode) : null;
    if (!project) issue(problems, 'project_catalog_missing', `项目 ${projectCode ?? label} 没有已核验的 ERP 名称`);

    const expenseItemCode = text(raw?.expenseItemCode);
    const expenseItemName = text(raw?.expenseItemName);
    if (!expenseItemCode || !expenseItemName) issue(problems, 'expense_item_missing', `明细 ${label} 缺少费用项目编码和名称`);
    const expense = expenseItemCode ? expenseRecordOf(catalog, expenseItems, expenseItemCode) : null;
    if (!expense || expense.name !== expenseItemName) issue(problems, 'expense_item_catalog_mismatch', `费用项目 ${expenseItemCode ?? label} 没有精确的 ERP 编码/名称核验`);

    const date = text(raw?.date);
    const explicitEndDate = text(raw?.endDate ?? raw?.checkOut);
    // ERP takes one date for a same-day ride/rail line; only accommodation carries a distinct checkout.
    const endDate = explicitEndDate ?? (!accommodationLine(raw, event) ? date : null);
    if (!validDate(date)) issue(problems, 'line_date_invalid', `明细 ${label} 缺少有效费用日期`);
    if (!validDate(endDate)) issue(problems, 'end_date_missing', `明细 ${label} 缺少可证实的结束日期`);

    const kind = raw?.kind ?? event?.kind ?? null;
    const totalAmount = amountText(raw?.totalAmount);
    const netAmount = raw?.netAmount === null || raw?.netAmount === undefined ? null : amountText(raw.netAmount);
    const taxAmount = raw?.taxAmount === null || raw?.taxAmount === undefined ? null : amountText(raw.taxAmount);
    if (totalAmount === null) issue(problems, 'line_total_invalid', `明细 ${label} 缺少有效价税合计`);
    if (raw?.netAmount !== null && raw?.netAmount !== undefined && netAmount === null) issue(problems, 'line_net_invalid', `明细 ${label} 的不含税金额无效`);
    if (raw?.taxAmount !== null && raw?.taxAmount !== undefined && taxAmount === null) issue(problems, 'line_tax_invalid', `明细 ${label} 的税额无效`);
    if (netAmount !== null && taxAmount !== null && cents(netAmount)! + cents(taxAmount)! !== cents(totalAmount)) issue(problems, 'line_amount_not_conserved', `明细 ${label} 的不含税金额、税额和价税合计不守恒`);
    if (kind !== 'rail_eticket' && netAmount === null) issue(problems, 'line_net_missing', `明细 ${label} 不是铁路客票，却缺少票面不含税金额`);
    if (kind !== 'rail_eticket' && taxAmount === null) issue(problems, 'line_tax_missing', `明细 ${label} 不是铁路客票，却缺少票面税额`);

    const invoiceType = text(raw?.invoiceType ?? raw?.invoiceTypeLabel ?? event?.invoiceType ?? event?.invoiceTypeLabel);
    normalizedLines.push({
      lineId: lineId!, eventId, voucherMaterialId: materialId!,
      maskedNumber: text(raw?.maskedNumber ?? event?.maskedNumber),
      invoiceNumber: text(raw?.invoiceNumber ?? event?.invoiceNumber),
      kind, date: date!, endDate, checkOut: explicitEndDate,
      city: raw?.city ?? event?.city ?? null,
      route: raw?.route ?? event?.route ?? null,
      origin: text(raw?.origin ?? event?.origin),
      destination: text(raw?.destination ?? event?.destination),
      routeSource: text(raw?.routeSource ?? event?.routeSource),
      netAmount, taxAmount, totalAmount: totalAmount!,
      amountSource: raw?.amountSource ?? event?.amountSource ?? null,
      referenceMaterialIds: raw?.referenceMaterialIds ?? event?.referenceMaterialIds ?? [],
      netAmountSource: netAmount === null ? 'erp_receipt' : text(raw?.netAmountSource) ?? 'invoice_face',
      taxAmountSource: taxAmount === null ? 'erp_receipt' : text(raw?.taxAmountSource) ?? 'invoice_face',
      endDateSource: explicitEndDate ? 'explicit_line_or_checkout' : 'same_day_date',
      category: raw?.category ?? null,
      categoryLabel: raw?.categoryLabel ?? null,
      categoryBasis: raw?.categoryBasis ?? null,
      categoryNote: raw?.categoryNote ?? null,
      expenseItemCode: expenseItemCode!, expenseItemName: expenseItemName!,
      expenseItemSource: text(raw?.expenseItemSource),
      projectCode: projectCode!, projectName: project?.name ?? null,
      project: projectCode,
      projectSource, projectsFrom,
      invoiceType,
      invoiceTypeLabel: text(raw?.invoiceTypeLabel ?? raw?.invoiceType ?? event?.invoiceTypeLabel ?? event?.invoiceType),
      invoiceTypeSource: text(raw?.invoiceTypeSource ?? event?.invoiceTypeSource),
    });
    if (!invoiceType) issue(problems, 'invoice_type_missing', `明细 ${label} 缺少 ERP 发票类型枚举`);
    else if (!validInvoiceTypeSource(raw?.invoiceTypeSource ?? event?.invoiceTypeSource)) issue(problems, 'invoice_type_source_missing', `明细 ${label} 缺少发票类型映射出处`);
  }

  for (const key of Object.keys(selectedProjects)) if (!lineIds.has(key)) issue(problems, 'selection_extra_line', `任务选择包含不存在的明细 ${key}`);

  const checks: any[] | null = Array.isArray(receiptCheck?.checks) ? receiptCheck.checks : null;
  if (!checks) issue(problems, 'receipt_check_missing', '缺少已落盘 receipt check checks');
  if (receiptCheck && receiptCheck.taskId !== task?.taskId) issue(problems, 'receipt_check_task_mismatch', 'receipt check 不属于当前 taskId');
  if (receiptCheck?.versionId && receiptCheck.versionId !== built?.versionId) issue(problems, 'receipt_check_version_mismatch', 'receipt check 版本与事件版本不一致');

  const bindings: ReceiptBinding[] = [];
  const byMaterial = new Map<string, ReturnType<typeof normalizeReceiptCheck>>();
  for (const [index, raw] of (checks ?? []).entries()) {
    const check = normalizeReceiptCheck(raw, index);
    if (!check.materialId) { issue(problems, 'receipt_material_missing', `第 ${index + 1} 条 receipt check 缺少 materialId`); continue; }
    if (byMaterial.has(check.materialId)) { issue(problems, 'receipt_material_duplicate', `receipt check 中凭证 ${check.materialId} 重复`); continue; }
    byMaterial.set(check.materialId, check);
    if (check.ok !== true) issue(problems, 'receipt_check_failed', `凭证 ${check.materialId} 的 receipt check 未成功`);
    if (!check.invoiceNumber || !check.identityKey) issue(problems, 'receipt_identity_invalid', `凭证 ${check.materialId} 缺少有效 20 位发票身份`);
    if (!check.receiptNumber || !SAFE_RECEIPT_NUMBER.test(check.receiptNumber)) issue(problems, 'receipt_number_invalid', `凭证 ${check.materialId} 缺少唯一收票号`);
    if (!materialIds.has(check.materialId)) issue(problems, 'receipt_material_not_current', `receipt check 凭证 ${check.materialId} 不在当前明细中`);
    const matching = normalizedLines.filter((line) => line.voucherMaterialId === check.materialId);
    const expectedGross = matching.reduce((sum, line) => sum + (cents(line.totalAmount) ?? 0), 0);
    if (check.gross === null || matching.some((line) => line.totalAmount === null) || check.gross !== expectedGross) {
      issue(problems, 'receipt_gross_mismatch', `凭证 ${check.materialId} 的已核对收票金额与明细预览不一致`);
    }
    bindings.push({
      voucherMaterialId: check.materialId, identityKey: check.identityKey!, invoiceNumber: check.invoiceNumber!,
      receiptNumber: check.receiptNumber!, grossAmount: check.gross === null ? null : (check.gross / 100).toFixed(2),
    });
  }
  for (const materialId of materialIds) if (!byMaterial.has(materialId)) issue(problems, 'receipt_binding_missing', `当前凭证 ${materialId} 缺少 receipt check`);
  for (const materialId of byMaterial.keys()) if (!materialIds.has(materialId)) issue(problems, 'receipt_material_not_current', `receipt check 凭证 ${materialId} 不在当前明细中`);

  const seenInvoice = new Set<string>();
  const seenReceipt = new Set<string>();
  for (const binding of bindings) {
    if (!binding.invoiceNumber || !binding.receiptNumber) continue;
    if (seenInvoice.has(binding.invoiceNumber) || seenReceipt.has(binding.receiptNumber)) issue(problems, 'receipt_identity_duplicate', `凭证 ${binding.voucherMaterialId} 的发票号或收票号不唯一`);
    seenInvoice.add(binding.invoiceNumber);
    seenReceipt.add(binding.receiptNumber);
  }

  const homeCity = text(selection?.homeCity ?? task?.homeCity);
  const purpose = text(selection?.purpose);
  if (!homeCity) issue(problems, 'home_city_missing', '预览缺少已确认常驻城市');
  if (!purpose) issue(problems, 'purpose_missing', '预览缺少已确认报销事由');

  if (problems.length) return { ready: false, expectedPreview: null, problems };

  const expectedPreview: ApprovedPreview = {
    taskId: task.taskId, identity: taskIdentity!, versionId: built.versionId, homeCity: homeCity!, purpose: purpose!,
    projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book', lines: normalizedLines, receiptBindings: bindings,
  };
  expectedPreview.previewDigest = erpWritePreviewDigest(expectedPreview);
  return { ready: true, expectedPreview, problems: [] };
}

const requiresRoute = (line: any) => text(line?.kind) === 'rail_eticket' || text(line?.kind) === 'passenger_transport';

/**
 * Routes are facts, not display strings split on whitespace. An arrow is accepted only with exactly two
 * non-empty endpoints; otherwise the source must give explicit origin and destination fields.
 */
export const routePlanOf = (line: any, event: any = null) => {
  const direct: Array<[unknown, unknown, unknown]> = [
    [line?.origin, line?.destination, line?.routeSource],
    [event?.origin, event?.destination, event?.routeSource],
    [line?.routePlan?.origin, line?.routePlan?.destination, line?.routePlan?.source],
    [event?.routePlan?.origin, event?.routePlan?.destination, event?.routePlan?.source],
  ];
  for (const [origin, destination, source] of direct) {
    if (text(origin) && text(destination)) return { origin: text(origin)!, destination: text(destination)!, source: text(source) ?? 'confirmed_candidate' };
  }
  const route = text(line?.route ?? event?.route);
  if (!route) return null;
  const parts = route.split('→').map((part) => part.trim());
  return parts.length === 2 && parts.every(Boolean) ? { origin: parts[0]!, destination: parts[1]!, source: 'confirmed_route_arrow' } : null;
};

const invoiceOf = (binding: any) => {
  const identity = INVOICE_IDENTITY.exec(text(binding?.identityKey) ?? '');
  const invoiceNumber = text(binding?.invoiceNumber);
  return identity && invoiceNumber === identity[1] ? invoiceNumber : null;
};

const receiptFactsOf = (receiptReadback: any, preview: ApprovedPreview, problems: Problem[]) => {
  const facts = new Map<string, any>();
  if (!receiptReadback || receiptReadback.fresh !== true) { issue(problems, 'receipt_readback_not_fresh', '缺少本次 fresh ERP 收票逐票回读'); return facts; }
  if (receiptReadback.taskId !== preview.taskId) issue(problems, 'receipt_readback_task_mismatch', 'ERP 收票回读不属于当前任务');
  if (receiptReadback.versionId !== preview.versionId) issue(problems, 'receipt_readback_version_mismatch', 'ERP 收票回读不属于当前事件版本');
  if (!sameIdentity(receiptReadback.identity, preview.identity)) issue(problems, 'receipt_readback_identity_mismatch', 'ERP 收票回读身份与预览不一致');
  const rows: any[] | null = Array.isArray(receiptReadback.rows) ? receiptReadback.rows : null;
  if (!rows) { issue(problems, 'receipt_readback_missing', 'ERP 收票回读缺少逐票 rows'); return facts; }
  for (const [index, raw] of rows.entries()) {
    const identityKey = text(raw?.identityKey ?? raw?.invoiceIdentityKey);
    const row = {
      voucherMaterialId: text(raw?.voucherMaterialId), identityKey,
      invoiceNumber: invoiceOf({ identityKey, invoiceNumber: raw?.invoiceNumber }),
      receiptNumber: text(raw?.receiptNumber ?? raw?.receiptNo),
      grossAmount: amountText(raw?.grossAmount), netAmount: amountText(raw?.netAmount), taxAmount: amountText(raw?.taxAmount),
      source: text(raw?.source),
    };
    if (!row.voucherMaterialId || !row.identityKey || !row.invoiceNumber || !row.receiptNumber || !RECEIPT.test(row.receiptNumber)) {
      issue(problems, 'receipt_readback_identity_invalid', `第 ${index + 1} 条 ERP 收票回读身份不完整`);
      continue;
    }
    if (row.grossAmount === null || row.netAmount === null || row.taxAmount === null) {
      issue(problems, 'receipt_readback_amount_missing', `收票 ${row.voucherMaterialId} 缺少 fresh 不含税/税额/价税合计`);
      continue;
    }
    if (cents(row.netAmount)! + cents(row.taxAmount)! !== cents(row.grossAmount)) issue(problems, 'receipt_readback_not_conserved', `收票 ${row.voucherMaterialId} 的净额、税额和价税合计不守恒`);
    if (row.source !== 'erp_receipt') issue(problems, 'receipt_readback_source_invalid', `收票 ${row.voucherMaterialId} 的净税值没有标记 ERP 来源`);
    if (facts.has(row.voucherMaterialId)) { issue(problems, 'receipt_readback_duplicate', `ERP 收票回读凭证 ${row.voucherMaterialId} 重复`); continue; }
    facts.set(row.voucherMaterialId, row);
  }
  return facts;
};

/**
 * Build the only preview the fill and save accept. The fresh receipt readback is separate from the receipt check
 * on purpose: a gross-only check cannot manufacture the railway net/tax values.
 */
export function buildErpDraftPreview(args: PreviewInput):
  { ready: true; expectedPreview: ApprovedPreview; fieldPlan: NonNullable<ApprovedPreview['fieldPlan']>; receiptReadback: any[]; problems: Problem[] }
  | { ready: false; expectedPreview: null; fieldPlan: null; problems: Problem[] } {
  const base = buildErpWritePreview(args);
  const problems: Problem[] = [...(base.problems ?? [])];
  if (!base.ready) return { ready: false, expectedPreview: null, fieldPlan: null, problems };
  const preview = structuredClone(base.expectedPreview);
  problems.push(...gateProblems(args.freshGate, preview));
  if (!args.catalog?.versionId || args.catalog.versionId !== preview.versionId) issue(problems, 'catalog_not_fresh', 'ERP 项目目录核验缺少当前事件版本');
  if (!args.catalog?.linesDigest || args.catalog.linesDigest !== previewLinesDigest(args.built)) issue(problems, 'catalog_scope_not_fresh', 'ERP 项目目录核验缺少当前明细范围指纹');
  if (!sameIdentity(args.catalog?.identity, preview.identity)) issue(problems, 'catalog_identity_not_fresh', 'ERP 项目目录核验身份与当前任务不一致');
  const facts = receiptFactsOf(args.receiptReadback, preview, problems);
  const bindingByMaterial = new Map(preview.receiptBindings.map((binding) => [binding.voucherMaterialId, binding]));
  const eventById = new Map<string, any>((args.built?.events ?? []).map((event: any) => [event.eventId, event]));
  const linesByMaterial = new Map<string, PreviewLine[]>();
  for (const line of preview.lines) {
    const routePlan = routePlanOf(line, line.eventId ? eventById.get(line.eventId) : null);
    if (requiresRoute(line) && !routePlan) issue(problems, 'route_structure_missing', `明细 ${line.lineId} 缺少可核实的起点和终点；不按空格猜路线`);
    if (routePlan) line.routePlan = routePlan;
    if (!validDate(line.date) || !validDate(line.endDate)) issue(problems, 'date_plan_invalid', `明细 ${line.lineId} 的 ERP 开始/结束日期不可核实`);
    if (!ERP_INVOICE_TYPES.has(text(line.invoiceType) ?? '') || !text(line.invoiceTypeSource)) issue(problems, 'invoice_type_mapping_missing', `明细 ${line.lineId} 缺少有出处的 ERP 发票类型映射`);
    const group = linesByMaterial.get(line.voucherMaterialId) ?? [];
    group.push(line);
    linesByMaterial.set(line.voucherMaterialId, group);
  }

  for (const [materialId, lines] of linesByMaterial) {
    const fact = facts.get(materialId);
    const binding = bindingByMaterial.get(materialId);
    if (!fact) { issue(problems, 'receipt_readback_binding_missing', `明细凭证 ${materialId} 没有对应 fresh ERP 收票身份`); continue; }
    if (!binding || fact.identityKey !== binding.identityKey || fact.invoiceNumber !== binding.invoiceNumber
      || fact.receiptNumber !== binding.receiptNumber || cents(fact.grossAmount) !== cents(binding.grossAmount)) {
      issue(problems, 'receipt_readback_identity_mismatch', `明细凭证 ${materialId} 的收票身份不是预览绑定的同一张票`);
      continue;
    }
    const gross = lines.reduce((sum, line) => sum + (cents(line.totalAmount) ?? 0), 0);
    if (gross !== cents(fact.grossAmount)) issue(problems, 'receipt_line_gross_mismatch', `凭证 ${materialId} 的明细价税合计与 ERP 收票不一致`);
    const unknownNet = lines.filter((line) => line.netAmount === null);
    const unknownTax = lines.filter((line) => line.taxAmount === null);
    if (unknownNet.length > 0 || unknownTax.length > 0) {
      if (lines.length !== 1 || unknownNet.length !== 1 || unknownTax.length !== 1) {
        issue(problems, 'receipt_unknown_split', `凭证 ${materialId} 的未知净税无法唯一对应到一条明细`);
      } else {
        const line = lines[0]!;
        line.netAmount = fact.netAmount;
        line.taxAmount = fact.taxAmount;
        line.netAmountSource = 'erp_receipt';
        line.taxAmountSource = 'erp_receipt';
      }
    }
    if (lines.some((line) => line.netAmount === null || line.taxAmount === null)) continue;
    const net = lines.reduce((sum, line) => sum + (cents(line.netAmount) ?? 0), 0);
    const tax = lines.reduce((sum, line) => sum + (cents(line.taxAmount) ?? 0), 0);
    if (net !== cents(fact.netAmount)) issue(problems, 'receipt_line_net_mismatch', `凭证 ${materialId} 的明细不含税金额与 ERP 收票不一致`);
    if (tax !== cents(fact.taxAmount)) issue(problems, 'receipt_line_tax_mismatch', `凭证 ${materialId} 的明细税额与 ERP 收票不一致`);
    binding.netAmount = fact.netAmount;
    binding.taxAmount = fact.taxAmount;
    binding.netAmountSource = 'erp_receipt';
    binding.taxAmountSource = 'erp_receipt';
  }
  for (const materialId of facts.keys()) if (!linesByMaterial.has(materialId)) issue(problems, 'receipt_readback_extra', `ERP 收票 ${materialId} 不在当前预览中`);
  if (problems.length) return { ready: false, expectedPreview: null, fieldPlan: null, problems };
  preview.fieldPlan = fieldPlanOf(preview);
  preview.previewDigest = erpWritePreviewDigest(preview);
  return { ready: true, expectedPreview: preview, fieldPlan: preview.fieldPlan, receiptReadback: [...facts.values()], problems: [] };
}
