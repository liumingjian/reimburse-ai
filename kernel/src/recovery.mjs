import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A recovery credential only re-opens local preparation after an ERP write was
// attempted. It is evidence, not an ERP write capability.
export const RECOVERY_SCHEMA_VERSION = 1;
export const RECOVERY_PURPOSE = 'local_preparation_only';
export const REQUIRED_ERP_WRITE_STATE = 'upload_dispatched';
export const DEFAULT_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_READBACK_MAX_AGE_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 1000;
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
};

const digest = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(stable(value)), 'utf8').digest('hex').slice(0, 32);

const ERP_RECEIPT_COLUMNS = Object.freeze({
  invoiceNumber: '发票号码',
  receiptNumber: '收票单',
  total: '价税合计',
});
const EINVOICE_KEY = /^einvoice-20:(\d{20})$/;

const text = (value, label, reasons) => {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value)) {
    reasons.push(`${label} 必须是非空文本`);
    return null;
  }
  return value.trim();
};

const timestamp = (value, label, reasons) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    reasons.push(`${label} 不是有效时间`);
    return null;
  }
  return date.toISOString();
};

const nowValue = (value, reasons) => timestamp(value ?? new Date(), '当前时间', reasons);

const taskSpace = (value, label, reasons) => {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() && !CONTROL.test(value)) return value.trim();
  reasons.push(`${label} 必须是非负整数或非空文本`);
  return null;
};

const normalizeIdentity = (value, label, reasons) => {
  if (!isObject(value)) {
    reasons.push(`${label} 缺少 account/tenant`);
    return null;
  }
  const account = text(value.account, `${label}.account`, reasons);
  const tenant = text(value.tenant, `${label}.tenant`, reasons);
  return account && tenant ? { account, tenant } : null;
};

const normalizeMaterials = (value, label, reasons) => {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push(`${label} 必须是非空材料数组`);
    return [];
  }
  const seen = new Set();
  const materials = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      reasons.push(`${label}[${index}] 不是对象`);
      continue;
    }
    const materialId = text(item.materialId, `${label}[${index}].materialId`, reasons);
    const contentHash = text(item.contentHash, `${label}[${index}].contentHash`, reasons);
    if (!materialId || !contentHash) continue;
    if (seen.has(materialId)) {
      reasons.push(`${label} 有重复 materialId ${materialId}`);
      continue;
    }
    seen.add(materialId);
    materials.push({ materialId, contentHash });
  }
  return materials.sort((a, b) => a.materialId.localeCompare(b.materialId));
};

const normalizeReceiptBindings = (value, label, reasons) => {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push(`${label} 必须是非空逐票数组；聚合金额不能替代逐票身份`);
    return [];
  }
  const materialIds = new Set();
  const identityKeys = new Set();
  const receiptNumbers = new Set();
  const bindings = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      reasons.push(`${label}[${index}] 不是对象`);
      continue;
    }
    const materialId = text(item.materialId, `${label}[${index}].materialId`, reasons);
    const identityValue = item.identity;
    const scheme = text(identityValue?.scheme, `${label}[${index}].identity.scheme`, reasons);
    const key = text(identityValue?.key, `${label}[${index}].identity.key`, reasons);
    const receiptNumber = text(item.receiptNumber, `${label}[${index}].receiptNumber`, reasons);
    const totalCents = item.totalCents;
    if (!Number.isSafeInteger(totalCents)) {
      reasons.push(`${label}[${index}].totalCents 必须是整数分`);
    }
    if (!materialId || !scheme || !key || !receiptNumber || !Number.isSafeInteger(totalCents)) continue;
    if (materialIds.has(materialId)) reasons.push(`${label} 有重复 materialId ${materialId}`);
    if (identityKeys.has(`${scheme}:${key}`)) reasons.push(`${label} 有重复发票身份 ${scheme}:${key}`);
    if (receiptNumbers.has(receiptNumber)) reasons.push(`${label} 有重复 receiptNumber ${receiptNumber}`);
    materialIds.add(materialId);
    identityKeys.add(`${scheme}:${key}`);
    receiptNumbers.add(receiptNumber);
    bindings.push({ materialId, identity: { scheme, key }, receiptNumber, totalCents });
  }
  return bindings.sort((a, b) => a.materialId.localeCompare(b.materialId));
};

