import type { CdpListener, CdpSession } from '@baox/erp-executor/cdp';

// The `chrome.debugger` adapter: the executor's `CdpSession` seam, carried by the extension's debugger instead of a
// WebSocket to a dedicated Chromium. `chrome.debugger.sendCommand` IS the DevTools protocol, so every page step of
// `@baox/erp-executor` runs on top of this unchanged — only how a command reaches the page differs.
//
// Two addressing differences from `cdp.ts`'s `connect()` are absorbed here:
// - a command is addressed by a debuggee object (`{ tabId }`), not sent down a per-target socket;
// - a child target (the 发票无忧助手 (invoice assistant), a cross-origin piaozone iframe) is reached through
//   `reachChild` below, and its events arrive tagged by `source` instead of a `sessionId` field on the message.
//
// Nothing in this file touches the `chrome` global: the caller hands the API in, so a test can hand in a fake one that
// is backed by the fake ERP, and the whole executor suite runs through this adapter without a browser.

export type Debuggee = { tabId?: number; targetId?: string; sessionId?: string };

type Listeners<T> = { addListener(listener: T): void; removeListener(listener: T): void };

/** The slice of `chrome.debugger` the adapter uses, in its promise form (MV3). */
export type DebuggerApi = {
  attach(target: Debuggee, requiredVersion: string): Promise<void>;
  detach(target: Debuggee): Promise<void>;
  sendCommand(target: Debuggee, method: string, commandParams?: { [key: string]: unknown }): Promise<object | undefined>;
  onEvent: Listeners<(source: Debuggee, method: string, params?: object) => void>;
  onDetach: Listeners<(source: Debuggee, reason: string) => void>;
};

/** A child target as the executor knows it: the `sessionId` it was announced with, and its target id. */
export type ChildTarget = { sessionId: string; targetId: string };

const PROTOCOL_VERSION = '1.3';
// The same per-command default as `cdp.ts`'s `connect()`.
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How a command reaches a child target of the ERP tab — the piaozone invoice-assistant iframe.
 *
 * PROVISIONAL on spike #250, question 1, which has not been run against the live ERP
 * (docs/research/spike-250-chrome-debugger-and-datatransfer.md). This implements route B: the executor's own
 * `autoAttach` sends `Target.setAutoAttach {flatten: true}` to the tab, and a child announced by
 * `Target.attachedToTarget` is addressed as `{ tabId, sessionId }`. It is the route that keeps `cdp.ts` untouched.
 *
 * If the spike answers differently, this function is what changes, and nothing outside this file:
 * - route C (`Target.attachToTarget` after `Target.getTargets`) addresses the child the same way; only discovery
 *   differs, and it would be needed only if `setAutoAttach` announces nothing under `chrome.debugger`;
 * - route A attaches the child on its own: `await api.attach({ targetId: child.targetId }, …)` once per child, then
 *   return `{ targetId: child.targetId }`. Events from such a child arrive with `source.targetId`, which
 *   `attachDebuggerSession` already maps back to the child's `sessionId`.
 */
export async function reachChild(_api: DebuggerApi, tabId: number, child: ChildTarget): Promise<Debuggee> {
  return { tabId, sessionId: child.sessionId };
}

// What an employee may read when a command fails for a reason of the debugger's own. The executor carries an error's
// message into its result, which the task page shows, so Chrome's English stays in `cause`, for logs.
const DEBUGGER_GONE = '浏览器扩展对报销系统标签页的控制已经断开。';
const PAGE_TIMED_OUT = '报销系统标签页没有及时响应。';

// Chrome's words for a command that failed because the debugger went: the one in flight when it was taken away, or one
// sent after that but before `onDetach` reached this side. Real Chrome fails the in-flight command BEFORE it raises
// `onDetach` (measured 2026-09-21 on Playwright's Chromium, extension/e2e/regression.spec.ts), so this, not the
// event, is the first sign of a detach in the middle of a command.
const DETACHED_BY_CHROME = /Detached while handling command|Debugger is not attached/i;

