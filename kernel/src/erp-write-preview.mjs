import crypto from 'node:crypto';

// ERP 写入的草稿预览只拼接已经确认的本地事实。它不读取任务目录，
// 不打开浏览器，也不保存；保存调度和用户授权留给更上层的流程。

const INVOICE_IDENTITY = /^einvoice-20:(\d{20})$/;
const SAFE_RECEIPT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const identityOf = (value) => {
  const account = text(value?.account);
  const tenant = text(value?.tenant);
  return account && tenant ? { account, tenant } : null;
};

const sameIdentity = (left, right) => !!left && !!right
  && left.account === right.account && left.tenant === right.tenant;

const validDate = (value) => {
  const match = DATE.exec(text(value) ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

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

const issue = (problems, code, message, extra = {}) => {
  problems.push({ code, message, ...extra });
};

const digestFor = (built) => {
  const source = Array.isArray(built?.lineItems) ? built.lineItems : [];
  const shape = source.map((line) => [line.lineId, line.voucherMaterialId,
    line.date, line.endDate ?? line.checkOut, line.city, line.totalAmount].join('|'));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
};

const mapEntries = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => [text(entry?.code ?? entry?.number), entry]).filter(([key]) => key);
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, entry]) => [text(key), entry]).filter(([key]) => key);
};

const checkRecord = (record, code, label) => {
  const entryCode = text(record?.code ?? record?.number);
  const name = text(record?.name ?? record?.erpName);
  const verdict = text(record?.verdict);
  if (!entryCode || entryCode !== code || !name || verdict !== 'confirmed') return null;
  return { code, name };
};

const projectRecordOf = (catalog, code) => {
  const hit = mapEntries(catalog?.projects).find(([key]) => key === code)?.[1];
  return checkRecord({ ...hit, code }, code, '项目');
};

const expenseRecordOf = (catalog, expenseItems, code) => {
  const sources = [expenseItems, catalog?.expenseItems, catalog?.expenseItemCatalog,
    catalog?.checked].filter(Boolean);
  for (const source of sources) {
    const hit = mapEntries(source).find(([key]) => key === code)?.[1];
    const record = checkRecord({ ...hit, code }, code, '费用项目');
    if (record) return record;
  }
  return null;
};

const lineDigest = (built) => digestFor(built);

const previewShape = (preview) => ({
  taskId: preview?.taskId ?? null,
  identity: preview?.identity ?? null,
  versionId: preview?.versionId ?? null,
  homeCity: preview?.homeCity ?? null,
  purpose: preview?.purpose ?? null,
  projectSource: preview?.projectSource ?? null,
  projectsFrom: preview?.projectsFrom ?? null,
  lines: (preview?.lines ?? []).map((line) => ({
    lineId: line.lineId ?? null,
    eventId: line.eventId ?? null,
    voucherMaterialId: line.voucherMaterialId ?? null,
    maskedNumber: line.maskedNumber ?? null,
    invoiceNumber: line.invoiceNumber ?? null,
    kind: line.kind ?? null,
    date: line.date ?? null,
    endDate: line.endDate ?? null,
    checkOut: line.checkOut ?? null,
    endDateSource: line.endDateSource ?? null,
    city: line.city ?? null,
    route: line.route ?? null,
    origin: line.origin ?? null,
    destination: line.destination ?? null,
    routeSource: line.routeSource ?? null,
    routePlan: line.routePlan ?? null,
    netAmount: line.netAmount ?? null,
    taxAmount: line.taxAmount ?? null,
    totalAmount: line.totalAmount ?? null,
    netAmountSource: line.netAmountSource ?? null,
    taxAmountSource: line.taxAmountSource ?? null,
    amountSource: line.amountSource ?? null,
    referenceMaterialIds: line.referenceMaterialIds ?? [],
    category: line.category ?? null,
    categoryLabel: line.categoryLabel ?? null,
    categoryBasis: line.categoryBasis ?? null,
    categoryNote: line.categoryNote ?? null,
    expenseItemCode: line.expenseItemCode ?? null,
    expenseItemName: line.expenseItemName ?? null,
    expenseItemSource: line.expenseItemSource ?? null,
    projectCode: line.projectCode ?? null,
    projectName: line.projectName ?? null,
    project: line.project ?? null,
    projectSource: line.projectSource ?? null,
    projectsFrom: line.projectsFrom ?? null,
    invoiceType: line.invoiceType ?? null,
    invoiceTypeLabel: line.invoiceTypeLabel ?? null,
    invoiceTypeSource: line.invoiceTypeSource ?? null,
  })),
  receiptBindings: (preview?.receiptBindings ?? []).map((binding) => ({
    voucherMaterialId: binding.voucherMaterialId ?? null,
    identityKey: binding.identityKey ?? null,
    invoiceNumber: binding.invoiceNumber ?? null,
    receiptNumber: binding.receiptNumber ?? null,
    grossAmount: binding.grossAmount ?? null,
    netAmount: binding.netAmount ?? null,
    taxAmount: binding.taxAmount ?? null,
    netAmountSource: binding.netAmountSource ?? null,
    taxAmountSource: binding.taxAmountSource ?? null,
  })),
  fieldPlan: preview?.fieldPlan ?? null,
});

