import { isEgoPage, runEgoPageScript } from './ego.mjs';
import { invoiceUploadGroups } from './invoice-upload.mjs';

const pageRequired = () => {
  const error = new Error('ERP 写入需要 ego task-space page context');
  error.code = 'EGO_PAGE_REQUIRED';
  return error;
};

const runPage = (page, body, deps = {}) => {
  if (!deps.run && !isEgoPage(page)) throw pageRequired();
  return (deps.run ?? runEgoPageScript)(page, body, deps);
};

const visibleTab = 'loc=css:[role="tab"]:has-text("费用报销单-新增") >> nth=0';
const reimbursementTab = 'loc=css:[role="tab"]:has-text("我的费用报销") >> nth=-1';
const reimbursementLink = 'loc=role:link[name*="我的费用报销"]';
const newMenuItem = 'loc=role:menuitem[name*="新增"]';
const receiptTab = 'loc=role:tab[name="收票信息"]';
const assistantFrame = 'loc=css:iframe[src*="piaozone"]';
const rowCheckbox = 'loc=css:td.ant-table-selection-column input.ant-checkbox-input';
const checkedRowCheckbox = 'loc=css:td.ant-table-selection-column input.ant-checkbox-input:checked';

export { invoiceUploadGroups };

/** Navigate from the current ERP session to one unique new reimbursement form. */
export async function openNewReimbursement(page, deps = {}) {
  return runPage(page, `
const present = async (selector) => {
  try { await __page.waitForSelector(selector, { state: 'visible', timeout: 1200 }); return true; }
  catch { return false; }
};
if (await present(${JSON.stringify(visibleTab)})) {
  await __page.click(${JSON.stringify(visibleTab)}, { label: 'activate reimbursement form' });
} else {
  if (await present(${JSON.stringify(reimbursementTab)})) {
    await __page.click(${JSON.stringify(reimbursementTab)}, { label: 'open reimbursement list' });
  } else {
    await __page.click('loc=css:.kd_SystemMenu', { label: 'open ERP main menu' });
    await present('text="员工服务"');
    await __page.click('text="员工服务"', { label: 'open employee services' });
    await __page.waitForSelector(${JSON.stringify(reimbursementLink)}, { state: 'visible', timeout: 15_000 });
    await __page.click(${JSON.stringify(reimbursementLink)}, { label: 'open reimbursement list' });
  }
  await __page.waitForSelector(${JSON.stringify(newMenuItem)}, { state: 'visible', timeout: 30_000 });
  await __page.click(${JSON.stringify(newMenuItem)}, { label: 'create reimbursement form' });
}
await __page.waitForSelector(${JSON.stringify(visibleTab)}, { state: 'visible', timeout: 30_000 });
return { ok: true, form: '费用报销单-新增' };
`, deps);
}

/** Open the fixed no-expense-generation invoice assistant entry. */
export async function openInvoiceAssistant(page, deps = {}) {
  return runPage(page, `
let receiptToolbarVisible = true;
try {
  await __page.waitForSelector('loc=css:div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"]', { state: 'visible', timeout: 1200 });
} catch { receiptToolbarVisible = false; }
if (!receiptToolbarVisible) {
  await __page.click(${JSON.stringify(receiptTab)}, { label: 'show receipt information' });
}
await __page.waitForSelector('loc=css:div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow', { state: 'visible', timeout: 15_000 });
await __page.click('loc=css:div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow', { label: 'open invoice modes' });
await __page.waitForSelector('loc=css:a[id$="tbNotFillEntry"]', { state: 'visible', timeout: 5000 });
await __page.click('loc=css:a[id$="tbNotFillEntry"]', { label: 'choose no expense generation' });
await __page.waitForSelector(${JSON.stringify(assistantFrame)}, { state: 'attached', timeout: 45_000 });
await __page.waitForSelector('text="电脑端选取"', { state: 'visible', timeout: 15_000 });
return { ok: true, mode: '不生成费用明细' };
`, deps);
}

