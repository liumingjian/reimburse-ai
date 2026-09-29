import { EXTENSION_BRIDGE_NAMESPACE, ExtensionBridgeExtensionMessageSchema, ExtensionBridgePageMessageSchema, type ExtensionBridgePageMessage } from '@baox/contract';

// The page bridge (#287): how the baox page and this extension talk without the employee typing anything.
//
// The page speaks `window.postMessage` (the protocol is in `@baox/contract`); the content script (`content-script.ts`)
// runs on the baox origin only and relays each page message to the service worker as a `BridgeRequest`; the service
// worker answers it through `pairing-requests.ts` `bridge`, and the content script posts the answer back to the page.
//
// Two checks keep every other page out. The content script listens only to messages from its own window and from the
// origin stamped into this build (`origin.ts`), which the manifest also restricts it to; the service worker accepts a
// `BridgeRequest` only from a content script on that origin, and never lets one reach the popup's requests (撤销配对,
// above all). Origins are compared as literal strings, the way the server's exact-origin guard compares them, so the
// stamped origin never carries a default port or a trailing slash.

/** What the content script sends the service worker for one page message. */
export type BridgeRequest = { kind: 'bridge'; message: ExtensionBridgePageMessage };

/** A `message` event as far as the relay reads it. */
export type BridgeMessageEvent = { data: unknown; origin: string; source: unknown };

/** The slice of `window` the relay uses. */
export type BridgeWindow = {
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

export type PageBridgeRelayOptions = {
  window: BridgeWindow;
  /** The baked-in baox origin: the only one listened to and posted to. */
  origin: string;
  /** Hands a page message to the service worker; resolves with its answer. */
  ask: (request: BridgeRequest) => Promise<unknown>;
};

/**
 * Starts relaying page messages from `window` to the service worker, and returns `announce`, which posts the
 * extension's presence unasked (the content script calls it once, on load).
 */
export function relayPageBridge({ window, origin, ask }: PageBridgeRelayOptions): { announce(): Promise<void> } {
  async function relay(message: ExtensionBridgePageMessage): Promise<void> {
    // A service worker that is gone (the extension was reloaded under the page) answers nothing, and so does the
    // relay: to the page, silence reads as "no extension", which is then true.
    const answer = await ask({ kind: 'bridge', message }).catch(() => null);
    const parsed = ExtensionBridgeExtensionMessageSchema.safeParse(answer);
    if (parsed.success) window.postMessage(parsed.data, origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== origin) return;
    const parsed = ExtensionBridgePageMessageSchema.safeParse(event.data);
    if (parsed.success) void relay(parsed.data);
  });

  return { announce: () => relay({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'probe' }) };
}

/** Who sent a runtime message, as far as the service worker checks it (`chrome.runtime.MessageSender`). */
export type BridgeSender = { tab?: unknown; url?: string };

/**
 * The page message inside a runtime message, or null when it is not a `BridgeRequest` from a content script on
 * `origin`. The service worker answers a non-null result with `bridge` and nothing else.
 */
export function bridgeRequestFrom(message: unknown, sender: BridgeSender, origin: string): ExtensionBridgePageMessage | null {
  if (!sender.tab || !sender.url || originOf(sender.url) !== origin) return null;
  if (typeof message !== 'object' || message === null || (message as { kind?: unknown }).kind !== 'bridge') return null;
  const parsed = ExtensionBridgePageMessageSchema.safeParse((message as { message?: unknown }).message);
  return parsed.success ? parsed.data : null;
}

/** Whether a runtime message came from a content script rather than from the popup. */
export const fromContentScript = (sender: BridgeSender): boolean => sender.tab !== undefined;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
