// The mutating ERP steps over CDP, plus #32's error capture.
// Origin: 50931a3:kernel/src/erpwrite-cdp.mjs (openNewReimbursement, openInvoiceAssistant, uploadAndImportInvoices
// — split here into uploadInvoices and importInvoices at the ADR-0025 consumption boundary,
// addDetailRow, closeInvoiceAssistant) and 50931a3:kernel/src/invoice-upload.mjs. The kernel's saveReimbursement has
// no counterpart here: ADR-0028 leaves the 保存 (save) click to the employee, so this module cannot perform it.
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

/**
 * Where to send a real mouse event so it reaches `n` — the one measurement every click here depends on.
 *
 * `Input.dispatchMouseEvent` hits VIEWPORT coordinates, and a point outside the viewport hits nothing at all:
 * the click is swallowed in silence, and the step that follows waits for an effect that can never arrive.
 * Measured live on 2026-09-19 while the assistant refused to open (INVOICE_ASSISTANT_NOT_FOUND): the 收票信息
 * anchor had not finished scrolling, so 选择发票 sat at y=1237 and 不生成费用明细 at y=941 in a viewport 908 high,
 * `document.elementFromPoint` returned null at both points, and both clicks were lost. Rendered and laid out is
 * not the same as reachable, and `visible` above only answers the first.
 *
 * So a point is scrolled into view and re-measured before it is used, and a node that is still unreachable
 * reports `ok: false` rather than being clicked blind — every caller polls, so the next poll re-measures.
 * `erpform.ts` has scrolled its grid cells into view from the start; this is that same discipline for the
 * toolbar, the menus and the assistant.
 */
const pointOf = `(n) => {
  const inView = (b) => b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth;
  let b = n.getBoundingClientRect();
  if (!inView(b)) { n.scrollIntoView({ block: 'center' }); b = n.getBoundingClientRect(); }
  if (!inView(b)) return { ok: false, offscreen: true };
  return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}`;

const textPoint = (text: string, { exact = true } = {}) => `(() => {
  const wanted = ${JSON.stringify(String(text))};
  const vis = ${visible};
  const at = ${pointOf};
  const nodes = [...document.querySelectorAll('body *')].filter((n) => {
    if (!vis(n) || n.children.length !== 0) return false;
    const value = String(n.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${exact ? 'value === wanted' : 'value.includes(wanted)'};
  });
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  return at(nodes[0]);
})()`;

const cssPoint = (selector: string) => `(() => {
  const vis = ${visible};
  const at = ${pointOf};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  return at(nodes[0]);
})()`;

type Point = { ok: boolean; x: number; y: number; count?: number; offscreen?: boolean };

async function clickCss(page: WritePage, session: CdpSession, selector: string, label: string, { timeoutMs = 15_000 } = {}) {
  const point = await waitFor(() => evalIn<Point>(session, cssPoint(selector)), (result) => result?.ok === true, cap(page, timeoutMs), paceOf(page).pollMs);
  if (!point?.ok) {
    throw new ExecutorError('CHROMIUM_TARGET_NOT_UNIQUE',
      point?.offscreen ? `${label}停在视口之外，无法点击` : `${label}不可唯一定位（匹配 ${point?.count ?? 0} 个）`);
  }
  await clickAt(session, point.x, point.y);
  return point;
}

async function clickText(page: WritePage, session: CdpSession, text: string, { timeoutMs = 15_000, exact = true } = {}) {
  const point = await waitFor(() => evalIn<Point>(session, textPoint(text, { exact })), (result) => result?.ok === true, cap(page, timeoutMs), paceOf(page).pollMs);
  if (!point?.ok) throw new ExecutorError('CHROMIUM_TARGET_NOT_FOUND', `找不到唯一的「${text}」按钮或菜单项`);
  await clickAt(session, point.x, point.y);
  return point;
}

