// The mutating ERP steps over CDP, plus #32's error capture.
// Origin: 50931a3:kernel/src/erpwrite-cdp.mjs (openNewReimbursement, openInvoiceAssistant, uploadAndImportInvoices
// — split here into uploadInvoices and importInvoices at the ADR-0025 consumption boundary,
// addDetailRow, closeInvoiceAssistant) and 50931a3:kernel/src/invoice-upload.mjs. The kernel's saveReimbursement has
// no counterpart here: ADR-0028 leaves the 保存 (save) click to the employee, so this module cannot perform it.
// Kernel waits are kept as upper bounds; `pace` shortens them on the fake ERP.

import { autoAttach, clickAt, evalIn, screenshot, type CdpSession, type ChildTargets } from './cdp';
import { ExecutorError } from './chromium';
import { showSection } from './erpform';
import { readPane, recognisedTotal, selectRecognisedInvoices } from './invoice-grid';
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
  // The result of this wait used to be discarded and `{ok:true}` returned regardless, so a form that never opened
  // was reported as opened; the run then failed further on, with a message about something else entirely — live
  // 2026-09-19, as a version mismatch on a matching version. A step reports what it actually achieved.
  const opened = await waitVisibleText(page, session, '费用报销单-新增', timeoutMs);
  if (!opened) {
    throw new ExecutorError('ERP_NEW_FORM_NOT_OPENED',
      `点过之后 ${Math.round(cap(page, timeoutMs) / 1000)} 秒内没有出现「费用报销单-新增」页签：新的费用报销单没有打开`);
  }
  return { ok: true, form: '费用报销单-新增' };
}

// The three adjacent items of the 选择发票 split menu, in the order they are painted (live 2026-09-19). Only the
// last one leaves the 费用明细 grid alone; the other two make ERP write the detail rows itself, over a bill this
// run is about to import into, and there is no second chance to choose.
const IMPORT_MODES: Readonly<Record<string, string>> = {
  tbMergeFillEntry: '合并生成费用明细',
  tbMappingFillEntry: '不合并生成费用明细',
  tbNotFillEntry: '不生成费用明细',
};
const NOT_FILL_ENTRY = 'tbNotFillEntry';

/**
 * Where 不生成费用明细 is, AND which element a mouse event sent there would actually reach.
 *
 * Caption proximity is not enough. The three items sit next to each other, a click delivered to the neighbour is
 * silent (V-53: an occluded page receives no mouse event at all, and a covered point answers with its cover), and
 * the wrong item writes 费用明细 rows that nobody asked for — D2's observed shape. So the point is hit-tested with
 * `document.elementFromPoint` before it is used, and the anchor found there is identified BY ELEMENT ID.
 */
const importModeTarget = `(() => {
  const vis = ${visible};
  const at = ${pointOf};
  const ids = ${JSON.stringify(Object.keys(IMPORT_MODES))};
  const anchorsOf = (id) => [...document.querySelectorAll('a[id$="' + id + '"]')].filter(vis);
  const items = ids.flatMap((id) => anchorsOf(id).map((n) => n.id));
  const wanted = anchorsOf(${JSON.stringify(NOT_FILL_ENTRY)});
  if (wanted.length !== 1) return { ok: false, count: wanted.length, items };
  const point = at(wanted[0]);
  if (!point.ok) return { ...point, items, wantedId: wanted[0].id };
  const hit = document.elementFromPoint(point.x, point.y);
  const anchor = hit && hit.closest ? hit.closest('a[id]') : null;
  return {
    ...point, items, wantedId: wanted[0].id,
    hitId: anchor ? anchor.id : null,
    hitTag: hit ? hit.tagName : null,
    hitText: hit ? String(hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
  };
})()`;

