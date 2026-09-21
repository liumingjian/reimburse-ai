import { enableFocusEmulation, type CdpSession } from '@baox/erp-executor/cdp';
import type { BrowserPort } from '@baox/erp-executor/job';
import { ExecutorError, safeUrl, type ChromiumPage } from '@baox/erp-executor/page';
import { erpEntryOf, sameOrigin } from '@baox/erp-executor/probe';
import { attachDebuggerSession, type DebuggerApi } from './debugger-session';

// The executor's `BrowserPort` in the extension: the ERP tab a job runs in, and nothing else.
//
// User story 14: a 去报销 opens its own tab and the debugger attaches to that tab alone. `listPages` names only it,
// so the login probe never even sees the employee's own ERP tabs, and `attach` refuses any other page in case one is
// ever handed in. Login, when needed, happens in this tab (user story 15); it is left open when the job ends, because
// that is where the employee finds the filled, unsaved 费用报销单 (ADR-0028).
//
// User story 17: the tab is brought to the front of a focused window when the debugger attaches, so Chrome's
// background-tab timer throttling cannot slow the Kendo controls under the fill.

type Tab = { id?: number | undefined; windowId: number; url?: string | undefined; pendingUrl?: string | undefined; status?: string | undefined; title?: string | undefined; active?: boolean };

export type TabsApi = {
  create(properties: { url: string; active: boolean }): Promise<Tab>;
  get(tabId: number): Promise<Tab>;
  update(tabId: number, properties: { active: boolean }): Promise<unknown>;
};

export type WindowsApi = { update(windowId: number, properties: { focused: boolean }): Promise<unknown> };

/** A tab an earlier run of the same task used (`reuse`), and whether a new one may be opened when it is gone. */
export type TabChoice = { reuse: number | null; openIfGone: boolean };

export type ErpTabOptions = {
  tabs: TabsApi;
  windows: WindowsApi;
  debugger: DebuggerApi;
  erpOrigin: string;
  choice?: TabChoice;
  pollMs?: number;
};

/** Whether `Emulation.setFocusEmulationEnabled` was accepted on the tab; null until the debugger attached. */
export type FocusEmulation = { ok: boolean; error?: string } | null;

export type ErpTab = BrowserPort & {
  tabId(): number | null;
  focusEmulation(): FocusEmulation;
  /** Chrome took the debugger away from the tab (the banner's Cancel, the tab closed) — not the job's own close. */
  onDetached(listener: (reason: string) => void): void;
};

// How long a new tab gets to load the ERP before it is handed to the login probe anyway.
const LOAD_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `BrowserPort` over the job's ERP tab, found or opened on the first `listPages`. Doing that inside the job rather
 * than before it puts a failure under the job's `chromium` step, where it ends as an ordinary result.
 */
export function dedicatedErpTab({
  tabs, windows, debugger: api, erpOrigin, choice = { reuse: null, openIfGone: true }, pollMs = 250,
}: ErpTabOptions): ErpTab {
  const entry = erpEntryOf(erpOrigin);
  let tabId: number | null = null;
  let focus: FocusEmulation = null;
  const detachListeners: Array<(reason: string) => void> = [];

  async function open(): Promise<number> {
    const tab = await tabs.create({ url: entry, active: true });
    if (tab.id === undefined) throw new ExecutorError('ERP_TAB_NOT_OPENED', '浏览器没有打开报销系统标签页');
    // The login probe reads whatever document is there, and a blank tab still loading reads as "not logged in". So
    // wait for the ERP's own document; past the deadline the probe still waits for a slow first screen on its own.
    const until = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < until) {
      const now = await tabs.get(tab.id).catch(() => null);
      if (!now || (now.status === 'complete' && sameOrigin(now.url, erpOrigin))) break;
      await sleep(pollMs);
    }
    return tab.id;
  }

  async function find(): Promise<number> {
    if (choice.reuse !== null && await tabs.get(choice.reuse).catch(() => null)) return choice.reuse;
    if (!choice.openIfGone) throw new ExecutorError('ERP_TAB_GONE', '找不到这笔报销上次用的报销系统标签页，可能已经关掉了');
    return open();
  }

  const pageOf = (id: number, tab: Tab): ChromiumPage => {
    const url = safeUrl(tab.url || tab.pendingUrl || entry);
    let origin: string | null = null;
    try { origin = new URL(url).origin; } catch { /* not a URL yet */ }
    return {
      transport: 'default', automation: 'cdp', browserFamily: 'chromium', tabId: String(id), index: null, url,
      title: tab.title ?? null, active: tab.active ?? false, origin, pageId: `tab-${id}`, cdpTargetId: `tab-${id}`,
    };
  };

  return {
    tabId: () => tabId,
    focusEmulation: () => focus,
    onDetached: (listener) => { detachListeners.push(listener); },
    async listPages() {
      tabId ??= await find();
      // A closed tab lists nothing, which the fill job's drift guard reads as its target being gone.
      const tab = await tabs.get(tabId).catch(() => null);
      return tab ? [pageOf(tabId, tab)] : [];
    },
    async attach(page) {
      if (tabId === null || page.tabId !== String(tabId)) {
        throw new ExecutorError('ERP_TAB_NOT_OURS', '只会操作为这次报销打开的报销系统标签页，不会碰你自己打开的标签页');
      }
      const tab = await tabs.get(tabId);
      await tabs.update(tabId, { active: true });
      await windows.update(tab.windowId, { focused: true });
      let session: CdpSession;
      try {
        session = await attachDebuggerSession(api, tabId, { onDetach: (reason) => { for (const listener of detachListeners) listener(reason); } });
      } catch (error) {
        // Chrome's own reason is English and stays in `cause`; the employee reads only the fixed sentence.
        throw new ExecutorError('ERP_TAB_DEBUGGER_UNAVAILABLE',
          '浏览器扩展没能接管报销系统标签页。如果这个标签页开着开发者工具，请关掉后再试。', { cause: error });
      }
      // Deliberately NOT fatal, unlike `attachChromiumPage` on the dedicated Chromium. There the window is an automation
      // browser buried behind the employee's work nearly all the time, and without focus emulation an occluded page
      // swallows every `Input.dispatchMouseEvent` while CDP answers ok (V-53), so it has to stop. Here the tab has just
      // been brought to the front of a focused window — the visibility that focus emulation only simulates — and
      // whether `chrome.debugger` accepts the command on a real foreground tab of the employee's Chrome has never been
      // measured. Fatal would turn that unmeasured gap into a refusal of every 去报销. A click swallowed anyway still
      // fails the step waiting for its effect, and every such step before the first `attempt_started` aborts cleanly.
      // The outcome is kept (`focusEmulation()`), and the real-browser harness measures it on Chromium.
      focus = await enableFocusEmulation(session);
      if (!focus.ok) console.warn(`[baox] Emulation.setFocusEmulationEnabled refused on the ERP tab: ${focus.error ?? 'unknown'}`);
      return { ...page, session };
    },
  };
}
