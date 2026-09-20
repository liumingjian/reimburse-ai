// Leaving the dedicated Chromium the way a fresh 去报销 wants it: no 费用报销单 form tab of any flavour.
// The snippets are the measured shape of the ERP's tab strip; `closeFormTab` is the policy, and it is the part
// that has been wrong twice, so it lives here where a test can drive it (tabs.test.ts) instead of inside a script
// that only runs against a live ERP.
//
// Closing a form that carries 收票行 is not one click. Measured live on 2026-09-19 with a tab left over from an
// import: the ERP answers the close with `{"actionname":"showConfirm","msg":"内容已经修改，是否保存？"}` and
// renders 是 / 否 / 取消 into the form's OWN `…-POPFLOATEMESSAGE` bar — not into a `.k-window`, and not at all
// while the tab is inactive (the bar lives inside that tab's content container, so an inactive tab renders it
// `display:none` and the confirm is invisible and unanswerable). Unanswered, the ERP keeps the tab.
//
// 否 declines to save; it is not the 保存 that ADR-0028 reserves for the employee, and no 单据 is deleted (an
// unsaved 新增 form has none to delete). 是 is never clicked, whatever the cost of leaving a tab open.
import { evalIn, type CdpSession } from './cdp';
import { HIT_JS, clickReach, type Reach } from './hit';
import { sleep, waitFor } from './pace';

export const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;

// A tab that is still loading is captioned 「费用报销单 - 新增」 with spaces; an exact match left those open.
// 新增 keeps its own name because its leftovers are what break the next 去报销, and so keep their own exit code;
// 修改 / 查看 are closed for safety and reported apart.
const NEW_FORM_TAB = String.raw`/^费用报销单\s*-\s*新增$/`;
const FORM_TAB = String.raw`/^费用报销单\s*-\s*(新增|修改|查看)$/`;

export type Point = Reach | null;
export type Tab = { id: string; text: string; active: boolean; isNew: boolean; isForm: boolean };

// Where to click a node so the click reaches IT, or null when no click of this node is possible right now. A
// leftover 处理结果 window floats over the form at z-index 10005 with no 遮罩, and the 是否保存 confirm bar paints
// underneath it: a click on the bar's own rect landed on the report instead, the confirm went unanswered and the
// tab stayed open — with the script reporting a click it had made and an outcome it had not.
//
// The rule itself is `hit.ts`, shared with every other click in the executor. What this file adds is its own
// policy on an unreachable point: null, so the waits below keep polling. A covered closer is a tab that is busy,
// not a tab that is stuck, and it is outwaited rather than reported.
export const HIT = `(n) => { const r = (${HIT_JS})(n); return r.onTarget ? r : null; }`;

/** Every dialog the ERP is still showing, by its text. */
export const dialogsSnippet = `(() => {
  const vis = ${VIS};
  return [...document.querySelectorAll('.k-window')].filter(vis)
    .map((n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60));
})()`;

/** How to dismiss the topmost dialog: its 退出 toolbar item if it has one, else its window Close. */
export const dismissPoint = `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const win = [...document.querySelectorAll('.k-window')].filter(vis)[0];
  if (!win) return null;
  const exit = [...win.querySelectorAll('[id$="-tbExit"]')].filter(vis)[0];
  const close = [...win.querySelectorAll('a[aria-label="Close"]')].filter(vis)[0];
  const node = exit || close;
  if (!node) return null;
  // Scrolled in first, like every other click path: a dialog raised while the page was scrolled can hold its own
  // 退出 outside the viewport, where a real mouse event reaches nothing and the window would be reported unclosable.
  node.scrollIntoView({ block: 'center' });
  return at(node);
})()`;

/** The open closable tabs, by caption and by the id the strip gives them, in strip order. */
export const tabsSnippet = `(() => {
  const vis = ${VIS};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.k-item')].filter(vis)
    .filter((n) => n.querySelector('span.mainTabCloseButton'))
    .map((n) => ({ id: n.id || '', text: txt(n), active: n.className.includes('k-state-active'),
      isNew: ${NEW_FORM_TAB}.test(txt(n)), isForm: ${FORM_TAB}.test(txt(n)) }));
})()`;

// Each tab is addressed by its own id, not by «the first one that matches»: a tab that refuses to close would
// otherwise be re-picked forever, and the loop could never reach the tabs behind it.
/** Where to click the tab with this id: `part` picks its caption (activate) or its close button. */
export const tabPoint = (id: string, part: 'link' | 'close') => `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const tab = [...document.querySelectorAll('li.k-item')].filter(vis)
    .filter((n) => n.querySelector('span.mainTabCloseButton'))
    .find((n) => n.id === ${JSON.stringify(id)});
  if (!tab) return null;
  const node = ${JSON.stringify(part)} === 'close'
    ? [...tab.querySelectorAll('span.mainTabCloseButton')].filter(vis)[0]
    : [...tab.querySelectorAll('span.k-link')].filter(vis)[0];
  return node ? at(node) : null;
})()`;

