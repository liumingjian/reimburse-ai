// The mutating ERP steps over CDP, plus #32's error capture.
// Origin: kernel/src/erpwrite-cdp.mjs (openNewReimbursement, openInvoiceAssistant, uploadAndImportInvoices,
// addDetailRow, saveReimbursement, closeInvoiceAssistant) and kernel/src/invoice-upload.mjs.
// Kernel waits are kept as upper bounds; `pace` shortens them on the fake ERP.

import { autoAttach, clickAt, evalIn, screenshot, type CdpSession, type ChildTargets } from './cdp';
import { ExecutorError } from './chromium';
import { showSection } from './erpform';
import { DEFAULT_PACE, sleep, waitFor, type Pace } from './pace';

export type WritePage = { session: CdpSession; children?: ChildTargets; pace?: Pace };

const paceOf = (page: WritePage) => page.pace ?? DEFAULT_PACE;
const cap = (page: WritePage, ms: number) => Math.min(ms, paceOf(page).longMs);

/** Keep the assistant's file-chooser batches homogeneous (pdf / png / jpg). */
export function invoiceUploadGroups(paths: string[] = []): string[][] {
  const groups = new Map<string, string[]>();
  for (const file of paths) {
    const match = /\.([^.]+)$/.exec(String(file));
    const format = (match?.[1] ?? '').toLowerCase().replace('jpeg', 'jpg');
    if (!['pdf', 'png', 'jpg'].includes(format)) throw new ExecutorError('INVOICE_FORMAT_UNSUPPORTED', `发票文件格式不受支持：${file}`);
    const group = groups.get(format) ?? [];
    group.push(file);
    groups.set(format, group);
  }
  return [...groups.values()];
}

const visible = `(n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}`;

const textPoint = (text: string, { exact = true } = {}) => `(() => {
  const wanted = ${JSON.stringify(String(text))};
  const vis = ${visible};
  const nodes = [...document.querySelectorAll('body *')].filter((n) => {
    if (!vis(n) || n.children.length !== 0) return false;
    const value = String(n.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${exact ? 'value === wanted' : 'value.includes(wanted)'};
  });
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  const b = nodes[0].getBoundingClientRect();
  return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`;

const cssPoint = (selector: string) => `(() => {
  const vis = ${visible};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  const b = nodes[0].getBoundingClientRect();
  return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`;

type Point = { ok: boolean; x: number; y: number; count?: number };

async function clickCss(page: WritePage, session: CdpSession, selector: string, label: string) {
  const point = await evalIn<Point>(session, cssPoint(selector));
  if (!point?.ok) throw new ExecutorError('CHROMIUM_TARGET_NOT_UNIQUE', `${label}不可唯一定位（匹配 ${point?.count ?? 0} 个）`);
  await clickAt(session, point.x, point.y);
  return point;
}

async function clickText(page: WritePage, session: CdpSession, text: string, { timeoutMs = 15_000, exact = true } = {}) {
  const point = await waitFor(() => evalIn<Point>(session, textPoint(text, { exact })), (result) => result?.ok === true, cap(page, timeoutMs), paceOf(page).pollMs);
  if (!point?.ok) throw new ExecutorError('CHROMIUM_TARGET_NOT_FOUND', `找不到唯一的「${text}」按钮或菜单项`);
  await clickAt(session, point.x, point.y);
  return point;
}

const containsText = (needle: string) => `(document.body?.innerText || '').includes(${JSON.stringify(needle)})`;
const waitText = (page: WritePage, session: CdpSession, needle: string, timeoutMs = 15_000) =>
  waitFor(() => evalIn<boolean>(session, containsText(needle)), Boolean, cap(page, timeoutMs), paceOf(page).pollMs);
const waitVisibleText = async (page: WritePage, session: CdpSession, text: string, timeoutMs = 15_000) =>
  (await waitFor(() => evalIn<Point>(session, textPoint(text)), (result) => result?.ok === true, cap(page, timeoutMs), paceOf(page).pollMs))?.ok === true;

/** The piaozone invoice assistant (发票无忧助手) lives in a cross-origin iframe: its own CDP target. */
async function assistantSession(page: WritePage, timeoutMs = 45_000): Promise<CdpSession> {
  page.children ??= await autoAttach(page.session);
  const child = await page.children.waitFor((url) => url.includes('piaozone'), { timeout: cap(page, timeoutMs), interval: paceOf(page).pollMs });
  if (!child) throw new ExecutorError('INVOICE_ASSISTANT_NOT_FOUND', '发票无忧助手没有建立 Chromium 页面连接');
  return child;
}

