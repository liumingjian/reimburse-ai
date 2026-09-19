// Leave the dedicated Chromium the way a fresh 去报销 wants it: no 发票助手 window, no 费用报销单-新增 tab.
// Closes an unsaved form only; it clicks nothing on the never-click list and writes nothing.
//
// Closing a form that carries 收票行 is not one click. Measured live on 2026-09-19 with a tab left over from an
// import: the ERP answers the close with `{"actionname":"showConfirm","msg":"内容已经修改，是否保存？"}` and
// renders 是 / 否 / 取消 into the form's OWN `…-POPFLOATEMESSAGE` bar — not into a `.k-window`, which is the only
// place the old version looked, and not at all while the tab is inactive (the bar lives inside that tab's content
// container, so an inactive tab renders it `display:none` and the confirm is invisible and unanswerable).
// Unanswered, the ERP keeps the tab. The old version clicked the closer, counted the click as a close and printed
// `{"closed":1,"found":1}` twice over a tab that never went away.
//
// So: activate the tab, close it with a real mouse event, answer 否 (do not save), and — the part that was missing —
// VERIFY the tab is gone before reporting anything. 否 declines to save; it is not the 保存 that ADR-0028 reserves
// for the employee, and no 单据 is deleted (an unsaved 新增 form has none to delete).
import { clickAt, connect, evalIn, targets, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { closeInvoiceAssistant, type WritePage } from '../src/erp/executor/steps';
import { sleep, waitFor } from '../src/erp/executor/pace';

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;
// A tab that is still loading is captioned 「费用报销单 - 新增」 with spaces; an exact match left those open.
const NEW_FORM_TAB = String.raw`/^费用报销单\s*-\s*新增$/`;

type Point = { x: number; y: number } | null;

// Where to click a node so the click reaches IT. A leftover 处理结果 window floats over the form at z-index 10005
// with no 遮罩, and the 是否保存 confirm bar paints underneath it: a click on the bar's own rect landed on the
// report instead, the confirm went unanswered and the tab stayed open — with the script reporting a click it had
// made and an outcome it had not. So every point here is hit-tested before it is used.
const HIT = `(n) => {
  const b = n.getBoundingClientRect();
  if (!(b.width > 0 && b.height > 0)) return null;
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === n || n.contains(hit) || hit.contains(n))) return null;
  return { x, y };
}`;

/** Every dialog the ERP is still showing, by its text. */
const dialogsSnippet = `(() => {
  const vis = ${VIS};
  return [...document.querySelectorAll('.k-window')].filter(vis)
    .map((n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60));
})()`;

/** How to dismiss the topmost dialog: its 退出 toolbar item if it has one, else its window Close. */
const dismissPoint = `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const win = [...document.querySelectorAll('.k-window')].filter(vis)[0];
  if (!win) return null;
  const exit = [...win.querySelectorAll('[id$="-tbExit"]')].filter(vis)[0];
  const close = [...win.querySelectorAll('a[aria-label="Close"]')].filter(vis)[0];
  const node = exit || close;
  return node ? at(node) : null;
})()`;

/** The open 费用报销单-新增 tabs, by caption, in strip order. */
const tabsSnippet = `(() => {
  const vis = ${VIS};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.k-item')].filter(vis)
    .filter((n) => n.querySelector('span.mainTabCloseButton'))
    .map((n) => ({ text: txt(n), active: n.className.includes('k-state-active'), isNew: ${NEW_FORM_TAB}.test(txt(n)) }));
})()`;

/** Where to click the first 费用报销单-新增 tab: `part` picks its caption (activate) or its close button. */
const tabPoint = (part: 'link' | 'close') => `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const tab = [...document.querySelectorAll('li.k-item')].filter(vis)
    .filter((n) => n.querySelector('span.mainTabCloseButton'))
    .find((n) => ${NEW_FORM_TAB}.test(txt(n)));
  if (!tab) return null;
  const node = ${JSON.stringify(part)} === 'close'
    ? [...tab.querySelectorAll('span.mainTabCloseButton')].filter(vis)[0]
    : [...tab.querySelectorAll('span.k-link')].filter(vis)[0];
  return node ? at(node) : null;
})()`;

/** The 否 button of the 内容已经修改，是否保存？ bar, once it is painted inside the active tab. */
const declineSavePoint = `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const bar = [...document.querySelectorAll('div[id*="POPFLOATEMESS"]')].filter(vis)
    .find((n) => txt(n).includes('是否保存'));
  if (!bar) return null;
  const buttons = [...bar.querySelectorAll('a, button, span.k-button')].filter((n) => vis(n) && txt(n) === '否');
  return buttons.length === 1 ? at(buttons[0]) : null;
})()`;

const newFormTabs = async (session: CdpSession) =>
  (await evalIn<Array<{ text: string; active: boolean; isNew: boolean }>>(session, tabsSnippet)).filter((t) => t.isNew);

async function closeOneNewFormTab(session: CdpSession): Promise<{ closed: boolean; declinedSave: boolean }> {
  const activate = await evalIn<Point>(session, tabPoint('link'));
  if (activate) { await clickAt(session, activate.x, activate.y); await sleep(1200); }
  const closer = await evalIn<Point>(session, tabPoint('close'));
  if (!closer) return { closed: false, declinedSave: false };
  await clickAt(session, closer.x, closer.y);
  // The confirm is a round trip to the ERP, so it does not appear at once — and a form with nothing modified
  // never raises it, which is why this waits rather than requires.
  const decline = await waitFor(() => evalIn<Point>(session, declineSavePoint), Boolean, 10_000, 500);
  if (decline) { await clickAt(session, decline.x, decline.y); }
  const left = await waitFor(() => newFormTabs(session), (tabs) => tabs.length === 0, 15_000, 500);
  return { closed: left.length === 0, declinedSave: Boolean(decline) };
}

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const page: WritePage = { session };
  console.log('close assistant:', JSON.stringify(await closeInvoiceAssistant(page)));
  await sleep(1500);
  // Dialogs first: an open one covers the confirm the tab close is about to raise.
  for (let i = 0; i < 5 && (await evalIn<string[]>(session, dialogsSnippet)).length; i += 1) {
    const dismiss = await evalIn<Point>(session, dismissPoint);
    if (!dismiss) break;
    await clickAt(session, dismiss.x, dismiss.y);
    await sleep(1000);
  }
  console.log('dialogs left:', JSON.stringify(await evalIn<string[]>(session, dialogsSnippet)));
  const before = await newFormTabs(session);
  let closed = 0;
  let declined = 0;
  for (let i = 0; i < before.length; i += 1) {
    const result = await closeOneNewFormTab(session);
    if (result.declinedSave) declined += 1;
    if (!result.closed) break;
    closed += 1;
  }
  const after = await evalIn<Array<{ text: string }>>(session, tabsSnippet);
  const remaining = await newFormTabs(session);
  // Report what was verified, never what was clicked.
  console.log('close tabs:', JSON.stringify({ found: before.length, closed, declinedSave: declined, remaining: remaining.length }));
  console.log('left open:', JSON.stringify({ tabs: after.map((t) => t.text) }));
  if (remaining.length) {
    console.error(`费用报销单-新增 没有关掉：还剩 ${remaining.length} 个`);
    process.exit(1);
  }
} finally { session.close(); }
