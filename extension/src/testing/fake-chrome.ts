import type { CdpSession } from '@baox/erp-executor/cdp';
import type { Debuggee, DebuggerApi } from '../debugger-session';
import type { TabsApi, WindowsApi } from '../erp-tab';

// `chrome.debugger`, `chrome.tabs` and `chrome.windows`, faked over a `CdpSession` — in practice the stateful fake ERP
// (`@baox/erp-executor/testing/fake-erp`). This is what lets the executor suite run through the extension's adapter
// with no browser: the fake ERP answers the protocol, and this file only reproduces how `chrome.debugger` addresses
// it — by tab, with flat child sessions as `{ tabId, sessionId }` (route B of spike #250, the adapter's current
// assumption) — and which tabs exist.
//
// The employee's own tabs exist before the job starts. They are not backed by anything: a command that reached one
// would throw, and `attached` records every attach, so a test can say the debugger never touched them.

type Tab = { id: number; windowId: number; url: string; status: 'complete'; title: string; active: boolean };
type Listener<T> = { addListener(listener: T): void; removeListener(listener: T): void };

const listenerSet = <T>(): Listener<T> & { all(): T[] } => {
  const set = new Set<T>();
  return { addListener: (l) => void set.add(l), removeListener: (l) => void set.delete(l), all: () => [...set] };
};

// Every event the fake ERP raises is a `Target.*` event of the page's own (root) session.
const ROOT_EVENTS = ['Target.attachedToTarget', 'Target.targetInfoChanged', 'Target.detachedFromTarget'];

export type FakeChromeOptions = {
  /** URLs of tabs the employee already has open, e.g. their own ERP tab. */
  employeeTabs?: string[];
  /** Commands the debugger refuses on a real browser, answered with this error instead of reaching the page. */
  refuse?: Record<string, string>;
};

export function fakeChrome(page: CdpSession, { employeeTabs = [], refuse = {} }: FakeChromeOptions = {}) {
  const tabs = new Map<number, Tab>();
  let nextId = 1;
  for (const url of employeeTabs) {
    tabs.set(nextId, { id: nextId, windowId: 1, url, status: 'complete', title: '', active: false });
    nextId += 1;
  }
  let backed: number | null = null;
  const attachedTabs = new Set<number>();
  const attached: Debuggee[] = [];
  const focusedWindows: number[] = [];
  const onEvent = listenerSet<(source: Debuggee, method: string, params?: object) => void>();
  const onDetach = listenerSet<(source: Debuggee, reason: string) => void>();

  for (const method of ROOT_EVENTS) {
    page.on!(method, (params) => {
      if (backed === null || !attachedTabs.has(backed)) return;
      for (const listener of onEvent.all()) listener({ tabId: backed }, method, params);
    });
  }

  const debuggerApi: DebuggerApi = {
    async attach(target) {
      if (target.tabId === undefined || !tabs.has(target.tabId)) throw new Error(`No tab with given id ${target.tabId}.`);
      if (attachedTabs.has(target.tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${target.tabId}.`);
      attachedTabs.add(target.tabId);
      attached.push(target);
    },
    async detach(target) {
      if (target.tabId === undefined || !attachedTabs.delete(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    },
    async sendCommand(target, method, params = {}) {
      if (target.tabId === undefined || !attachedTabs.has(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
      if (target.tabId !== backed) throw new Error(`tab ${target.tabId} is not the fake ERP's tab`);
      if (refuse[method]) throw new Error(refuse[method]);
      return page.send(method, params, { sessionId: target.sessionId ?? null });
    },
    onEvent,
    onDetach,
  };

  const tabsApi: TabsApi = {
    async create({ url, active }) {
      const tab: Tab = { id: nextId, windowId: 1, url, status: 'complete', title: '金蝶云星空', active };
      nextId += 1;
      tabs.set(tab.id, tab);
      backed = tab.id;
      return { ...tab };
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      return { ...tab };
    },
    async update(tabId, { active }) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      if (active) for (const other of tabs.values()) other.active = other.id === tabId;
      return { ...tab };
    },
  };

  const windowsApi: WindowsApi = {
    async update(windowId, { focused }) {
      if (focused) focusedWindows.push(windowId);
      return {};
    },
  };

  return {
    debugger: debuggerApi,
    tabs: tabsApi,
    windows: windowsApi,
    /** Every `chrome.debugger.attach`, in order. */
    attached,
    focusedWindows,
    /** The tab the job opened, once it has. */
    jobTab: () => (backed === null || !tabs.has(backed) ? null : { ...tabs.get(backed)! }),
    /** Every tab that exists now. */
    tabCount: () => tabs.size,
    /** Chrome detaching the debugger, as the "Cancel" on its banner does. */
    detach(reason = 'canceled_by_user') {
      if (backed === null || !attachedTabs.delete(backed)) return;
      for (const listener of onDetach.all()) listener({ tabId: backed }, reason);
    },
    /** The employee closing the job's tab: it is gone, and Chrome detaches the debugger from it. */
    closeJobTab() {
      if (backed === null || !tabs.delete(backed)) return;
      if (attachedTabs.delete(backed)) for (const listener of onDetach.all()) listener({ tabId: backed }, 'target_closed');
    },
  };
}