/** Stable fingerprint for the complete expected write/readback contract. */
export const erpWritePreviewDigest = (preview) => crypto.createHash('sha256')
  .update(JSON.stringify(previewShape(preview))).digest('hex').slice(0, 32);

const normalizeReceiptCheck = (check, index) => {
  const materialId = text(check?.materialId);
  const identityKey = text(check?.identityKey);
  const identity = INVOICE_IDENTITY.exec(identityKey ?? '');
  const rows = Array.isArray(check?.rows) ? check.rows : null;
  const receiptNumber = rows?.length === 1 && Array.isArray(rows[0]) ? text(rows[0][0]) : null;
  const gross = rows?.length === 1 && Array.isArray(rows[0]) ? cents(rows[0][3]) : null;
  return {
    index, materialId, identityKey, invoiceNumber: identity?.[1] ?? null,
    receiptNumber, gross, ok: check?.ok === true,
  };
};

const sameText = (left, right) => text(left) === text(right);
const validInvoiceTypeSource = (value) => {
  const source = text(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};

const accommodationLine = (raw, event) => raw?.category === 'accommodation'
  || event?.category === 'accommodation';

/**
 * Build the input consumed by the strict ERP readback matcher.
 *
 * The returned preview is null unless every line has a project-book project,
 * an ERP-verified project and expense-item name/code pair, a real end date, and
 * a receipt binding whose invoice and receipt numbers are both unique.
 */
export function buildErpWritePreview({
  task,
  built,
  lines,
  selection,
  catalog,
  expenseItems = null,
  receiptCheck,
} = {}) {
  const problems = [];
  const taskIdentity = identityOf(task?.identity);
  const selectedIdentity = identityOf(selection?.identity);
  const previewLines = Array.isArray(lines) ? lines : built?.lineItems;
  const events = Array.isArray(built?.events) ? built.events : null;

  if (!text(task?.taskId)) issue(problems, 'task_id_missing', '任务缺少 taskId');
  if (!taskIdentity) issue(problems, 'task_identity_missing', '任务缺少已确认的 account/tenant 身份');
  if (!built || !text(built.versionId)) issue(problems, 'built_version_missing', '事件构建结果缺少 versionId');
  if (task?.currentVersionId && built?.versionId && task.currentVersionId !== built.versionId) {
    issue(problems, 'built_version_stale', '事件构建版本与任务当前版本不一致');
  }
  if (!events?.length) issue(problems, 'events_missing', '事件构建结果缺少已确认 events');
  if (!Array.isArray(previewLines) || !previewLines.length) {
    issue(problems, 'lines_missing', '没有已确认的费用明细行');
  }

  const eventById = new Map();
  for (const event of events ?? []) {
    const eventId = text(event?.eventId);
    const materialId = text(event?.voucherMaterialId);
    if (!eventId || !materialId) {
      issue(problems, 'event_identity_missing', '事件缺少 eventId 或 voucherMaterialId');
      continue;
    }
    if (eventById.has(eventId)) issue(problems, 'event_id_duplicate', `事件 ${eventId} 重复`);
    eventById.set(eventId, event);
  }

  if (!selection) {
    issue(problems, 'selection_missing', '缺少任务选择记录');
  } else {
    if (!sameIdentity(taskIdentity, selectedIdentity)) {
      issue(problems, 'selection_identity_mismatch', '任务选择身份与任务身份不一致');
    }
    if (selection.projectSource !== 'erp_catalog_confirmed') {
      issue(problems, 'project_source_not_ready', '任务选择没有 erp_catalog_confirmed 来源证据');
    }
    if (selection.projectsFrom !== 'project_book') {
      issue(problems, 'projects_from_not_ready', '任务选择不是从本人 project_book 选择');
    }
    if (!text(selection.versionId) || selection.versionId !== built?.versionId) {
      issue(problems, 'selection_version_stale', '任务选择版本与事件版本不一致');
    }
    if (selection.linesDigest !== lineDigest(built)) {
      issue(problems, 'selection_lines_stale', '任务选择明细指纹与当前事件明细不一致');
    }
  }

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    issue(problems, 'catalog_missing', '缺少已核验的 ERP 主数据目录');
  } else {
    if (catalog.versionId && catalog.versionId !== built?.versionId) {
      issue(problems, 'catalog_version_stale', 'ERP 主数据核验版本与事件版本不一致');
    }
    if (catalog.linesDigest && catalog.linesDigest !== lineDigest(built)) {
      issue(problems, 'catalog_lines_stale', 'ERP 主数据核验明细指纹与当前事件明细不一致');
    }
    if (catalog.identity && !sameIdentity(catalog.identity, taskIdentity)) {
      issue(problems, 'catalog_identity_mismatch', 'ERP 主数据核验身份与任务身份不一致');
    }
  }

  const selectedProjects = selection?.projects && typeof selection.projects === 'object'
    ? selection.projects : {};
  const normalizedLines = [];
  const lineIds = new Set();
  const materialIds = new Set();

  for (const [index, raw] of (Array.isArray(previewLines) ? previewLines : []).entries()) {
    const lineId = text(raw?.lineId);
    const eventId = text(raw?.eventId);
    const materialId = text(raw?.voucherMaterialId);
    const event = eventById.get(eventId);
    if (!lineId) issue(problems, 'line_id_missing', `第 ${index + 1} 行缺少 lineId`);
    if (lineId && lineIds.has(lineId)) issue(problems, 'line_id_duplicate', `明细 ${lineId} 重复`);
    if (lineId) lineIds.add(lineId);
    if (!event) issue(problems, 'line_event_missing', `明细 ${lineId ?? index + 1} 没有对应事件`);
    if (!materialId) issue(problems, 'line_voucher_missing', `明细 ${lineId ?? index + 1} 缺少 voucherMaterialId`);
    if (event && materialId !== text(event.voucherMaterialId)) {
      issue(problems, 'line_voucher_mismatch', `明细 ${lineId ?? index + 1} 的凭证与事件不一致`);
    }
    if (materialId) materialIds.add(materialId);

    const projectCode = text(raw?.projectCode ?? raw?.project ?? selectedProjects[lineId]);
    const projectSource = text(raw?.projectSource);
    const projectsFrom = text(raw?.projectsFrom);
    if (!projectCode) issue(problems, 'project_missing', `明细 ${lineId ?? index + 1} 缺少项目号`);
    if (selection && (!Object.prototype.hasOwnProperty.call(selectedProjects, lineId)
      || !sameText(projectCode, selectedProjects[lineId]))) {
      issue(problems, 'project_selection_mismatch', `明细 ${lineId ?? index + 1} 与任务选择项目号不一致`);
    }
    if (projectSource !== 'erp_catalog_confirmed') {
      issue(problems, 'project_source_not_ready', `明细 ${lineId ?? index + 1} 缺少 erp_catalog_confirmed 来源`);
    }
    if (projectsFrom !== 'project_book') {
      issue(problems, 'projects_from_not_ready', `明细 ${lineId ?? index + 1} 不是 project_book 来源`);
    }
    const project = projectCode ? projectRecordOf(catalog, projectCode) : null;
    if (!project) issue(problems, 'project_catalog_missing', `项目 ${projectCode ?? lineId ?? index + 1} 没有已核验的 ERP 名称`);

    const expenseItemCode = text(raw?.expenseItemCode);
    const expenseItemName = text(raw?.expenseItemName);
    if (!expenseItemCode || !expenseItemName) {
      issue(problems, 'expense_item_missing', `明细 ${lineId ?? index + 1} 缺少费用项目编码和名称`);
    }
    const expense = expenseItemCode ? expenseRecordOf(catalog, expenseItems, expenseItemCode) : null;
    if (!expense || expense.name !== expenseItemName) {
      issue(problems, 'expense_item_catalog_mismatch', `费用项目 ${expenseItemCode ?? lineId ?? index + 1} 没有精确的 ERP 编码/名称核验`);
    }

    const date = text(raw?.date);
    const explicitEndDate = text(raw?.endDate ?? raw?.checkOut);
    const isAccommodation = accommodationLine(raw, event);
    // ERP uses one date for a same-day ride/rail line. Only accommodation may
    // carry a distinct checkout; never invent date + 1 or use issueDate.
    const endDate = explicitEndDate ?? (!isAccommodation ? date : null);
    if (!validDate(date)) issue(problems, 'line_date_invalid', `明细 ${lineId ?? index + 1} 缺少有效费用日期`);
    if (!validDate(endDate)) issue(problems, 'end_date_missing', `明细 ${lineId ?? index + 1} 缺少可证实的结束日期`);

    const kind = raw?.kind ?? event?.kind ?? null;
    const totalAmount = amountText(raw?.totalAmount);
    const netAmount = raw?.netAmount === null || raw?.netAmount === undefined
      ? null : amountText(raw.netAmount);
    const taxAmount = raw?.taxAmount === null || raw?.taxAmount === undefined
      ? null : amountText(raw.taxAmount);
    if (totalAmount === null) issue(problems, 'line_total_invalid', `明细 ${lineId ?? index + 1} 缺少有效价税合计`);
    if (raw?.netAmount !== null && raw?.netAmount !== undefined && netAmount === null) {
      issue(problems, 'line_net_invalid', `明细 ${lineId ?? index + 1} 的不含税金额无效`);
    }
    if (raw?.taxAmount !== null && raw?.taxAmount !== undefined && taxAmount === null) {
      issue(problems, 'line_tax_invalid', `明细 ${lineId ?? index + 1} 的税额无效`);
    }
    if (netAmount !== null && taxAmount !== null && cents(netAmount) + cents(taxAmount) !== cents(totalAmount)) {
      issue(problems, 'line_amount_not_conserved', `明细 ${lineId ?? index + 1} 的不含税金额、税额和价税合计不守恒`);
    }
    if (kind !== 'rail_eticket' && netAmount === null) {
      issue(problems, 'line_net_missing', `明细 ${lineId ?? index + 1} 不是铁路客票，却缺少票面不含税金额`);
    }
    if (kind !== 'rail_eticket' && taxAmount === null) {
      issue(problems, 'line_tax_missing', `明细 ${lineId ?? index + 1} 不是铁路客票，却缺少票面税额`);
    }

    normalizedLines.push({
      lineId, eventId, voucherMaterialId: materialId,
      maskedNumber: text(raw?.maskedNumber ?? event?.maskedNumber),
      invoiceNumber: text(raw?.invoiceNumber ?? event?.invoiceNumber),
      kind,
      date, endDate, checkOut: explicitEndDate,
      city: raw?.city ?? event?.city ?? null,
      route: raw?.route ?? event?.route ?? null,
      origin: text(raw?.origin ?? event?.origin),
      destination: text(raw?.destination ?? event?.destination),
      routeSource: text(raw?.routeSource ?? event?.routeSource),
      netAmount, taxAmount, totalAmount,
      amountSource: raw?.amountSource ?? event?.amountSource ?? null,
      referenceMaterialIds: raw?.referenceMaterialIds ?? event?.referenceMaterialIds ?? [],
      netAmountSource: netAmount === null ? 'erp_receipt' : text(raw?.netAmountSource) ?? 'invoice_face',
      taxAmountSource: taxAmount === null ? 'erp_receipt' : text(raw?.taxAmountSource) ?? 'invoice_face',
      endDateSource: explicitEndDate ? 'explicit_line_or_checkout' : 'same_day_date',
      category: raw?.category ?? null,
      categoryLabel: raw?.categoryLabel ?? null,
      categoryBasis: raw?.categoryBasis ?? null,
      categoryNote: raw?.categoryNote ?? null,
      expenseItemCode, expenseItemName,
      expenseItemSource: text(raw?.expenseItemSource),
      projectCode, projectName: project?.name ?? null,
      project: projectCode,
      projectSource, projectsFrom,
      invoiceType: text(raw?.invoiceType ?? raw?.invoiceTypeLabel ?? event?.invoiceType
        ?? event?.invoiceTypeLabel),
      invoiceTypeLabel: text(raw?.invoiceTypeLabel ?? raw?.invoiceType ?? event?.invoiceTypeLabel
        ?? event?.invoiceType),
      invoiceTypeSource: text(raw?.invoiceTypeSource ?? event?.invoiceTypeSource),
    });
    const invoiceType = text(raw?.invoiceType ?? raw?.invoiceTypeLabel ?? event?.invoiceType
      ?? event?.invoiceTypeLabel);
    if (!invoiceType) {
      issue(problems, 'invoice_type_missing', `明细 ${lineId ?? index + 1} 缺少 ERP 发票类型枚举`);
    } else if (!validInvoiceTypeSource(raw?.invoiceTypeSource ?? event?.invoiceTypeSource)) {
      issue(problems, 'invoice_type_source_missing', `明细 ${lineId ?? index + 1} 缺少发票类型映射出处`);
    }
  }

  for (const key of Object.keys(selectedProjects)) {
    if (!lineIds.has(key)) issue(problems, 'selection_extra_line', `任务选择包含不存在的明细 ${key}`);
  }

  const checks = Array.isArray(receiptCheck?.checks) ? receiptCheck.checks : null;
  if (!checks) issue(problems, 'receipt_check_missing', '缺少已落盘 receipt check checks');
  if (receiptCheck && receiptCheck.taskId !== task?.taskId) {
    issue(problems, 'receipt_check_task_mismatch', 'receipt check 不属于当前 taskId');
  }
  if (receiptCheck?.versionId && receiptCheck.versionId !== built?.versionId) {
    issue(problems, 'receipt_check_version_mismatch', 'receipt check 版本与事件版本不一致');
  }

  const bindings = [];
  const byMaterial = new Map();
  for (const [index, raw] of (checks ?? []).entries()) {
    const check = normalizeReceiptCheck(raw, index);
    if (!check.materialId) {
      issue(problems, 'receipt_material_missing', `第 ${index + 1} 条 receipt check 缺少 materialId`);
      continue;
    }
    if (byMaterial.has(check.materialId)) {
      issue(problems, 'receipt_material_duplicate', `receipt check 中凭证 ${check.materialId} 重复`);
      continue;
    }
    byMaterial.set(check.materialId, check);
    if (check.ok !== true) issue(problems, 'receipt_check_failed', `凭证 ${check.materialId} 的 receipt check 未成功`);
    if (!check.invoiceNumber || !check.identityKey) {
      issue(problems, 'receipt_identity_invalid', `凭证 ${check.materialId} 缺少有效 20 位发票身份`);
    }
    if (!check.receiptNumber || !SAFE_RECEIPT_NUMBER.test(check.receiptNumber)) {
      issue(problems, 'receipt_number_invalid', `凭证 ${check.materialId} 缺少唯一收票号`);
    }
    if (!materialIds.has(check.materialId)) {
      issue(problems, 'receipt_material_not_current', `receipt check 凭证 ${check.materialId} 不在当前明细中`);
    }
    const matching = normalizedLines.filter((line) => line.voucherMaterialId === check.materialId);
    const expectedGross = matching.reduce((sum, line) => sum + (cents(line.totalAmount) ?? 0), 0);
    if (check.gross === null || matching.some((line) => line.totalAmount === null) || check.gross !== expectedGross) {
      issue(problems, 'receipt_gross_mismatch', `凭证 ${check.materialId} 的已核对收票金额与明细预览不一致`);
    }
    bindings.push({
      voucherMaterialId: check.materialId,
      identityKey: check.identityKey,
      invoiceNumber: check.invoiceNumber,
      receiptNumber: check.receiptNumber,
      grossAmount: check.gross === null ? null : (check.gross / 100).toFixed(2),
    });
  }
  for (const materialId of materialIds) {
    if (!byMaterial.has(materialId)) issue(problems, 'receipt_binding_missing', `当前凭证 ${materialId} 缺少 receipt check`);
  }
  for (const materialId of byMaterial.keys()) {
    if (!materialIds.has(materialId)) issue(problems, 'receipt_material_not_current', `receipt check 凭证 ${materialId} 不在当前明细中`);
  }

  const seenInvoice = new Set();
  const seenReceipt = new Set();
  for (const binding of bindings) {
    if (!binding.invoiceNumber || !binding.receiptNumber) continue;
    if (seenInvoice.has(binding.invoiceNumber) || seenReceipt.has(binding.receiptNumber)) {
      issue(problems, 'receipt_identity_duplicate', `凭证 ${binding.voucherMaterialId} 的发票号或收票号不唯一`);
    }
    seenInvoice.add(binding.invoiceNumber);
    seenReceipt.add(binding.receiptNumber);
  }

  const homeCity = text(selection?.homeCity ?? task?.homeCity);
  const purpose = text(selection?.purpose);
  if (!homeCity) issue(problems, 'home_city_missing', '预览缺少已确认常驻城市');
  if (!purpose) issue(problems, 'purpose_missing', '预览缺少已确认报销事由');

  if (problems.length) return { ready: false, expectedPreview: null, problems };

  const expectedPreview = {
    taskId: task.taskId,
    identity: taskIdentity,
    versionId: built.versionId,
    homeCity,
    purpose,
    projectSource: 'erp_catalog_confirmed',
    projectsFrom: 'project_book',
    lines: normalizedLines,
    receiptBindings: bindings,
  };
  expectedPreview.previewDigest = erpWritePreviewDigest(expectedPreview);
  return { ready: true, expectedPreview, problems: [] };
}

export const previewLinesDigest = digestFor;