const normalizeEgo = (value, label, reasons) => {
  if (!isObject(value)) {
    reasons.push(`${label} 缺少 taskSpace/tabId`);
    return null;
  }
  const space = taskSpace(value.taskSpace, `${label}.taskSpace`, reasons);
  const tabId = text(value.tabId, `${label}.tabId`, reasons);
  return space !== null && tabId ? { taskSpace: space, tabId } : null;
};

/** Persist the automation connection without making ego the recovery contract. */
const normalizeBrowser = (value, label, reasons) => {
  if (!isObject(value)) {
    reasons.push(`${label} 缺少 Chromium/ego 页面身份`);
    return null;
  }
  const transport = text(value.transport, `${label}.transport`, reasons);
  const tabId = text(value.tabId ?? value.cdpTargetId, `${label}.tabId`, reasons);
  if (transport === 'ego') {
    const space = taskSpace(value.taskSpace, `${label}.taskSpace`, reasons);
    return space !== null && tabId ? { transport, taskSpace: space, tabId } : null;
  }
  if (transport === 'chromium-cdp') {
    if (value.browserFamily !== 'chromium') reasons.push(`${label}.browserFamily 必须是 chromium`);
    return value.browserFamily === 'chromium' && tabId
      ? { transport, browserFamily: 'chromium', tabId } : null;
  }
  reasons.push(`${label}.transport 必须是 ego 或 chromium-cdp`);
  return null;
};

const normalizeForm = (value, label, reasons) => {
  if (!isObject(value)) {
    reasons.push(`${label} 缺少唯一表单实例信息`);
    return null;
  }
  const formInstanceId = text(value.formInstanceId ?? value.instanceId,
    `${label}.formInstanceId`, reasons);
  const mode = value.mode;
  if (mode !== 'new') reasons.push(`${label}.mode 必须是 new`);
  if (value.visibleInstances !== 1) reasons.push(`${label}.visibleInstances 必须是 1`);
  if (value.billNo !== null && value.billNo !== '') {
    reasons.push(`${label}.billNo 必须为空`);
  }
  return formInstanceId && mode === 'new' && value.visibleInstances === 1
    && (value.billNo === null || value.billNo === '')
    ? { formInstanceId, mode: 'new', visibleInstances: 1, billNo: null } : null;
};

const normalizeReadback = (value, label, reasons) => {
  if (!isObject(value)) {
    reasons.push(`${label} 缺少 fresh readback`);
    return null;
  }
  const id = text(value.id, `${label}.id`, reasons);
  const observedAt = timestamp(value.observedAt, `${label}.observedAt`, reasons);
  const receipts = normalizeReceiptBindings(value.receipts, `${label}.receipts`, reasons);
  return id && observedAt ? { id, observedAt, receipts } : null;
};

const checkFresh = (observedAt, nowMs, maxAgeMs, label, reasons) => {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return;
  if (observedMs - nowMs > CLOCK_SKEW_MS) reasons.push(`${label} 时间晚于当前时间`);
  if (nowMs - observedMs > maxAgeMs) reasons.push(`${label} 已过期，必须重新只读回读`);
};

const compareBindings = (expected, actual, reasons) => {
  if (!Array.isArray(actual) || actual.length === 0) {
    reasons.push('ERP fresh readback 缺少逐票 receipt bindings；不能用总额代替身份');
    return;
  }
  if (actual.length !== expected.length) {
    reasons.push(`ERP 收票行数 ${actual.length} 与预期 ${expected.length} 不一致`);
  }
  const expectedByMaterial = new Map(expected.map((item) => [item.materialId, item]));
  const actualByMaterial = new Map(actual.map((item) => [item.materialId, item]));
  for (const item of expected) {
    const got = actualByMaterial.get(item.materialId);
    if (!got) {
      reasons.push(`ERP 缺少材料 ${item.materialId} 对应的收票行`);
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(item)) {
      reasons.push(`材料 ${item.materialId} 的发票身份、receiptNumber 或金额不一致`);
    }
  }
  for (const item of actual) {
    if (!expectedByMaterial.has(item.materialId)) {
      reasons.push(`ERP 出现预期之外的收票材料 ${item.materialId}`);
    }
  }
};