/**
 * A tab's own form id. Measured live: the strip gives the tab `li_<guid>FMAINTAB_c` and the form underneath it
 * names every one of its own nodes `<guid>-…`, so the 是否保存 bar of THIS tab is `<guid>-POPFLOATEMESSAGE`.
 * That is how a standing confirm is attributed to the tab it belongs to instead of to whichever bar is first.
 */
export const formIdOf = (tabId: string) => /^li_(.+)FMAINTAB_c$/.exec(String(tabId ?? ''))?.[1] ?? null;

/** The 否 button of the 内容已经修改，是否保存？ bar, once it is painted inside the active tab. */
export const declineSavePoint = (formId: string | null) => `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const formId = ${JSON.stringify(formId)};
  const bar = [...document.querySelectorAll('div[id*="POPFLOATEMESS"]')].filter(vis)
    .filter((n) => !formId || n.id.startsWith(formId))
    .find((n) => txt(n).includes('是否保存'));
  if (!bar) return null;
  const buttons = [...bar.querySelectorAll('a, button, span.k-button')].filter((n) => vis(n) && txt(n) === '否');
  return buttons.length === 1 ? at(buttons[0]) : null;
})()`;

/**
 * How long to wait for the ERP to raise 是否保存 after the close click.
 *
 * It was 10 s, and that is too short for the tab this whole script exists for. Measured live 2026-09-19 on a
 * 费用报销单-新增 carrying ten imported 收票行: two consecutive attempts saw no bar inside 10 s, and the bar was
 * standing — unanswered — when the state was read afterwards. The close is a round trip through
 * `DynamicFormService.Call` over the whole form, and a form with ten 收票行 is not a form with none.
 */
export const CONFIRM_MS = 45_000;
/**
 * How long to wait for the tab to actually leave the strip.
 *
 * Answering a standing 否 dropped the tab in under 2 s live. A form the ERP is still settling is far slower:
 * measured live 2026-09-19 on a freshly opened 费用报销单-新增, the closer was clicked, no 是否保存 was raised,
 * and the tab was still on the strip 65 s later — and gone when the page was read again a couple of minutes on.
 * Closing is asynchronous ERP work, so this waits for the strip to agree rather than declaring a tab stuck.
 */
export const CLOSED_MS = 90_000;
/**
 * How long to wait for the tab's own close button to become reachable.
 *
 * A form that is still opening puts a `kd-ui-blockingExtention-item` over the whole strip: measured live
 * 2026-09-19 on a 费用报销单 - 新增 (spaces in the caption — still loading), `document.elementFromPoint` on the
 * closer answered that overlay two minutes after the form was asked for, and four minutes after, with the form
 * loaded, the overlay was gone. Reading the point once and giving up turned a tab that was merely busy into a
 * tab reported as stuck, so this outwaits the overlay.
 */
export const REACH_MS = 120_000;

export type TabActions = {
  tabs(): Promise<Tab[]>;
  /** The point to click for part of this tab, or null when it cannot be reached. */
  tabPoint(id: string, part: 'link' | 'close'): Promise<Point>;
  /** The point of this tab's own standing 否, or null when no 是否保存 bar of its is up. */
  declinePoint(formId: string | null): Promise<Point>;
  click(point: Reach): Promise<void>;
  settle(ms: number): Promise<void>;
};

export type CloseOutcome = {
  closed: boolean;
  declinedSave: boolean;
  /** The confirm was already standing when this attempt began — an earlier attempt left it unanswered. */
  answeredStanding: boolean;
  /** Nothing to report but the plain facts: what was seen, what was clicked, what is still there. */
  note: string;
};

/**
 * Close one 费用报销单 tab, and verify it is gone — never report a click as an outcome.
 *
 * The order matters, and getting it wrong is what blocked three consecutive live attempts on 2026-09-19. The old
 * version always started by clicking the tab (activate, then its closer). On a tab whose 是否保存 was ALREADY up
 * from an attempt that had timed out, that raises a second close over an unanswered confirm, and the pair did not
 * close the tab: attempt 3 clicked 否 and both the bar and the tab were still there afterwards. Measured on the
 * same stuck tab minutes later: answering the standing bar on its own, touching nothing else, closed the tab in
 * under two seconds.
 *
 * So a standing confirm is answered FIRST and the tab is re-read before anything else is clicked. Only a tab with
 * no confirm of its own outstanding is asked to close.
 */