/** Navigate from the current ERP session to one new reimbursement form. Opens a form; writes nothing. */
export async function openNewReimbursement(page: WritePage, { timeoutMs = 45_000 } = {}) {
  const { session } = page;
  const has = (text: string) => waitVisibleText(page, session, text, paceOf(page).settleMs);
  if (await has('费用报销单-新增')) {
    await clickText(page, session, '费用报销单-新增', { timeoutMs });
  } else if (await has('我的费用报销')) {
    await clickText(page, session, '我的费用报销', { timeoutMs });
    await clickText(page, session, '新增', { timeoutMs });
  } else {
    await clickCss(page, session, '.kd_SystemMenu', 'ERP 主菜单');
    await clickText(page, session, '员工服务', { timeoutMs });
    await clickText(page, session, '我的费用报销', { timeoutMs });
    await clickText(page, session, '新增', { timeoutMs });
  }
  await waitVisibleText(page, session, '费用报销单-新增', timeoutMs);
  return { ok: true, form: '费用报销单-新增' };
}

/** Open the fixed "不生成费用明细" (do not generate expense details) assistant entry. Writes nothing. */
export async function openInvoiceAssistant(page: WritePage, { timeoutMs = 90_000 } = {}) {
  const { session } = page;
  page.children ??= await autoAttach(session);
  const section = await showSection(session, '收票信息', { settleMs: paceOf(page).settleMs });
  if (!section.ok) throw new ExecutorError('INVOICE_ASSISTANT_ENTRY_NOT_FOUND', section.reason);
  await clickCss(page, session, 'div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow', '选择发票下拉按钮');
  await sleep(paceOf(page).settleMs);
  const menuVisible = await evalIn<boolean>(session, `(() => {
    const vis = ${visible};
    return [...document.querySelectorAll('a[id$="tbNotFillEntry"]')].some(vis);
  })()`);
  if (!menuVisible) {
    await evalIn(session, `(() => {
      const wrapper = document.querySelector('div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"]');
      const split = wrapper && window.jQuery?.(wrapper).data()?.splitButton;
      if (!split || typeof split.toggle !== 'function') return false;
      split.toggle();
      return true;
    })()`);
    await sleep(Math.min(300, paceOf(page).settleMs));
  }
  await clickText(page, session, '不生成费用明细', { timeoutMs });
  await sleep(paceOf(page).settleMs);
  await assistantSession(page, timeoutMs);
  return { ok: true, mode: '不生成费用明细' };
}

const fileInput = async (session: CdpSession, files: string[]) => {
  await session.send('DOM.enable');
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeId) throw new ExecutorError('INVOICE_FILE_INPUT_NOT_FOUND', '发票助手中找不到文件上传控件');
  await session.send('DOM.setFileInputFiles', { nodeId, files });
};

type Checkbox = { checked: boolean; x: number; y: number };
const dataCheckboxes = (session: CdpSession) => evalIn<Checkbox[]>(session, `(() => {
  const vis = ${visible};
  return [...document.querySelectorAll('input.ant-checkbox-input')]
    .filter((n) => vis(n) && !n.closest('thead'))
    .map((n) => { const b = n.getBoundingClientRect();
      return { checked: n.checked, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
})()`);
const uploadState = (session: CdpSession) => evalIn<{ processing: boolean; rows: Array<{ checked: boolean }> }>(session, `(() => {
  const vis = ${visible};
  const rows = [...document.querySelectorAll('input.ant-checkbox-input')].filter((n) => vis(n) && !n.closest('thead'));
  return { processing: (document.body?.innerText || '').includes('上传处理中'), rows: rows.map((n) => ({ checked: n.checked })) };
})()`);