const materialsFor = (materials, label = 'materials') => {
  const reasons = [];
  const normalized = normalizeMaterials(materials, label, reasons);
  if (reasons.length) throw new TypeError(reasons.join('；'));
  return normalized;
};

const receiptsFor = (receipts, label = 'receiptBindings') => {
  const reasons = [];
  const normalized = normalizeReceiptBindings(receipts, label, reasons);
  if (reasons.length) throw new TypeError(reasons.join('；'));
  return normalized;
};

const erpAmountCents = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[¥￥,\s]/g, '');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[2]);
  const amount = whole * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) return null;
  return match[1] === '-' ? -amount : amount;
};

const invoiceNumberOf = (binding) => {
  const match = EINVOICE_KEY.exec(binding?.identity?.key ?? '');
  return binding?.identity?.scheme === 'einvoice-20' ? match?.[1] ?? null : null;
};

const rawCell = (row, label) => (typeof row?.values?.[label] === 'string'
  ? row.values[label].trim() : null);

/**
 * Map a read-only ERP receipt grid back to the known local materials.
 *
 * `expectedBindings` must originate from the classified invoice identities;
 * the grid is evidence only. The invoice number is the only lookup key for
 * materialId. This function never matches by amount, receipt order, file name,
 * or a partial identity, and it returns no partial bindings when any row is
 * unknown, duplicated, or mismatched.
 */
export function mapErpReceiptRowsToBindings(expectedBindings, rawGrid) {
  const reasons = [];
  const expected = normalizeReceiptBindings(expectedBindings, 'expectedBindings', reasons);
  const expectedByInvoice = new Map();
  for (const binding of expected) {
    const invoiceNumber = invoiceNumberOf(binding);
    if (!invoiceNumber) {
      reasons.push(`材料 ${binding.materialId} 缺少有效的全电发票身份 key`);
      continue;
    }
    if (expectedByInvoice.has(invoiceNumber)) {
      reasons.push(`预期发票号码 ${invoiceNumber} 重复`);
      continue;
    }
    expectedByInvoice.set(invoiceNumber, binding);
  }

  if (rawGrid?.ok !== true) {
    reasons.push(`ERP 收票网格不可读：${rawGrid?.reason ?? '没有逐行回读结果'}`);
  }
  const columns = Array.isArray(rawGrid?.columns)
    ? rawGrid.columns.map((column) => column?.label).filter((label) => typeof label === 'string')
    : [];
  for (const label of Object.values(ERP_RECEIPT_COLUMNS)) {
    if (!columns.includes(label)) reasons.push(`ERP 收票网格缺少「${label}」列`);
  }

  const allRows = Array.isArray(rawGrid?.rows) ? rawGrid.rows : null;
  if (!allRows) reasons.push('ERP 收票网格缺少逐行 rows');
  const rows = (allRows ?? []).filter((row) => row?.kind === 'data');
  if (rawGrid?.rowCount !== undefined && rawGrid.rowCount !== rows.length) {
    reasons.push(`ERP 收票网格 rowCount ${rawGrid.rowCount} 与 data 行数 ${rows.length} 不一致`);
  }

  const seenInvoices = new Set();
  const seenReceipts = new Set();
  const mapped = [];
  for (const [index, row] of rows.entries()) {
    const invoiceNumber = rawCell(row, ERP_RECEIPT_COLUMNS.invoiceNumber);
    const receiptNumber = rawCell(row, ERP_RECEIPT_COLUMNS.receiptNumber);
    const totalCents = erpAmountCents(row?.values?.[ERP_RECEIPT_COLUMNS.total]);
    let matched = expectedByInvoice.get(invoiceNumber);

    if (!invoiceNumber || !/^\d{20}$/.test(invoiceNumber)) {
      reasons.push(`ERP 收票第 ${index + 1} 行缺少有效 20 位发票号码`);
      matched = null;
    } else if (!matched) {
      reasons.push(`ERP 收票第 ${index + 1} 行发票号码 ${invoiceNumber} 不在本次预期集合中`);
    }
    if (!receiptNumber) reasons.push(`ERP 收票第 ${index + 1} 行缺少收票单号`);
    if (totalCents === null) reasons.push(`ERP 收票第 ${index + 1} 行价税合计不可读`);
    if (invoiceNumber && seenInvoices.has(invoiceNumber)) {
      reasons.push(`ERP 收票发票号码 ${invoiceNumber} 重复`);
      matched = null;
    }
    if (receiptNumber && seenReceipts.has(receiptNumber)) {
      reasons.push(`ERP 收票单号 ${receiptNumber} 重复`);
      matched = null;
    }
    if (invoiceNumber) seenInvoices.add(invoiceNumber);
    if (receiptNumber) seenReceipts.add(receiptNumber);
    if (!matched) continue;
    if (receiptNumber !== matched.receiptNumber) {
      reasons.push(`发票 ${invoiceNumber} 的收票单号与预期不一致`);
      continue;
    }
    if (totalCents !== matched.totalCents) {
      reasons.push(`发票 ${invoiceNumber} 的价税合计与预期不一致`);
      continue;
    }
    mapped.push(matched);
  }

  if (rows.length !== expected.length) {
    reasons.push(`ERP 收票 data 行数 ${rows.length} 与预期 ${expected.length} 不一致`);
  }
  if (mapped.length !== expected.length) {
    reasons.push(`ERP 收票只有 ${mapped.length} 条能与预期逐票绑定，预期 ${expected.length} 条`);
  }
  if (reasons.length) return { ok: false, bindings: [], reasons };
  return { ok: true, bindings: receiptsFor(mapped, 'mappedReceiptBindings'), reasons: [] };
}