/** What is at (x, y) now — the same question, asked again after the click. */
const hitAt = (x: number, y: number) => `(() => {
  const hit = document.elementFromPoint(${x}, ${y});
  const anchor = hit && hit.closest ? hit.closest('a[id]') : null;
  return {
    id: anchor ? anchor.id : null, tag: hit ? hit.tagName : null,
    menuOpen: [...document.querySelectorAll('a[id$="${NOT_FILL_ENTRY}"]')].some(${visible}),
  };
})()`;

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
    return [...document.querySelectorAll('a[id$="${NOT_FILL_ENTRY}"]')].some(vis);
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

  type ModeTarget = Point & { items?: string[]; wantedId?: string; hitId?: string | null; hitTag?: string | null; hitText?: string | null };
  const reaches = (t: ModeTarget | null) => t?.ok === true && String(t.hitId ?? '').endsWith(NOT_FILL_ENTRY);
  // Polled, because the menu is still animating open for a moment and the item's neighbour may be what is at the
  // point until it settles. Only a point that resolves to 不生成费用明细 is ever clicked.
  const target = await waitFor(() => evalIn<ModeTarget>(session, importModeTarget), reaches, cap(page, timeoutMs), paceOf(page).pollMs);
  if (!reaches(target)) {
    const wrong = target?.hitId ? `点到的是 ${target.hitId}（${target.hitTag}「${target.hitText}」）` : `那个点上什么都没有（${target?.offscreen ? '在视口之外' : `匹配 ${target?.count ?? 0} 项`}）`;
    throw new ExecutorError('INVOICE_IMPORT_MODE_NOT_SELECTED',
      `「不生成费用明细」没有确认落点，没有点它：${wrong}；菜单里有 ${(target?.items ?? []).join('、') || '（读不到菜单项）'}。`
      + '导入模式选错会让报销系统自己写费用明细，且不可撤销，所以停在这里。');
  }
  await clickAt(session, target.x, target.y);
  await sleep(paceOf(page).settleMs);
  // The same point, read again: with the menu closed it no longer answers the item, which is the evidence that the
  // click went to the item that was there and not to something that is still sitting under the cursor.
  const after = await evalIn<{ id: string | null; tag: string | null; menuOpen: boolean }>(session, hitAt(target.x, target.y));
  await assistantSession(page, timeoutMs);
  return {
    ok: true, mode: IMPORT_MODES[NOT_FILL_ENTRY]!, selectedId: target.wantedId ?? target.hitId ?? null,
    menuItemIds: target.items ?? [], hitBefore: target.hitId ?? null, hitAfter: after?.id ?? null, menuOpenAfter: after?.menuOpen ?? null,
  };
}

const fileInput = async (session: CdpSession, files: string[]) => {
  await session.send('DOM.enable');
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeId) throw new ExecutorError('INVOICE_FILE_INPUT_NOT_FOUND', '发票助手中找不到文件上传控件');
  await session.send('DOM.setFileInputFiles', { nodeId, files });
};

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

/**
 * Has this upload batch been recognised? Counted across ALL 票种 panes, never on the visible rows: with panes, a
 * second batch's rows land in a pane that is not showing while the first batch keeps the visible rows above zero,
 * so a wait on "there are rows" returns at once and the executor proceeds as if the batch had been recognised.
 */
const uploadState = async (session: CdpSession) => ({
  processing: Boolean(await evalIn<boolean>(session, containsText('上传处理中'))),
  total: (await recognisedTotal(session)) ?? 0,
});

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
  if ((await uploadState(assistant)).total > 0) {
    throw new ExecutorError('INVOICE_ASSISTANT_NOT_EMPTY', '发票助手中已有未归属的发票行，拒绝把它们混入当前任务');
  }
  for (const files of groups) {
    const before = (await uploadState(assistant)).total;
    await fileInput(assistant, files);
    // Recognition of this batch is this count rising by the size of the batch. A batch that recognises fewer rows
    // than it was given is not stopped here — the identity-keyed count in `selectRecognisedInvoices` is the real
    // gate, and it can say which invoices are missing, where a count can only say how many.
    const state = await waitFor(() => uploadState(assistant), (value) => value.total >= before + files.length && !value.processing, cap(page, 90_000), pace.pollMs);
    if (state.total <= before) throw new ExecutorError('INVOICE_SELECTION_EMPTY', '发票助手没有返回可勾选的识别结果');
    if ((await readPane(assistant)).rows.some((row) => row.checked)) {
      throw new ExecutorError('INVOICE_SELECTION_PRESELECTED', '发票助手返回了预先勾选的识别结果，拒绝继续导入');
    }
  }
  // One file is one invoice is one 收票行 all through this repo (`job.ts` posts receiptRowCount = plan.invoices.length
  // as the import postcondition), so the number of staged paths is how many rows must end up ticked.
  const selection = await selectRecognisedInvoices(page, assistant, paths.length);
  return { ok: true, selectedRows: selection.selected, panes: selection.panes };
}