/** THE import mutation: upload, select and import the staged invoice files through the assistant. */
export async function uploadAndImportInvoices(page: WritePage, paths: string[], { timeoutMs = 210_000 } = {}) {
  const { session } = page;
  if (!Array.isArray(paths) || paths.length === 0) throw new ExecutorError('INVOICE_FILES_REQUIRED', '没有可上传的主要发票文件');
  const pace = paceOf(page);
  const groups = invoiceUploadGroups(paths);
  const assistant = await assistantSession(page, Math.min(timeoutMs, 45_000));
  if ((await dataCheckboxes(assistant)).length > 0) {
    throw new ExecutorError('INVOICE_ASSISTANT_NOT_EMPTY', '发票助手中已有未归属的发票行，拒绝把它们混入当前任务');
  }
  if (!await waitText(page, assistant, '上传发票影像', 3000)) await clickText(page, assistant, '上传发票影像', { timeoutMs: 15_000 });
  for (const files of groups) {
    await fileInput(assistant, files);
    const state = await waitFor(() => uploadState(assistant), (value) => Array.isArray(value?.rows) && value.rows.length > 0 && !value.processing, cap(page, 90_000), pace.pollMs);
    if (!Array.isArray(state?.rows) || state.rows.length === 0) throw new ExecutorError('INVOICE_SELECTION_EMPTY', '发票助手没有返回可勾选的识别结果');
    if (state.rows.some((row) => row.checked)) throw new ExecutorError('INVOICE_SELECTION_PRESELECTED', '发票助手返回了预先勾选的识别结果，拒绝继续导入');
  }
  const rows = await dataCheckboxes(assistant);
  if (rows.some((row) => row.checked)) throw new ExecutorError('INVOICE_SELECTION_PRESELECTED', '发票助手返回了预先勾选的识别结果，拒绝继续导入');
  let selected = 0;
  for (const row of rows) {
    await clickAt(assistant, row.x, row.y);
    const checked = await waitFor(() => dataCheckboxes(assistant), (value) => Array.isArray(value) && value.filter((item) => item.checked).length >= selected + 1, cap(page, 5000), pace.pollMs);
    if (!Array.isArray(checked) || checked.filter((item) => item.checked).length < selected + 1) {
      throw new ExecutorError('INVOICE_SELECTION_UNCONFIRMED', '发票识别结果没有确认勾选，拒绝继续导入');
    }
    selected += 1;
  }
  if (!selected) throw new ExecutorError('INVOICE_SELECTION_EMPTY', '发票助手没有可导入的识别结果');
  await clickText(page, assistant, '发票导入单据', { timeoutMs: 15_000 });
  await clickText(page, assistant, '不生成费用明细', { timeoutMs: 45_000 });
  await waitText(page, session, '收票信息', 120_000);
  return { ok: true, selectedRows: rows.length };
}

/** Add one detail row through the toolbar (新增行). Part of the fill mutation. */
export async function addDetailRow(page: WritePage) {
  await clickCss(page, page.session, 'a[id$="tbNewList"]', '新增明细行');
  return { ok: true };
}

/** THE save mutation: one click on 保存. Never retried. */
export async function saveReimbursement(page: WritePage) {
  await clickText(page, page.session, '保存', { timeoutMs: 15_000 });
  return { ok: true };
}

export async function closeInvoiceAssistant(page: WritePage) {
  try {
    await clickCss(page, page.session, 'a[aria-label="Close"]', '关闭发票助手');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * #32's error capture: the verbatim text of visible `.k-window` dialogs, the piaozone assistant's visible text,
 * and a screenshot cropped to the first visible dialog (or the viewport). Read-only; never throws.
 */
export async function captureErpError(page: WritePage): Promise<{ erpText: string[]; screenshot: string | null }> {
  const erpText: string[] = [];
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  try {
    const windows = await evalIn<Array<{ text: string; x: number; y: number; width: number; height: number }>>(page.session, `(() => {
      const vis = ${visible};
      return [...document.querySelectorAll('.k-window')].filter(vis).map((n) => {
        const b = n.getBoundingClientRect();
        return { text: String(n.innerText || '').replace(/\\s+/g, ' ').trim(), x: b.x, y: b.y, width: b.width, height: b.height };
      });
    })()`);
    for (const w of windows ?? []) if (w.text) erpText.push(w.text);
    const first = windows?.[0];
    if (first) clip = { x: first.x, y: first.y, width: first.width, height: first.height };
  } catch { /* the capture must not mask the original failure */ }
  try {
    if (page.children) {
      const assistant = await page.children.waitFor((url) => url.includes('piaozone'), { timeout: 0, interval: 0 });
      if (assistant) {
        const text = await evalIn<string>(assistant, `String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim()`);
        if (text) erpText.push(text);
      }
    }
  } catch { /* same */ }
  return { erpText, screenshot: await screenshot(page.session, clip) };
}