export function recoveryMaterialDigest(materials) {
  return digest(materialsFor(materials));
}

export function recoveryReceiptDigest(receipts) {
  return digest(receiptsFor(receipts));
}

export function recoveryFormDigest(form) {
  const reasons = [];
  const normalized = normalizeForm(form, 'form', reasons);
  if (reasons.length || !normalized) throw new TypeError(reasons.join('；') || 'form 无效');
  return digest(normalized);
}

const validateInput = (input, nowMs, maxReadbackAgeMs) => {
  const reasons = [];
  if (!isObject(input)) {
    return { reasons: ['恢复凭据输入必须是对象'] };
  }
  const taskId = text(input.taskId, 'taskId', reasons);
  if (input.erpWriteState !== REQUIRED_ERP_WRITE_STATE) {
    reasons.push(`erpWriteState 必须是 ${REQUIRED_ERP_WRITE_STATE}`);
  }
  const identity = normalizeIdentity(input.identity, 'identity', reasons);
  const inventoryVersionId = text(input.inventoryVersionId, 'inventoryVersionId', reasons);
  const materials = normalizeMaterials(input.materials, 'materials', reasons);
  const receiptBindings = normalizeReceiptBindings(input.receiptBindings, 'receiptBindings', reasons);
  const materialIds = new Set(materials.map((item) => item.materialId));
  for (const item of receiptBindings) {
    if (!materialIds.has(item.materialId)) reasons.push(`receipt ${item.materialId} 不在材料哈希集合中`);
  }
  const browser = input.browser
    ? normalizeBrowser(input.browser, 'browser', reasons)
    : null;
  const ego = input.browser ? null : normalizeEgo(input.ego, 'ego', reasons);
  if (!browser && !ego) reasons.push('恢复凭据缺少 browser 或 ego 页面身份');
  const form = normalizeForm(input.form, 'form', reasons);
  const readback = normalizeReadback(input.readback, 'readback', reasons);
  if (readback) {
    checkFresh(readback.observedAt, nowMs, maxReadbackAgeMs, 'readback', reasons);
    compareBindings(receiptBindings, readback.receipts, reasons);
  }
  const issuedAt = timestamp(input.issuedAt ?? new Date(nowMs), 'issuedAt', reasons);
  const expiresAt = timestamp(
    input.expiresAt ?? new Date(nowMs + DEFAULT_CREDENTIAL_TTL_MS), 'expiresAt', reasons,
  );
  if (issuedAt && expiresAt && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    reasons.push('expiresAt 必须晚于 issuedAt');
  }
  const credentialId = input.credentialId === undefined
    ? crypto.randomBytes(8).toString('hex') : text(input.credentialId, 'credentialId', reasons);
  if (readback && issuedAt && Date.parse(readback.observedAt) - Date.parse(issuedAt) > CLOCK_SKEW_MS) {
    reasons.push('readback 必须不晚于 issuedAt');
  }
  if (reasons.length) return { reasons };
  return {
    reasons, value: { taskId, erpWriteState: REQUIRED_ERP_WRITE_STATE, identity, inventoryVersionId,
      materials, receiptBindings, browser, ego, form, readback, issuedAt, expiresAt, credentialId },
  };
};

