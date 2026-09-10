import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { takeInventoryForTask } from './inventory.mjs';
import { classifyInventory, classifyOpenItems } from './classify.mjs';
import { gateIdentity, readBinding, bindingVerdict } from './binding.mjs';
import { authorizedPage, queryRows } from './erpcatalog.mjs';
import { readErpForm } from './erpread.mjs';
import { findLiveTaskForSource, recoveryCredentialPath, recoveryCredentialRecordPath,
  recoveryCredentialLatestPath, sourceKeyOf } from './workspace.mjs';
import {
  createRecoveryCredential, readRecoveryCredential, validateRecoveryCredential,
  mapErpReceiptRowsToBindings, REQUIRED_ERP_WRITE_STATE,
} from './recovery.mjs';

const RECEIPT_FORM = 'IV_RecInvBase';
const RECEIPT_FIELDS = 'FBillNo,FIVNUMBER,FSUMALLAMOUNT';
const RECEIPT_COLUMNS = Object.freeze(['发票号码', '收票单', '价税合计']);
const RECEIPT_NUMBER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const INVOICE_NUMBER = /^\d{20}$/;

const credentialRecordName = /^local-preparation-recovery-[A-Za-z0-9_-]+\.json$/;

const readJson = (filePath) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
};

/** Resolve the replaceable latest pointer without trusting an arbitrary path. */
const latestCredentialPath = (task) => {
  const dir = path.dirname(recoveryCredentialPath(task));
  const pointer = readJson(recoveryCredentialLatestPath(task));
  const pointed = recoveryCredentialRecordPath(task, pointer?.credentialId);
  if (pointed && fs.existsSync(pointed)) return pointed;

  const legacy = recoveryCredentialPath(task);
  if (fs.existsSync(legacy)) return legacy;
  try {
    const records = fs.readdirSync(dir).filter((name) => credentialRecordName.test(name))
      .map((name) => {
        const filePath = path.join(dir, name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    return records.at(-1)?.filePath ?? null;
  } catch {
    return null;
  }
};

const pointLatestCredential = (task, credential) => {
  const pointerPath = recoveryCredentialLatestPath(task);
  const tempPath = `${pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({
    schemaVersion: 1,
    credentialId: credential.credentialId,
    fileName: path.basename(recoveryCredentialRecordPath(task, credential.credentialId)),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, pointerPath);
};

const text = (value) => (value === null || value === undefined ? '' : String(value))
  .normalize('NFKC').replace(/\s+/g, ' ').trim();

const compact = (value) => text(value).replace(/\s+/g, '');

const centsOf = (value) => {
  const normalized = text(value).replace(/[¥￥,\s]/g, '');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] === '-' ? -cents : cents;
};

const sameIdentity = (left, right) => !!left && !!right
  && left.account === right.account && left.tenant === right.tenant;

const fail = (status, reasons, extra = {}) => ({ ok: false, status, reasons, ...extra });

const dataRows = (grid) => grid?.ok === true && Array.isArray(grid.rows)
  ? grid.rows.filter((row) => row.kind === 'data') : [];

const invoiceMatches = (actual, expected) => {
  const a = compact(actual);
  if (a === expected) return true;
  // The form may mask only the middle. Four exact leading and trailing digits
  // still identify the invoice; arbitrary fragments do not.
  const masked = /^(\d{4})(?:\*+|…+|·+)(\d{4})$/.exec(a);
  return !!masked && expected.startsWith(masked[1]) && expected.endsWith(masked[2]);
};

const columnsPresent = (grid) => RECEIPT_COLUMNS.every((label) =>
  grid?.columns?.some((column) => column.label === label));

/**
 * Build one canonical ERP receipt grid from the read-only IV_RecInvBase query.
 * The local invoice number and face amount select the expected ticket; the
 * receipt number is accepted only from the unique ERP query row.
 */
export async function queryExpectedReceiptBindings(classification, page, {
  run = queryRows,
} = {}) {
  const invoices = (classification?.results ?? [])
    .filter((result) => result.role === 'primary_voucher' && result.parseStatus === 'parsed');
  const reasons = [];
  if (!invoices.length) reasons.push('当前材料没有可用于恢复的已解析发票');

  const expected = [];
  const rows = [];
  const seenInvoices = new Set();
  for (const invoice of invoices) {
    const number = invoice.identity?.number;
    const totalCents = invoice.fields?.totalAmount?.cents;
    if (!INVOICE_NUMBER.test(number ?? '')) {
      reasons.push(`材料 ${invoice.materialId} 缺少完整 20 位发票号码，不能建立收票身份`);
      continue;
    }
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      reasons.push(`材料 ${invoice.materialId} 缺少可核对的票面价税合计，不能建立收票身份`);
      continue;
    }
    if (seenInvoices.has(number)) {
      reasons.push(`发票号码 ${number} 在当前材料中重复`);
      continue;
    }
    seenInvoices.add(number);

    const result = await run(page, {
      formId: RECEIPT_FORM,
      fieldKeys: RECEIPT_FIELDS,
      filter: `FIVNUMBER = '${number}'`,
      limit: 10,
    });
    if (!result?.ok) {
      reasons.push(`发票 ${number} 的 ERP 原收票查询失败：${result?.reason ?? '没有逐行结果'}`);
      continue;
    }
    if (result.rows.length !== 1) {
      reasons.push(`发票 ${number} 的 ERP 原收票不是唯一一行（实际 ${result.rows.length} 行）`);
      continue;
    }
    const row = result.rows[0];
    const receiptNumber = text(row?.[0]);
    const queriedNumber = compact(row?.[1]);
    const queriedCents = centsOf(row?.[2]);
    if (!INVOICE_NUMBER.test(queriedNumber) || queriedNumber !== number) {
      reasons.push(`发票 ${number} 的 ERP 原收票没有回读同一完整发票号码`);
      continue;
    }
    if (!RECEIPT_NUMBER.test(receiptNumber)) {
      reasons.push(`发票 ${number} 的 ERP 原收票号不可读`);
      continue;
    }
    if (queriedCents !== totalCents) {
      reasons.push(`发票 ${number} 的 ERP 原收票金额与票面价税合计不一致`);
      continue;
    }
    const binding = {
      materialId: invoice.materialId,
      identity: invoice.identity,
      receiptNumber,
      totalCents,
    };
    expected.push(binding);
    rows.push({ kind: 'data', values: {
      发票号码: number, 收票单: receiptNumber, 价税合计: String(row[2] ?? ''),
    } });
  }

  if (reasons.length) return { ok: false, bindings: [], reasons };
  const canonicalGrid = {
    ok: true,
    columns: RECEIPT_COLUMNS.map((label) => ({ label })),
    rowCount: rows.length,
    rows,
  };
  const mapped = mapErpReceiptRowsToBindings(expected, canonicalGrid);
  if (!mapped.ok) return { ok: false, bindings: [], reasons: mapped.reasons };
  return { ok: true, bindings: mapped.bindings, canonicalGrid, reasons: [] };
}

/**
 * Match the current form's raw receipt rows to canonical bindings. A masked
 * middle is expanded only after receipt number, exact amount, and strict
 * invoice prefix/suffix all match; a total cannot select a receipt.
 */
export function normalizeCurrentReceiptGrid(rawGrid, bindings) {
  const reasons = [];
  if (rawGrid?.ok !== true) reasons.push(`当前 ERP 收票网格不可读：${rawGrid?.reason ?? '没有逐行结果'}`);
  if (!columnsPresent(rawGrid)) reasons.push('当前 ERP 收票网格缺少发票号码、收票单或价税合计列');
  const rows = dataRows(rawGrid);
  if (rows.length !== bindings.length) {
    reasons.push(`当前 ERP 收票行数 ${rows.length} 与预期 ${bindings.length} 不一致`);
  }

  const byReceipt = new Map(bindings.map((binding) => [binding.receiptNumber, binding]));
  const seenReceipts = new Set();
  const normalizedRows = [];
  for (const [index, row] of rows.entries()) {
    const values = row?.values ?? {};
    const receiptNumber = text(values['收票单']);
    const invoiceNumber = compact(values['发票号码']);
    const totalCents = centsOf(values['价税合计']);
    const binding = byReceipt.get(receiptNumber);
    if (!binding) {
      reasons.push(`当前 ERP 收票第 ${index + 1} 行的收票号不在原收票查询结果中`);
      continue;
    }
    if (seenReceipts.has(receiptNumber)) reasons.push(`当前 ERP 收票号 ${receiptNumber} 重复`);
    seenReceipts.add(receiptNumber);
    if (!invoiceMatches(invoiceNumber, binding.identity.number)) {
      reasons.push(`当前 ERP 收票号 ${receiptNumber} 的发票身份与材料不一致`);
    }
    if (totalCents !== binding.totalCents) {
      reasons.push(`当前 ERP 收票号 ${receiptNumber} 的价税合计与材料不一致`);
    }
    normalizedRows.push({ ...row, kind: 'data', values: {
      ...values, 发票号码: binding.identity.number,
    } });
  }
  for (const binding of bindings) {
    if (!seenReceipts.has(binding.receiptNumber)) {
      reasons.push(`当前 ERP 收票缺少收票号 ${binding.receiptNumber}`);
    }
  }
  if (reasons.length) return { ok: false, grid: null, reasons };
  return {
    ok: true,
    grid: { ...rawGrid, rows: rawGrid.rows.map((row) => row.kind === 'data'
      ? normalizedRows.shift() : row) },
    reasons: [],
  };
}

const currentTaskFor = (dir) => findLiveTaskForSource(sourceKeyOf(path.resolve(dir)));

const checkIdentity = (task, gate) => {
  if (!task) return fail('task_missing', ['当前材料目录没有进行中的任务']);
  if (!hasRecoveryMarker(task)) return fail('marker_invalid',
    [`当前任务 marker 不是 ${REQUIRED_ERP_WRITE_STATE}，不能创建本地恢复凭据`]);
  if (!sameIdentity(task.identity, gate?.identity)) return fail('identity_mismatch',
    ['当前 ERP 身份与任务身份不一致，不能恢复本地准备']);
  const binding = readBinding();
  if (bindingVerdict(binding, gate.identity) !== 'matched') return fail('identity_mismatch',
    ['当前 ERP 身份与本机绑定不一致，不能恢复本地准备']);
  return null;
};

export const hasRecoveryMarker = (task) => task?.erpWriteState === REQUIRED_ERP_WRITE_STATE;

/**
 * Collect a read-only recovery snapshot. This is deliberately separate from
 * observeTask: ordinary observation remains pure with respect to ERP/browser.
 */
export async function collectRecoverySnapshot(sourceDir, {
  gate = gateIdentity,
  authorize = authorizedPage,
  readForm = readErpForm,
  run = queryRows,
} = {}) {
  const dir = path.resolve(sourceDir);
  const task = currentTaskFor(dir);
  const firstGate = await gate();
  const identityError = checkIdentity(task, firstGate);
  if (identityError) return { ...identityError, task };

  const inventory = await takeInventoryForTask(dir, task);
  if (!task.currentVersionId || task.currentVersionId !== inventory.versionId) {
    return fail('materials_changed', ['当前材料版本与任务 marker 记录不一致，不能创建或使用恢复凭据'],
      { task, inventoryVersionId: inventory.versionId });
  }
  const classification = classifyInventory(dir, inventory, task);
  const classifyProblems = classifyOpenItems(classification).filter((item) => item.blocking);
  if (classifyProblems.length) {
    return fail('classification_blocked', classifyProblems.map((item) => item.note ?? item.kind),
      { task, inventory, classification });
  }

  const authorized = await authorize();
  if (!authorized?.ok || !sameIdentity(task.identity, authorized.probe?.identity)) {
    return fail('identity_mismatch', ['ERP 身份在恢复准备期间变化，不能继续'],
      { task, inventory, classification, identity: authorized?.probe?.identity ?? null });
  }
  if (authorized.page?.transport === 'default') {
    return fail('default_browser_recovery_unsupported',
      ['系统默认浏览器传输只支持正式只读观察；旧 ERP 恢复回读必须显式使用 ego QA transport'],
      { task, inventory, classification, identity: authorized.probe.identity });
  }
  const query = await queryExpectedReceiptBindings(classification, authorized.page, { run });
  if (!query.ok) return fail('receipt_check_failed', query.reasons,
    { task, inventory, classification, identity: authorized.probe.identity });

  const snapshot = await readForm(authorized.page);
  const tabs = snapshot?.formTabs ?? [];
  if (tabs.length !== 1 || tabs[0]?.mode !== 'new') {
    return fail('form_not_new', ['ERP 页面必须只有一个费用报销单-新增页签'],
      { task, inventory, classification, identity: authorized.probe.identity, snapshot });
  }
  if (snapshot.billNo?.ok !== true || text(snapshot.billNo.value) !== '') {
    return fail('form_not_empty', ['ERP 新增单的单据编号必须为空，不能复用已有单据'],
      { task, inventory, classification, identity: authorized.probe.identity, snapshot });
  }
  if (!snapshot.billNo.id || snapshot.billNo.visibleInstances !== 1) {
    return fail('form_not_unique', ['ERP 新增单表单实例无法唯一确认'],
      { task, inventory, classification, identity: authorized.probe.identity, snapshot });
  }

  const normalized = normalizeCurrentReceiptGrid(snapshot.receipts, query.bindings);
  if (!normalized.ok) return fail('receipt_readback_failed', normalized.reasons,
    { task, inventory, classification, identity: authorized.probe.identity, snapshot });

  const finalTask = currentTaskFor(dir);
  if (!finalTask || finalTask.taskId !== task.taskId
    || !hasRecoveryMarker(finalTask)
    || !sameIdentity(finalTask.identity, authorized.probe.identity)
    || finalTask.currentVersionId !== inventory.versionId) {
    return fail('task_changed', ['恢复准备期间任务身份、版本或 ERP marker 发生变化，不能落盘'],
      { task: finalTask ?? task, inventory, classification });
  }

  const observedAt = new Date().toISOString();
  const form = {
    formInstanceId: snapshot.billNo.id,
    mode: 'new',
    visibleInstances: 1,
    billNo: null,
  };
  const materials = inventory.materials
    .filter((material) => typeof material.contentHash === 'string' && material.contentHash.trim())
    .map((material) => ({ materialId: material.materialId, contentHash: material.contentHash }));
  if (!materials.length) return fail('materials_unreadable', ['当前材料没有可绑定的内容哈希'],
    { task, inventory, classification });
  const readback = {
    id: `${task.taskId}:${snapshot.billNo.id}:${observedAt}`,
    observedAt,
    receipts: query.bindings,
  };
  return {
    ok: true,
    task: finalTask,
    inventory,
    classification,
    identity: authorized.probe.identity,
    page: authorized.page,
    snapshot,
    canonicalGrid: query.canonicalGrid,
    currentGrid: normalized.grid,
    input: {
      taskId: finalTask.taskId,
      erpWriteState: finalTask.erpWriteState,
      identity: { account: finalTask.identity.account, tenant: finalTask.identity.tenant },
      inventoryVersionId: inventory.versionId,
      materials,
      receiptBindings: query.bindings,
      ego: { taskSpace: authorized.page.taskSpace, tabId: authorized.page.tabId },
      form,
      readback,
    },
  };
}

export async function createLocalPreparationRecovery(sourceDir, options = {}) {
  const collected = await collectRecoverySnapshot(sourceDir, options);
  if (!collected.ok) return collected;
  const credentialId = crypto.randomBytes(8).toString('hex');
  const filePath = recoveryCredentialRecordPath(collected.task, credentialId);
  try {
    const credential = createRecoveryCredential(filePath, { ...collected.input, credentialId });
    pointLatestCredential(collected.task, credential);
    return {
      ok: true,
      status: 'created',
      credential,
      credentialPath: filePath,
      task: collected.task,
      identity: collected.identity,
      capabilities: { localPreparation: true, erpWrite: false, upload: false, newTask: false, reset: false },
    };
  } catch (error) {
    return fail(error.code === 'RECOVERY_EXISTS' ? 'credential_exists' : 'credential_write_failed',
      [error.message], { task: collected.task, credentialPath: filePath });
  }
}

export async function validateLocalPreparationRecovery(sourceDir, options = {}) {
  const collected = await collectRecoverySnapshot(sourceDir, options);
  if (!collected.ok) return collected;
  const credentialPath = latestCredentialPath(collected.task);
  if (!credentialPath) return fail('credential_missing', ['当前任务没有可读取的本地恢复凭据'],
    { task: collected.task, credentialPath: recoveryCredentialPath(collected.task) });
  const credential = readRecoveryCredential(credentialPath);
  if (!credential) return fail('credential_missing', ['当前任务没有可读取的本地恢复凭据'],
    { task: collected.task, credentialPath });
  const current = {
    ...collected.input,
    identity: collected.identity,
    readback: collected.input.readback,
  };
  const verdict = validateRecoveryCredential(credential, current);
  if (!verdict.valid) return fail('credential_invalid', verdict.reasons,
    { task: collected.task, credentialPath, credential, verdict });
  return {
    ok: true,
    status: 'accepted',
    credential,
    credentialPath,
    verdict,
    ...collected,
  };
}
