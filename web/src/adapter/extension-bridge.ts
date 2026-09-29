import { bridgeMessage, ExtensionBridgeExtensionMessageSchema, type ExtensionBridgeExtensionMessage, type ExtensionBridgePageMessage, type ExtensionPairOutcome, type ExtensionSwitchOutcome } from '@baox/contract';

// The page's half of the page bridge (#287): the 浏览器扩展 (browser extension) runs a content script on this origin
// and answers `window.postMessage` messages in the protocol `@baox/contract` defines. Pages reach the extension only
// through an `ExtensionBridge`, injected like the adapter (`App`'s `bridge`), so tests hand in a fake one.
//
// Silence is an answer: an extension that is not installed, or one too old to have the content script, never replies,
// and every request here resolves null after its timeout. Callers read null as "no extension" and fall back to the
// manual 配对码 (pairing code) flow.

/** What the extension says about itself: its version, and the 应用账号 (app account) it is paired to, if any. */
export type ExtensionPresence = { version: string; paired: boolean; accountId: string | null };

export type ExtensionBridge = {
  /** Asks the extension who it is. Null when nothing answers in time: not installed, or no bridge at all. */
  probe(): Promise<ExtensionPresence | null>;
  /**
   * Asks the extension, acting for another 应用账号, whether it may switch to `accountId` (#292). The extension asks
   * the employee in a window of its own; this only carries the answer. Null when nothing answers in time.
   */
  switchTo(accountId: string): Promise<ExtensionSwitchOutcome | null>;
  /**
   * Hands the extension a 配对码 (pairing code) freshly issued for `accountId` to redeem (#291). Null when nothing
   * answers in time; the code is then still the employee's to type into the popup.
   */
  pair(code: string, accountId: string): Promise<ExtensionPairOutcome | null>;
};

// Long enough for the extension to wake its service worker and confirm its pairing with the app (which it gives
// 800 ms), short enough that an employee without the extension is not kept waiting for the install steps.
export const EXTENSION_PROBE_TIMEOUT_MS = 1_500;

// Redeeming is one request from the extension to the app, which answers at once or not at all. The page never sends
// a pair request the extension would still have to ask about: a switch of accounts is agreed through `switchTo` first.
export const EXTENSION_PAIR_TIMEOUT_MS = 10_000;

// A switch request is answered by a person reading the extension's question, so the page waits as long as someone
// might plausibly take to read it and decide. Past that, the page falls back to the manual flow.
export const EXTENSION_SWITCH_TIMEOUT_MS = 180_000;

/** A bridge nothing ever answers: the mock mode, and pages rendered without a bridge. */
export const SILENT_EXTENSION_BRIDGE: ExtensionBridge = { probe: async () => null, switchTo: async () => null, pair: async () => null };

/** The slice of this page's own `window` the page's half of the bridge uses. */
export type PageWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'postMessage' | 'location'>;

export type WindowBridgeOptions = { window?: PageWindow; timeoutMs?: number; pairTimeoutMs?: number; switchTimeoutMs?: number };

/** The real bridge, over `window.postMessage`. */
export function createWindowBridge({
  window: target = window,
  timeoutMs = EXTENSION_PROBE_TIMEOUT_MS,
  pairTimeoutMs = EXTENSION_PAIR_TIMEOUT_MS,
  switchTimeoutMs = EXTENSION_SWITCH_TIMEOUT_MS,
}: WindowBridgeOptions = {}): ExtensionBridge {
  const origin = target.location.origin;

  // Posts `message` and resolves with the first answer `pick` accepts, or null at the timeout. Only messages from this
  // window, from this origin, carrying the bridge's namespace are read; the page's own posts fail `pick`.
  function request<T>(message: ExtensionBridgePageMessage, pick: (answer: ExtensionBridgeExtensionMessage) => T | null, waitMs = timeoutMs): Promise<T | null> {
    return new Promise((resolve) => {
      const finish = (value: T | null) => {
        clearTimeout(timer);
        target.removeEventListener('message', listen);
        resolve(value);
      };
      const listen = (event: MessageEvent) => {
        if (event.source !== target || event.origin !== origin) return;
        const parsed = ExtensionBridgeExtensionMessageSchema.safeParse(event.data);
        const picked = parsed.success ? pick(parsed.data) : null;
        if (picked !== null) finish(picked);
      };
      const timer = setTimeout(() => finish(null), waitMs);
      target.addEventListener('message', listen);
      target.postMessage(message, origin);
    });
  }

  return {
    // Any presence counts, including the one the content script announces when it loads: the answer to "who are you"
    // is the same either way.
    probe: () => request(bridgeMessage({ kind: 'probe' }), (answer) => (answer.kind === 'presence' ? { version: answer.version, paired: answer.paired, accountId: answer.accountId } : null)),
    switchTo: (accountId) => request(bridgeMessage({ kind: 'switch', accountId }), (answer) => (answer.kind === 'switch_outcome' ? answer.outcome : null), switchTimeoutMs),
    pair: (code, accountId) => request(bridgeMessage({ kind: 'pair', code, accountId }), (answer) => (answer.kind === 'pair_outcome' ? answer.outcome : null), pairTimeoutMs),
  };
}