const recordWithoutDigest = (value) => {
  const record = { ...value };
  delete record.credentialDigest;
  return record;
};

/**
 * Create and persist a local-preparation-only credential.
 * The caller must supply a fresh normalized readback with one receipt row per
 * expected binding. No task metadata, marker, browser page, or ERP field is
 * changed by this function.
 */
export function createRecoveryCredential(filePath, input, {
  now = new Date(), maxReadbackAgeMs = DEFAULT_READBACK_MAX_AGE_MS, ttlMs = DEFAULT_CREDENTIAL_TTL_MS,
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('恢复凭据文件路径必须显式给出');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs 必须是正整数');
  if (!Number.isSafeInteger(maxReadbackAgeMs) || maxReadbackAgeMs <= 0) {
    throw new TypeError('maxReadbackAgeMs 必须是正整数');
  }
  const timeReasons = [];
  const nowIso = nowValue(now, timeReasons);
  if (timeReasons.length) throw new TypeError(timeReasons.join('；'));
  const nowMs = Date.parse(nowIso);
  const withTimes = { ...input, issuedAt: input?.issuedAt ?? nowIso,
    expiresAt: input?.expiresAt ?? new Date(nowMs + ttlMs).toISOString() };
  const checked = validateInput(withTimes, nowMs, maxReadbackAgeMs);
  if (checked.reasons.length) throw new TypeError(checked.reasons.join('；'));
  const body = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    purpose: RECOVERY_PURPOSE,
    ...checked.value,
    materialsDigest: recoveryMaterialDigest(checked.value.materials),
    receiptDigest: recoveryReceiptDigest(checked.value.receiptBindings),
    formDigest: recoveryFormDigest(checked.value.form),
    readback: {
      id: checked.value.readback.id,
      observedAt: checked.value.readback.observedAt,
      receiptDigest: recoveryReceiptDigest(checked.value.readback.receipts),
      formDigest: recoveryFormDigest(checked.value.form),
    },
  };
  // The credential keeps the expected bindings, but not ERP detail values or
  // local fields that may be changed during the resumed preparation phase.
  const record = { ...body, credentialDigest: digest(body) };
  const target = path.resolve(filePath);
  if (fs.existsSync(target)) {
    const error = new Error(`恢复凭据已存在，拒绝覆盖历史：${target}`);
    error.code = 'RECOVERY_EXISTS';
    throw error;
  }
  const temp = `${target}.tmp`;
  if (fs.existsSync(temp)) {
    const error = new Error(`恢复凭据暂存文件已存在，拒绝覆盖：${temp}`);
    error.code = 'RECOVERY_STAGING_EXISTS';
    throw error;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  return record;
}

/** Read only the explicitly named credential file. Invalid JSON returns null. */
export function readRecoveryCredential(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch {
    return null;
  }
}

const invalidResult = (reasons, extra = {}) => ({
  valid: false,
  status: 'rejected',
  reasons,
  capabilities: { localPreparation: false, erpWrite: false, upload: false, newTask: false, reset: false },
  ...extra,
});

/**
 * Validate a credential against a newly collected local/task/ERP snapshot.
 * current.readback.receipts must already be normalized to exact invoice
 * identity, receiptNumber and integer totalCents. Detail rows are deliberately
 * ignored: an automatically generated or incorrect detail can never authorize
 * ERP writing through this module.
 */
export function validateRecoveryCredential(credential, current, {
  now = new Date(), maxReadbackAgeMs = DEFAULT_READBACK_MAX_AGE_MS,
} = {}) {
  const reasons = [];
  if (!Number.isSafeInteger(maxReadbackAgeMs) || maxReadbackAgeMs <= 0) {
    return invalidResult(['maxReadbackAgeMs 必须是正整数']);
  }
  const timeReasons = [];
  const nowIso = nowValue(now, timeReasons);
  if (timeReasons.length) return invalidResult(timeReasons);
  const nowMs = Date.parse(nowIso);
  if (!isObject(credential)) return invalidResult(['恢复凭据不存在或不是对象']);

  const suppliedDigest = credential.credentialDigest;
  if (typeof suppliedDigest !== 'string' || suppliedDigest !== digest(recordWithoutDigest(credential))) {
    reasons.push('恢复凭据完整性摘要不匹配');
  }
  if (credential.schemaVersion !== RECOVERY_SCHEMA_VERSION) reasons.push('恢复凭据 schemaVersion 不支持');
  if (credential.purpose !== RECOVERY_PURPOSE) reasons.push('恢复凭据用途不是 local_preparation_only');
  if (credential.erpWriteState !== REQUIRED_ERP_WRITE_STATE) {
    reasons.push(`恢复凭据 marker 必须是 ${REQUIRED_ERP_WRITE_STATE}`);
  }
  const taskId = text(credential.taskId, 'credential.taskId', reasons);
  const identity = normalizeIdentity(credential.identity, 'credential.identity', reasons);
  const inventoryVersionId = text(credential.inventoryVersionId, 'credential.inventoryVersionId', reasons);
  const materials = normalizeMaterials(credential.materials, 'credential.materials', reasons);
  const receiptBindings = normalizeReceiptBindings(credential.receiptBindings,
    'credential.receiptBindings', reasons);
  const browser = credential.browser
    ? normalizeBrowser(credential.browser, 'credential.browser', reasons)
    : null;
  const ego = credential.browser ? null : normalizeEgo(credential.ego, 'credential.ego', reasons);
  if (!browser && !ego) reasons.push('credential 缺少 browser 或 ego 页面身份');
  const form = normalizeForm(credential.form, 'credential.form', reasons);
  const issuedAt = timestamp(credential.issuedAt, 'credential.issuedAt', reasons);
  const expiresAt = timestamp(credential.expiresAt, 'credential.expiresAt', reasons);
  if (expiresAt && Date.parse(expiresAt) <= nowMs) reasons.push('恢复凭据已过期');
  const storedReadback = normalizeReadback({
    id: credential.readback?.id,
    observedAt: credential.readback?.observedAt,
    receipts: receiptBindings,
  }, 'credential.readback', reasons);
  if (storedReadback) checkFresh(storedReadback.observedAt, nowMs, maxReadbackAgeMs,
    'credential.readback', reasons);
  if (credential.materialsDigest !== recoveryMaterialDigestSafe(materials)) {
    reasons.push('恢复凭据材料哈希摘要不匹配');
  }
  if (credential.receiptDigest !== recoveryReceiptDigestSafe(receiptBindings)) {
    reasons.push('恢复凭据 receipt 摘要不匹配');
  }
  if (form && credential.formDigest !== recoveryFormDigestSafe(form)) {
    reasons.push('恢复凭据表单摘要不匹配');
  }
  if (storedReadback && credential.readback?.receiptDigest !== recoveryReceiptDigestSafe(receiptBindings)) {
    reasons.push('恢复凭据 readback receipt 摘要不匹配');
  }
  if (storedReadback && credential.readback?.formDigest !== recoveryFormDigestSafe(form)) {
    reasons.push('恢复凭据 readback 表单摘要不匹配');
  }
  const materialIds = new Set(materials.map((item) => item.materialId));
  for (const item of receiptBindings) {
    if (!materialIds.has(item.materialId)) reasons.push(`credential receipt ${item.materialId} 不在材料集合中`);
  }

  if (!isObject(current)) return invalidResult([...reasons, '当前恢复快照不存在'], { taskId });
  if (current.taskId !== taskId) reasons.push('当前 taskId 与恢复凭据不一致');
  if (current.erpWriteState !== REQUIRED_ERP_WRITE_STATE) reasons.push('当前任务 marker 已变化，拒绝恢复');
  const currentIdentity = normalizeIdentity(current.identity, 'current.identity', reasons);
  if (identity && currentIdentity && JSON.stringify(identity) !== JSON.stringify(currentIdentity)) {
    reasons.push('当前 account/tenant 与恢复凭据不一致');
  }
  if (current.inventoryVersionId !== inventoryVersionId) reasons.push('当前 inventoryVersionId 与恢复凭据不一致');
  const currentMaterials = normalizeMaterials(current.materials, 'current.materials', reasons);
  if (materials.length && currentMaterials.length
    && recoveryMaterialDigestSafe(materials) !== recoveryMaterialDigestSafe(currentMaterials)) {
    reasons.push('当前材料哈希与恢复凭据不一致');
  }
  const currentBrowser = browser
    ? normalizeBrowser(current.browser, 'current.browser', reasons)
    : null;
  const currentEgo = ego ? normalizeEgo(current.ego, 'current.ego', reasons) : null;
  if (browser && currentBrowser && JSON.stringify(browser) !== JSON.stringify(currentBrowser)) {
    reasons.push('当前 Chromium 页面与恢复凭据不一致');
  }
  if (ego && currentEgo && JSON.stringify(ego) !== JSON.stringify(currentEgo)) {
    reasons.push('当前 ego taskSpace/tabId 与恢复凭据不一致');
  }
  const currentForm = normalizeForm(current.form, 'current.form', reasons);
  if (form && currentForm && recoveryFormDigestSafe(form) !== recoveryFormDigestSafe(currentForm)) {
    reasons.push('当前 ERP 表单不是凭据记录的唯一新增空单');
  }
  const currentReadback = normalizeReadback(current.readback, 'current.readback', reasons);
  if (currentReadback) {
    checkFresh(currentReadback.observedAt, nowMs, maxReadbackAgeMs, 'current.readback', reasons);
    if (storedReadback && Date.parse(currentReadback.observedAt)
      + CLOCK_SKEW_MS < Date.parse(storedReadback.observedAt)) {
      reasons.push('当前 readback 早于凭据所依据的 readback');
    }
    compareBindings(receiptBindings, currentReadback.receipts, reasons);
  }

  const valid = reasons.length === 0;
  return {
    valid,
    status: valid ? 'accepted' : 'rejected',
    reasons,
    credentialId: credential.credentialId ?? null,
    taskId: taskId ?? null,
    receiptCount: receiptBindings.length,
    receiptDigest: credential.receiptDigest ?? null,
    capabilities: {
      localPreparation: valid,
      // This module never grants a write, upload, task creation, or reset capability.
      erpWrite: false,
      upload: false,
      newTask: false,
      reset: false,
    },
  };
}

const recoveryMaterialDigestSafe = (materials) => (materials.length ? digest(materials) : null);
const recoveryReceiptDigestSafe = (receipts) => (receipts.length ? digest(receipts) : null);
const recoveryFormDigestSafe = (form) => (form ? digest(form) : null);