/**
 * What the ERP has said about the import. The 发票导入单据 click's whole answer arrives on the ERP page, not in the
 * assistant: measured live 2026-09-19 with 12 invoices, the assistant showed 「数据导入中...」 then
 * 「完成发票和附件操作...」 for six seconds, and between t+6s and t+7s its OOPIF target detached with NOTHING
 * replacing it (`Target.attachedToTarget` fired for no new piaozone target), the 发票无忧助手 window vanished, a
 * 处理结果 window appeared and the 收票网格 went from its total row alone to ten data rows — all in one snapshot.
 *
 * 处理结果 carries the per-invoice verdict ADR-0027 wants the import judged on: a grid of
 * 序号 / 关键字 / 状态 / 问题描述, one row per invoice, keyword 接收发票, 状态 成功 or a failure, and a 问题描述 of
 * 「…接收成功，生成收票单【SPD…】」, 「…已存在对应的收票单【SPD…】，已进行覆盖！」 (ADR-0026's overwrite, seen live)
 * or a refusal naming the bill that holds the invoice.
 *
 * Above the grid sits a summary line, and it has TWO wordings — this is what the previous version got wrong.
 * With failures it reads 「执行成功：10；执行失败：2」; with none it reads 「全部执行成功：10」 and never mentions
 * 执行失败 at all. Measured live 2026-09-19: ten invoices, all bound, 「全部执行成功：10」. Matching only the first
 * wording and then treating «no counts yet» as «still painting» turned a complete, fully successful report into a
 * permanent wait, and an irreversible act that went right was reported to the employee as 结果不确定.
 *
 * So the verdict is taken from evidence that is present, never from a missing substring:
 *   - failed    = the rows whose 状态 is not 成功, OR the summary's 执行失败 count — whichever is larger. Either
 *                 source alone can condemn the import; neither alone can clear it.
 *   - answered  = a summary line in either wording, or a row that already reads as a failure. A window that is
 *                 not 处理结果 at all (a plain 提示) has said everything it is going to say, and is answered too.
 * A failed row is a complete answer on its own: nothing later in the paint turns a refusal back into a success.
 * A grid of nothing but 成功 is not, because a grid caught half-painted shows the rows it has and the ones still
 * missing may be the failures — and a Kendo grid may page or virtualise the rest away for good. The summary's
 * count, by contrast, is complete the moment it exists. Hence: rows condemn, the summary clears.
 */