const withTimeout = <T>(promise: Promise<T>, ms: number, method: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(PAGE_TIMED_OUT, { cause: new Error(`${method} timed out after ${ms} ms`) })), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });

/**
 * Attach the debugger to one tab and speak `CdpSession` over it. `close()` detaches. `onDetach` hears Chrome taking
 * the debugger away (the banner's Cancel, the tab closing), never the session's own `close()` — once per session,
 * whichever reaches this side first: Chrome's `onDetach` event, or a command failing in Chrome's detach words. A
 * command cut off that way is reported as a detach BEFORE its failure reaches the caller, so the caller knows the
 * command was cut off rather than refused.
 */
export async function attachDebuggerSession(api: DebuggerApi, tabId: number, { onDetach: detachedByChrome }: { onDetach?: (reason: string) => void } = {}): Promise<CdpSession> {
  const root: Debuggee = { tabId };
  const listeners = new Map<string, Set<CdpListener>>();
  // Keyed by the sessionId the executor was told about in `Target.attachedToTarget`.
  const children = new Map<string, ChildTarget>();
  let detached: string | null = null;

  const childByTarget = (targetId: string | undefined) => [...children.values()].find((child) => child.targetId === targetId);
  const ours = (source: Debuggee) => source.tabId === tabId || !!childByTarget(source.targetId);
  const sessionIdOf = (source: Debuggee) => source.sessionId ?? childByTarget(source.targetId)?.sessionId ?? null;

  const onEvent = (source: Debuggee, method: string, params?: object) => {
    if (!ours(source)) return;
    const p = (params ?? {}) as Record<string, any>;
    if (method === 'Target.attachedToTarget' && p['sessionId'] && p['targetInfo']?.targetId) {
      children.set(String(p['sessionId']), { sessionId: String(p['sessionId']), targetId: String(p['targetInfo'].targetId) });
    }
    const sessionId = sessionIdOf(source);
    if (method === 'Target.detachedFromTarget' && p['sessionId']) children.delete(String(p['sessionId']));
    for (const listener of listeners.get(method) ?? []) {
      try { listener(p, sessionId); } catch { /* a listener must not break event delivery, as in cdp.ts */ }
    }
  };
  const lostTo = (reason: string) => {
    if (detached) return;
    detached = reason;
    stopListening();
    detachedByChrome?.(reason);
  };
  // Listening starts before `attach`, so nothing is missed, but a detach raised before this attach completed is a
  // previous attachment's, reported late: Chrome fails a cut-off command before it raises `onDetach`. A detach during
  // the attach itself still shows, as the attach or the first command failing.
  let live = false;
  const onDetach = (source: Debuggee, reason: string) => {
    if (live && source.tabId === tabId) lostTo(reason);
  };
  const stopListening = () => {
    api.onEvent.removeListener(onEvent);
    api.onDetach.removeListener(onDetach);
  };

  api.onEvent.addListener(onEvent);
  api.onDetach.addListener(onDetach);
  try {
    await api.attach(root, PROTOCOL_VERSION);
  } catch (error) {
    stopListening();
    throw error;
  }
  live = true;

  return {
    async send(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS, sessionId = null } = {}) {
      if (detached) throw new Error(DEBUGGER_GONE, { cause: new Error(`detached: ${detached}`) });
      let target = root;
      if (sessionId) {
        const child = children.get(sessionId);
        // The wording `cdp.ts` callers already treat as "that child is gone".
        if (!child) throw new Error(`No session with given id: ${sessionId}`);
        target = await reachChild(api, tabId, child);
      }
      try {
        return await withTimeout(api.sendCommand(target, method, params), timeout, method);
      } catch (error) {
        if (!(error instanceof Error) || !DETACHED_BY_CHROME.test(error.message)) throw error;
        lostTo(error.message);
        throw new Error(DEBUGGER_GONE, { cause: error });
      }
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    close() {
      if (detached) return;
      detached = 'closed';
      stopListening();
      api.detach(root).catch(() => { /* the tab or the debugger is already gone */ });
    },
  };
}