/**
 * Upload, select, and import the invoice files. The assistant is single-use;
 * callers must create it once and never retry after the import click.
 */
export async function uploadAndImportInvoices(page, paths = [], deps = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    const error = new Error('没有可上传的主要发票文件');
    error.code = 'INVOICE_FILES_REQUIRED';
    throw error;
  }
  const groups = invoiceUploadGroups(paths);
  return runPage(page, `
const waitProcessing = async () => {
  try {
    await __page.waitForSelector('text="上传处理中"', { state: 'visible', timeout: 3000 });
    await __page.waitForSelector('text="上传处理中"', { state: 'detached', timeout: 90_000 });
  } catch {}
};
const hasRow = async () => {
  try {
    await __page.waitForSelector(${JSON.stringify(rowCheckbox)} + ' >> nth=1', { state: 'attached', timeout: 1200 });
    return true;
  } catch { return false; }
};
// An assistant reopened with a previous session's rows is unsafe: importing
// would consume more than the current immutable preparation package.
if (await hasRow()) {
  const error = new Error('发票助手中已有未归属的发票行，拒绝把它们混入当前任务');
  error.code = 'INVOICE_ASSISTANT_NOT_EMPTY';
  throw error;
}
for (const files of ${JSON.stringify(groups)}) {
  const chooserPromise = __page.waitForFileChooser({ timeout: 15_000 });
  await __page.click('text="电脑端选取"', { label: 'choose invoice files' });
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
  await waitProcessing();
  await __page.waitForSelector(${JSON.stringify(rowCheckbox)} + ' >> nth=1', { state: 'attached', timeout: 90_000 });
}
// New assistant rows are unselected by contract. Click each data checkbox,
// leaving the header checkbox out of the selection count.
let rowIndex = 1;
let selectedRows = 0;
while (true) {
  const selector = ${JSON.stringify(rowCheckbox)} + ' >> nth=' + rowIndex;
  try { await __page.waitForSelector(selector, { state: 'attached', timeout: 800 }); }
  catch { break; }
  await __page.click(selector, { label: 'select recognized invoice' });
  selectedRows += 1;
  await __page.waitForSelector(${JSON.stringify(checkedRowCheckbox)} + ' >> nth=' + (selectedRows - 1), {
    state: 'attached', timeout: 5000,
  });
  rowIndex += 1;
}
if (!selectedRows) {
  const error = new Error('发票助手没有可勾选的识别结果');
  error.code = 'INVOICE_SELECTION_EMPTY';
  throw error;
}
await __page.click('text="发票导入单据"', { label: 'import invoices into form' });
await __page.waitForSelector('text="是否生成费用明细"', { state: 'visible', timeout: 45_000 });
await __page.click('text="不生成费用明细"', { label: 'confirm no expense generation' });
await __page.waitForSelector(${JSON.stringify(assistantFrame)}, { state: 'detached', timeout: 120_000 });
return { ok: true, selectedRows };
`, deps);
}

/** Add exactly one detail row and leave row-count verification to the caller. */
export async function addDetailRow(page, deps = {}) {
  return runPage(page, `
await __page.click('loc=css:a[id$="tbNewList"]', { label: 'add reimbursement detail row' });
return { ok: true };
`, deps);
}

/** Click the visible ERP save action; postconditions are checked by the caller. */
export async function saveReimbursement(page, deps = {}) {
  return runPage(page, `
await __page.click('loc=role:menuitem[name="保存"]', { label: 'save reimbursement draft' });
return { ok: true };
`, deps);
}

/** Close an assistant left open by an interrupted read-only probe. */
export async function closeInvoiceAssistant(page, deps = {}) {
  return runPage(page, `
try {
  await __page.click('loc=css:a[aria-label="Close"]', { label: 'close invoice assistant' });
  return { ok: true };
} catch { return { ok: false }; }
`, deps);
}