const importResponse = `(() => {
  const vis = ${visible};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const windows = [...document.querySelectorAll('.k-window')].filter(vis).map(txt)
    .filter((t) => t && !t.startsWith('发票无忧助手'));
  if (windows.length === 0) return { answered: false, text: '', rows: 0 };
  const text = windows.join(' | ');
  const report = windows.find((t) => t.includes('处理结果'));
  // Any other dialog is its own complete answer; a null failure count sends it to the refusal branch with ERP's words.
  if (!report) return { answered: true, text: text.slice(0, 2000), rows: 0, succeeded: null, failed: null };
  // A data row reads 「<序号> 接收发票 <状态> <问题描述>」, so the rows are counted by their 关键字 and the good
  // ones by that 关键字 followed by 成功. Counting, rather than cutting the text into rows, is what makes this
  // independent of how much whitespace the grid puts between two cells — textContent need not preserve any.
  // Nothing else in the window carries 接收发票: the header row's 关键字 is the word 关键字, and the toolbar's
  // 引出失败记录 is not a verdict.
  const rowCount = (report.match(/接收发票/g) || []).length;
  const rowsSucceeded = (report.match(/接收发票\\s*成功/g) || []).length;
  const rowsFailed = rowCount - rowsSucceeded;
  const all = /全部执行(成功|失败)：(\\d+)/.exec(report);
  const split = /执行成功：(\\d+)[^\\d]*执行失败：(\\d+)/.exec(report);
  const summary = all
    ? { succeeded: all[1] === '成功' ? Number(all[2]) : 0, failed: all[1] === '失败' ? Number(all[2]) : 0 }
    : split ? { succeeded: Number(split[1]), failed: Number(split[2]) } : null;
  // 处理结果 paints its title first and its summary and grid a moment later. A row that already reads as a failure
  // is a complete answer on its own — nothing later in the paint can turn it back into a success. A row that reads
  // 成功 is not: a grid caught half-painted shows the rows it has, and the ones missing may be the failures. So a
  // success verdict waits for the summary line, whose count is complete the moment it exists, in either wording.
  // Not answered yet — but the text so far goes back to the caller anyway: a report that is still painting keeps
  // changing between polls, and that is the difference between a slow ERP and a stuck one.
  if (!summary && rowsFailed === 0) return { answered: false, text: text.slice(0, 2000), rows: rowCount };
  return {
    answered: true,
    text: text.slice(0, 2000),
    rows: rowCount,
    succeeded: summary ? summary.succeeded : rowsSucceeded,
    failed: Math.max(rowsFailed, summary ? summary.failed : 0),
  };
})()`;

type ImportResponse = { answered: boolean; text?: string; rows?: number; succeeded?: number | null; failed?: number | null };

export type ImportBudget = { appearMs: number; stallMs: number; hardCapMs: number };

/**
 * How long 发票导入单据 is given, and it is the import's OWN budget rather than the generic `pace.longMs` every
 * other slow wait borrows. Borrowing it is what lost the sixth live round: 90 s is a perfectly good bound for a
 * navigation and far too short for this one click, so an import that had fully succeeded was reported to the
 * employee as 结果不确定 — on the single irreversible act baox performs.
 *
 * MEASURED. Timed live on 2026-09-19 against 金蝶云星空 8.2.830.9, ten invoices (8 普通发票 + 2 铁路电子客票) on a
 * blank 费用报销单-新增, sampling the 处理结果 window every 300 ms from the click:
 *     T+0.0s  发票导入单据 clicked
 *     T+5.5s  处理结果 on screen holding its title and NOTHING else
 *     T+5.9s  the summary line 「全部执行成功：10」
 *     T+6.2s  the ten-row grid complete (764 characters of report)
 *     T+6.5s  importInvoices returns, 处理结果 closed with 退出
 * and against the round that lost this defect, where the same window still held nothing but the word 处理结果 at
 * T+90s and the complete ten-row all-success report minutes later. So the same click, same invoice count, same
 * build, measured 6.5 s once and over 95 s another time: the spread is ERP load, not invoice count, and no single
 * deadline both covers the slow day and fails fast on a real hang.
 *
 * Hence three bounds rather than one, matched to what is on screen:
 *   - `appearMs`  — nothing at all yet. Measured 5.5 s; the slow round had its title up before T+90s. 120 s is
 *                   twenty times the measured latency and still well inside the slow round's own evidence.
 *   - `stallMs`   — the window is up and still changing between polls, so ERP is still working, and it is given
 *                   more time for as long as that stays true. Only a window that has stopped changing WITHOUT a
 *                   verdict is a hang — and the slow round shows such a window can sit unchanged for around four
 *                   minutes and still be alive, so five is the patient answer. Patience is the right bias here:
 *                   the act is already irreversible, and the failure it prevents is telling an employee 结果不确定
 *                   about an import that worked.
 *   - `hardCapMs` — the backstop, so a page that keeps repainting forever cannot hold a job for ever.
 */