export async function closeFormTab(actions: TabActions, id: string, { confirmMs = CONFIRM_MS, closedMs = CLOSED_MS, reachMs = REACH_MS } = {}): Promise<CloseOutcome> {
  const formId = formIdOf(id);
  const gone = async (ms: number) => !(await waitFor(() => actions.tabs(), (tabs) => !tabs.some((t) => t.id === id), ms, 500)).some((t) => t.id === id);

  const standing = await actions.declinePoint(formId);
  if (standing) {
    await actions.click(standing);
    if (await gone(closedMs)) {
      return { closed: true, declinedSave: true, answeredStanding: true, note: '答了上一次遗留的「是否保存」，页签随即关掉' };
    }
    // The bar was answered and the tab stayed: whatever it belonged to, the form is still open, so ask again below.
  }

  const activate = await waitFor(() => actions.tabPoint(id, 'link'), Boolean, reachMs, 500);
  if (activate) { await actions.click(activate); await actions.settle(1200); }
  // A tab that is still opening is covered by the ERP's own blocking overlay, so the closer is polled until it
  // answers the hit test rather than read once — busy is not stuck.
  const closer = await waitFor(() => actions.tabPoint(id, 'close'), Boolean, reachMs, 500);
  if (!closer) {
    return { closed: false, declinedSave: false, answeredStanding: Boolean(standing), note: `等了 ${Math.round(reachMs / 1000)} 秒，页签的关闭按钮一直点不到（被遮住或已不在）` };
  }
  await actions.click(closer);
  // The confirm is a round trip to the ERP, so it does not appear at once — and a form with nothing modified
  // never raises it, which is why this waits rather than requires. The same wait watches the strip, so a tab
  // that simply closes does not sit out the whole confirm budget before anyone looks.
  const answer = await waitFor(
    async () => ({ decline: await actions.declinePoint(formId), open: (await actions.tabs()).some((t) => t.id === id) }),
    (seen) => Boolean(seen.decline) || !seen.open, confirmMs, 500);
  const decline = answer.decline;
  if (decline) await actions.click(decline);
  // Gone means this tab's own id is gone from the strip, not a count another tab could satisfy.
  if (await gone(closedMs)) {
    return { closed: true, declinedSave: Boolean(decline), answeredStanding: Boolean(standing), note: decline ? '答「否」后页签关掉' : '没有要保存的内容，直接关掉' };
  }
  const stillUp = Boolean(await actions.declinePoint(formId));
  return {
    closed: false,
    declinedSave: Boolean(decline),
    answeredStanding: Boolean(standing),
    // Precise, because «closed:false» three times is what sent the last round looking in the wrong place.
    note: decline
      ? (stillUp
        ? '点了「否」，但「是否保存」还在，页签也还开着——报销系统没有接受这次放弃保存，只能人工处理（绝不点「是」）'
        : '点了「否」，「是否保存」已消失，但页签仍在——报销系统还没关掉它')
      : (stillUp
        ? `等了 ${Math.round(confirmMs / 1000)} 秒，「是否保存」在窗口里但点不到`
        : `等了 ${Math.round(confirmMs / 1000)} 秒没等到「是否保存」，页签也没关`),
  };
}

/**
 * Close every 费用报销单-新增 tab, and say which would not go. For 重新去报销 (ADR-0027) and nothing else.
 *
 * Live 2026-09-21: an import that ERP answered with no window left its unsaved 新增 open, holding the one 收票行 it
 * had just bound. 对账 judged it 未保存·已导入未写明细 and offered 重新去报销, whose banner promises a fresh bill —
 * and the recovery clicked the open 新增 tab instead of opening one, found it not blank, and stopped at 打开空白报销单.
 * It could never have got further while that tab stayed open, so the recovery was an exit in name only.
 *
 * Only 新增 tabs are touched. A 修改 or 查看 tab sits on a SAVED bill, and closing it is not this step's business.
 * Each tab goes through `closeFormTab`, so 是否保存 is answered 否 and never 是: nothing is saved and nothing is
 * deleted — an unsaved 新增 has no 单据 to delete, and the 收票单 its import minted stays in ERP to be overwritten
 * by the re-import (ADR-0026).
 */
export async function closeNewFormTabs(actions: TabActions, budget: { confirmMs?: number; closedMs?: number; reachMs?: number } = {}) {
  const leftovers = (await actions.tabs()).filter((tab) => tab.isNew);
  const closed: string[] = [];
  const stuck: string[] = [];
  for (const tab of leftovers) {
    const outcome = await closeFormTab(actions, tab.id, budget);
    if (outcome.closed) closed.push(tab.text);
    else stuck.push(`${tab.text}（${outcome.note}）`);
  }
  return { closed, stuck };
}

/** The live glue: the actions above, performed over a CDP session. Thin on purpose — the policy is above. */
export function tabActions(session: CdpSession): TabActions {
  return {
    tabs: () => evalIn<Tab[]>(session, tabsSnippet),
    tabPoint: (id, part) => evalIn<Point>(session, tabPoint(id, part)),
    declinePoint: (formId) => evalIn<Point>(session, declineSavePoint(formId)),
    click: async (point) => { await clickReach(session, point, '页签上的这个位置'); },
    settle: (ms) => sleep(ms),
  };
}