async function clickPoint(page: WritePage, session: CdpSession, snippet: string, label: string, { timeoutMs = 15_000 } = {}) {
  const point = await waitFor(() => evalIn<Point>(session, snippet), (result) => result?.ok === true, cap(page, timeoutMs), paceOf(page).pollMs);
  if (!point?.ok) throw new ExecutorError('CHROMIUM_TARGET_NOT_FOUND', `找不到${label}`);
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
// 发票无忧助手 opens on its entry menu (电脑端选取 / 手机端选取 / 扫码枪扫描 / 扫描仪扫描). Only 电脑端选取 reaches
// the view that carries the file input, and it is an `<a>` wrapping an icon whose 电脑端选取 caption is a SIBLING
// `<p>`: clicking the caption does nothing at all.
//
// The anchor is also unmeasurable in the usual way. Live on 2026-09-19 it reports a 76x0 rect — it is inline and its
// only child is a block `<img>` (76x74), which contributes nothing to the anchor's own line box. Filtering anchors by
// "has a non-empty rect" therefore discards the one entry we want, which is how this step failed with
// `找不到发票助手的「电脑端选取」入口` on a page that was showing all four entries. So the anchor is located
// structurally (exactly one `a[href]` inside the visible `.accessItem`) and measured by whatever it paints.
const computerPickerPoint = `(() => {
  const vis = ${visible};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const caption = [...document.querySelectorAll('body *')].find((n) => vis(n) && own(n) === '电脑端选取');
  if (!caption) return { ok: false, count: 0 };
  const item = caption.closest('.accessItem') || caption.parentElement;
  const anchors = item ? [...item.querySelectorAll('a[href]')] : [];
  if (anchors.length !== 1) return { ok: false, count: anchors.length };
  const painted = [anchors[0], ...anchors[0].querySelectorAll('*')]
    .find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!painted) return { ok: false, count: 0 };
  return (${pointOf})(painted);
})()`;

// The entry menu is ready when its document has finished loading and the ONE entry this step goes on to click,
// 电脑端选取, is laid out with a destination.
//
// It used to ask that of every entry, and that can never be true on the live page: 手机端选取 is the 扫码
// (scan-the-QR) entry, and it holds no link at all — it expands its QR in place and says
// 「关闭窗口后，再次打开请重新扫码！」. Measured live 2026-09-19 with all four entries painted and the document
// complete: accessItemVisible 4, withAnchor 3, verdict false. So the wait ran its full 30s and aborted with
// INVOICE_ASSISTANT_ENTRY_NOT_READY on a menu that was, to the eye and to the click, entirely ready. The fixture
// had given 手机端选取 an `href="#mobile"` it does not have, so the fake could never show this.
//
// Requiring a destination of an entry nobody clicks was always the wrong question. Ask it of the entry we use.
const assistantEntryReady = `(() => {
  if (document.readyState !== 'complete') return false;
  const vis = ${visible};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const items = [...document.querySelectorAll('.accessItem')].filter(vis);
  if (items.length < 4) return false;
  const caption = [...document.querySelectorAll('body *')].find((n) => vis(n) && own(n) === '电脑端选取');
  const picker = caption ? caption.closest('.accessItem') : null;
  return Boolean(picker && picker.querySelector('a[href]'));
})()`;

const fileInputCount = (session: CdpSession) =>
  evalIn<number>(session, `document.querySelectorAll('input[type=file]').length`);

// Some assistant captions are not leaf nodes, so this asks for a node's OWN text rather than `textPoint`'s leaf.
const hasOwnText = (text: string) => `(() => {
  const vis = ${visible};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  return [...document.querySelectorAll('body *')].some((n) => vis(n) && own(n) === ${JSON.stringify(text)});
})()`;

const uploadState = (session: CdpSession) => evalIn<{ processing: boolean; rows: Array<{ checked: boolean }> }>(session, `(() => {
  const vis = ${visible};
  const rows = [...document.querySelectorAll('input.ant-checkbox-input')].filter((n) => vis(n) && !n.closest('thead'));
  return { processing: (document.body?.innerText || '').includes('上传处理中'), rows: rows.map((n) => ({ checked: n.checked })) };
})()`);

/**
 * Upload the staged invoice files into the assistant, wait for recognition, and select every recognised row.
 * Writes nothing and consumes nothing: ADR-0025 puts the consumption boundary at the 发票导入单据 click, which
 * lives in `importInvoices`. Splitting there is what lets the caller record its attempt between the two, so a
 * failure while uploading leaves a task that can still be retried and still be voided.
 */
export async function uploadInvoices(page: WritePage, paths: string[], { timeoutMs = 210_000 } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new ExecutorError('INVOICE_FILES_REQUIRED', '没有可上传的主要发票文件');
  const pace = paceOf(page);
  const groups = invoiceUploadGroups(paths);
  const assistant = await assistantSession(page, Math.min(timeoutMs, 45_000));
  // The entry menu must be more than painted before it is clicked. 电脑端选取 is a plain `<a href>`, so a click that
  // lands before the assistant's own router has taken it over performs a full page load of /fpzs/kdInvoices — and
  // that route, entered cold, loads its document (readyState complete, its scripts fetched) but never mounts:
  // `#root` stays empty for good, so the app sees a blank page with the right URL. Observed live 2026-09-19:
  // clicking immediately produced that blank view every time, and settling first produced the upload view every
  // time. The threshold is not knowable from outside, so this waits generously; `pace` keeps tests instant.
  const entryReady = await waitFor(() => evalIn<boolean>(assistant, assistantEntryReady), Boolean, cap(page, 30_000), pace.pollMs);
  if (!entryReady) throw new ExecutorError('INVOICE_ASSISTANT_ENTRY_NOT_READY', '发票助手的入口页没有就绪');
  await sleep(pace.settleMs * 8);
  // 电脑端选取, then the app sets the files itself from its own staging directory: no employee ever picks a file,
  // and no OS file chooser is ever opened (the input is hidden, which `DOM.setFileInputFiles` does not care about).
  await clickPoint(page, assistant, computerPickerPoint, '发票助手的「电脑端选取」入口', { timeoutMs: 15_000 });
  // 上传发票影像 names the upload view itself. The old code waited for it on the entry menu, where it has never
  // existed: the text was right, its page was not.
  const onUploadView = await waitFor(() => evalIn<boolean>(assistant, hasOwnText('上传发票影像')), Boolean, cap(page, 30_000), pace.pollMs);
  if (!onUploadView) throw new ExecutorError('INVOICE_UPLOAD_VIEW_NOT_FOUND', '发票助手的电脑端选取页没有打开：找不到「上传发票影像」');
  if (!await fileInputCount(assistant)) throw new ExecutorError('INVOICE_FILE_INPUT_NOT_FOUND', '发票助手的电脑端选取页没有文件上传控件');
  // A first visit is covered by a 温馨提示 dialog that swallows clicks on the grid behind it. Later visits have none,
  // so not finding it is normal.
  const notice = await evalIn<Point>(assistant, textPoint('知道了'));
  if (notice?.ok) {
    await clickAt(assistant, notice.x, notice.y);
    await sleep(paceOf(page).settleMs);
  }
  if ((await dataCheckboxes(assistant)).length > 0) {
    throw new ExecutorError('INVOICE_ASSISTANT_NOT_EMPTY', '发票助手中已有未归属的发票行，拒绝把它们混入当前任务');
  }
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
  return { ok: true, selectedRows: rows.length };
}

/**
 * THE import mutation, and the only irreversible act baox performs (ADR-0025, ADR-0028): the 发票导入单据 click
 * binds the selected invoices to this 费用报销单 and mints its 收票单. Nothing before it is irreversible, and
 * nothing may call this without a durable `attempt_started` already recorded.
 */
export async function importInvoices(page: WritePage, { timeoutMs = 45_000 } = {}) {
  const assistant = await assistantSession(page, Math.min(timeoutMs, 45_000));
  await clickText(page, assistant, '发票导入单据', { timeoutMs: 15_000 });
  await clickText(page, assistant, '不生成费用明细', { timeoutMs: 45_000 });
  await waitText(page, page.session, '收票信息', 120_000);
  return { ok: true };
}

/** Add one detail row through the toolbar (新增行). Part of the fill mutation. */
export async function addDetailRow(page: WritePage) {
  await clickCss(page, page.session, 'a[id$="tbNewList"]', '新增明细行');
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