export const IMPORT_BUDGET: ImportBudget = { appearMs: 120_000, stallMs: 300_000, hardCapMs: 600_000 };

/**
 * THE import mutation, and the only irreversible act baox performs (ADR-0025, ADR-0028): the 发票导入单据 click
 * binds the selected invoices to this 费用报销单 and mints its 收票单. Nothing before it is irreversible, and
 * nothing may call this without a durable `attempt_started` already recorded.
 *
 * It used to click 不生成费用明细 a second time here, on the assistant's own session, and that killed every live
 * run with `Session with given id not found`: the target it was sent to had just detached. The second click was
 * never needed. 不生成费用明细 is chosen ONCE, up front, on the ERP's 选择发票 split-button menu
 * (`openInvoiceAssistant`), and the assistant then imports in that mode without asking again — the name appearing
 * twice in the old code was a collision, not a repetition. V-45 round 4 inferred an in-iframe 是否生成费用明细
 * step from a human run that had not chosen the mode up front; measured on baox's own path, it does not exist.
 */
export async function importInvoices(page: WritePage, { budget = IMPORT_BUDGET }: { budget?: ImportBudget } = {}) {
  const assistant = await assistantSession(page, Math.min(budget.appearMs, 45_000));
  await clickText(page, assistant, '发票导入单据', { timeoutMs: 15_000 });
  // From here on the assistant's session is dead and everything is read on the ERP page.
  const pollMs = paceOf(page).pollMs;
  const started = Date.now();
  let lastText = '';
  let lastChange = started;
  let answer: ImportResponse | null = null;
  const seconds = (ms: number) => Math.round(ms / 1000);
  for (;;) {
    answer = await evalIn<ImportResponse>(page.session, importResponse);
    if (answer?.answered) break;
    const now = Date.now();
    const text = answer?.text ?? '';
    if (text !== lastText) { lastText = text; lastChange = now; }
    const waited = now - started;
    const still = seconds(waited);
    if (waited >= budget.hardCapMs) {
      throw new ExecutorError('INVOICE_IMPORT_NOT_ANSWERED',
        `点了「发票导入单据」之后，报销系统 ${still} 秒（上限 ${seconds(budget.hardCapMs)} 秒）都没有给出完整的处理结果`);
    }
    if (!text && waited >= budget.appearMs) {
      throw new ExecutorError('INVOICE_IMPORT_NOT_ANSWERED',
        `点了「发票导入单据」之后，报销系统 ${still} 秒（上限 ${seconds(budget.appearMs)} 秒）内没有弹出处理结果窗口`);
    }
    if (text && now - lastChange >= budget.stallMs) {
      throw new ExecutorError('INVOICE_IMPORT_NOT_ANSWERED',
        `处理结果窗口已经打开 ${still} 秒，但最近 ${seconds(now - lastChange)} 秒（上限 ${seconds(budget.stallMs)} 秒）`
        + '没有任何变化，也没有给出成功或失败的结论');
    }
    await sleep(pollMs);
  }
  // Anything short of 执行失败：0 stops the run, and the window is left open so #32's capture keeps ERP's own words
  // (ADR-0027: the run aborts to 转人工 carrying the verbatim text; 申请解绑 and 删除发票 are never clicked).
  if (answer.failed !== 0) {
    throw new ExecutorError('INVOICE_IMPORT_REFUSED', `报销系统没有收下全部发票：${answer.text ?? ''}`);
  }
  // 处理结果 floats over the form at z-index 10005 with no 遮罩, so a toolbar click aimed at the form underneath
  // would land on the report instead — the silent-failure class V-45 recorded for the modal assistant window.
  // 退出 closes the report and nothing else; it is not on the never-click list.
  await clickCss(page, page.session, '[id$="-tbExit"]', '处理结果的「退出」');
  await waitFor(() => evalIn<ImportResponse>(page.session, importResponse), (r) => r?.answered === false, cap(page, 15_000), paceOf(page).pollMs);
  return { ok: true, report: answer.text ?? '' };
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
