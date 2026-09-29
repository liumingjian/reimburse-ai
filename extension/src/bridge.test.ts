import { EXTENSION_BRIDGE_NAMESPACE, EXTENSION_PAIR_PATH, EXTENSION_VERSION } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { bridgeRequestFrom, relayPageBridge, type BridgeMessageEvent, type BridgeRequest, type BridgeWindow } from './bridge';
import type { ChannelStatus } from './connection';
import { createPairingRequests, type PairingChannel, type StoredPairing } from './pairing-requests';

// The page bridge (#290) at its protocol: what the baox page posts, and what it is answered. The page's window and
// the runtime hop between content script and service worker are faked; everything behind them is the real thing.

const ORIGIN = 'http://10.250.0.222:8888';
const PAGE_URL = `${ORIGIN}/#/settings`;
const PROBE = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'probe' };

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The page's window: what the page posts is dispatched to the listeners; what the content script posts is recorded.
function fakeWindow() {
  const listeners: ((event: BridgeMessageEvent) => void)[] = [];
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const window: BridgeWindow = {
    addEventListener: (_type, listener) => void listeners.push(listener),
    postMessage: (message, targetOrigin) => void posted.push({ message, targetOrigin }),
  };
  const dispatch = (event: Partial<BridgeMessageEvent>) => listeners.forEach((listener) => listener({ data: PROBE, origin: ORIGIN, source: window, ...event }));
  return { window, posted, dispatch };
}

function fakeChannel(initial: ChannelStatus | null = null) {
  let running = false;
  let status = initial;
  const channel: PairingChannel = {
    start: () => {
      running = true;
      status ??= { state: 'connecting' };
    },
    stop: () => {
      running = false;
      status = null;
    },
    running: () => running,
    status: () => status,
  };
  return channel;
}

type Setup = { pairing?: StoredPairing; status?: ChannelStatus; app?: (url: string, init?: RequestInit) => Response | Promise<Response> };

// The content script wired to the service worker's answer, as `content-script.ts` and `service-worker.ts` wire them.
function extensionOnPage({ pairing, status, app = () => jsonResponse(200, { accountId: pairing?.accountId }) }: Setup = {}) {
  const items = new Map<string, unknown>(pairing ? [['pairing', pairing]] : []);
  const requests = createPairingRequests({
    origin: ORIGIN,
    storage: {
      get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
      set: async (values) => void Object.entries(values).forEach(([key, value]) => items.set(key, value)),
      remove: async (key) => void items.delete(key),
    },
    channel: fakeChannel(status ?? null),
    browser: () => 'Chrome 142 Windows',
    fetchImpl: async (url, init) => app(String(url), init),
  });
  const page = fakeWindow();
  const worker = async (request: BridgeRequest) => {
    const message = bridgeRequestFrom(request, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN);
    return message ? requests.bridge(message) : undefined;
  };
  const relay = relayPageBridge({ window: page.window, origin: ORIGIN, ask: worker });
  return { ...page, relay };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the page bridge', () => {
  it('answers a probe from the baox page with the version and the account it is paired to', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      app: (url, init) => {
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        return jsonResponse(200, { accountId: 'a1' });
      },
    });

    dispatch({});
    await settle();

    expect(posted).toEqual([{ message: { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'presence', version: EXTENSION_VERSION, paired: true, accountId: 'a1' }, targetOrigin: ORIGIN }]);
    expect(seen).toEqual([{ url: `${ORIGIN}${EXTENSION_PAIR_PATH}`, authorization: 'Bearer tok' }]);
  });

  it('answers unpaired when nothing is stored', async () => {
    const { dispatch, posted } = extensionOnPage();
    dispatch({});
    await settle();
    expect(posted.map((post) => post.message)).toEqual([{ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'presence', version: EXTENSION_VERSION, paired: false, accountId: null }]);
  });

  it('announces itself when the content script loads', async () => {
    const { relay, posted } = extensionOnPage({ pairing: { token: 'tok', accountId: 'a1' } });
    await relay.announce();
    expect(posted.map((post) => post.message)).toEqual([expect.objectContaining({ kind: 'presence', paired: true, accountId: 'a1' })]);
  });

  it('does not answer another origin, another window, or a message without the namespace tag', async () => {
    const { dispatch, posted } = extensionOnPage({ pairing: { token: 'tok', accountId: 'a1' } });

    dispatch({ origin: 'https://evil.example' });
    dispatch({ origin: 'http://10.250.0.222' });
    dispatch({ source: {} });
    dispatch({ source: null });
    dispatch({ data: { kind: 'probe' } });
    dispatch({ data: { ...PROBE, namespace: 'someone-else' } });
    dispatch({ data: 'probe' });
    await settle();

    expect(posted).toEqual([]);
  });

  // The acceptance criterion behind this: the page must never show a stale 已连接 after 撤销配对.
  it('reads as unpaired once the pairing is revoked from the settings page, though the token is still stored', async () => {
    let revoked = false;
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      status: { state: 'ready', accountId: 'a1' },
      app: () => (revoked ? jsonResponse(401, { error: { code: 'not_paired', message: '...' } }) : jsonResponse(200, { accountId: 'a1' })),
    });

    dispatch({});
    await settle();
    revoked = true;
    dispatch({});
    await settle();

    expect(posted.map((post) => post.message)).toEqual([
      expect.objectContaining({ paired: true, accountId: 'a1' }),
      expect.objectContaining({ paired: false, accountId: null }),
    ]);
  });

  it('reads as unpaired when the channel was refused for a pairing that is gone, without asking the app', async () => {
    let asked = 0;
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      status: { state: 'refused', code: 'not_paired', message: '...' },
      app: () => {
        asked += 1;
        return jsonResponse(200, { accountId: 'a1' });
      },
    });
    dispatch({});
    await settle();
    expect(posted.map((post) => post.message)).toEqual([expect.objectContaining({ paired: false, accountId: null })]);
    expect(asked).toBe(0);
  });

  it('keeps the stored pairing when the app cannot be reached to confirm it', async () => {
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      app: () => {
        throw new TypeError('fetch failed');
      },
    });
    dispatch({});
    await settle();
    expect(posted.map((post) => post.message)).toEqual([expect.objectContaining({ paired: true, accountId: 'a1' })]);
  });
});

describe('what the service worker takes as a page bridge request', () => {
  const request = { kind: 'bridge', message: PROBE };

  it('takes a bridge request from a content script on the baox origin', () => {
    expect(bridgeRequestFrom(request, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN)).toEqual(PROBE);
  });

  it('takes nothing from the popup, another origin, or anything that is not a bridge request', () => {
    expect(bridgeRequestFrom(request, { url: 'chrome-extension://abc/popup.html' }, ORIGIN)).toBeNull();
    expect(bridgeRequestFrom(request, { tab: { id: 1 }, url: 'https://evil.example/' }, ORIGIN)).toBeNull();
    expect(bridgeRequestFrom({ kind: 'unpair' }, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN)).toBeNull();
    expect(bridgeRequestFrom({ kind: 'bridge', message: { kind: 'probe' } }, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN)).toBeNull();
  });
});
