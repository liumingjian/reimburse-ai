import { EXTENSION_BRIDGE_NAMESPACE, EXTENSION_PAIR_PATH, EXTENSION_VERSION, extensionVersionRefusal } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { bridgeRequestFrom, relayPageBridge, type BridgeMessageEvent, type BridgeRequest, type BridgeWindow } from './bridge';
import type { ChannelStatus } from './connection';
import { APP_UNREACHABLE } from './messages';
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

function fakeChannel(initial: ChannelStatus | null = null, started: StoredPairing[] = []) {
  let running = false;
  let status = initial;
  const channel: PairingChannel = {
    start: (pairing) => {
      started.push(pairing);
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
  const started: StoredPairing[] = [];
  const requests = createPairingRequests({
    origin: ORIGIN,
    storage: {
      get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
      set: async (values) => void Object.entries(values).forEach(([key, value]) => items.set(key, value)),
      remove: async (key) => void items.delete(key),
    },
    channel: fakeChannel(status ?? null, started),
    browser: () => 'Chrome 142 Windows',
    fetchImpl: async (url, init) => app(String(url), init),
  });
  const page = fakeWindow();
  const worker = async (request: BridgeRequest) => {
    const message = bridgeRequestFrom(request, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN);
    return message ? requests.bridge(message) : undefined;
  };
  const relay = relayPageBridge({ window: page.window, origin: ORIGIN, ask: worker });
  return { ...page, relay, items, started };
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

// #291: the page hands the extension a 配对码 it just issued, and the extension redeems it as the popup would.
describe('pairing through the page bridge', () => {
  const pairRequest = (code = 'K7MQ2PXD') => ({ data: { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code } });
  const outcomeOf = (outcome: unknown) => ({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair_outcome', outcome });
  const refusal = (status: number, code: string, message: string) => () => jsonResponse(status, { error: { code, message } });

  it('redeems the code when unpaired, stores the pairing, starts the connection, and answers paired', async () => {
    const redeemed: unknown[] = [];
    const { dispatch, posted, items, started } = extensionOnPage({
      app: (url, init) => {
        redeemed.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) as unknown });
        return jsonResponse(200, { token: 'tok-new', accountId: 'a1' });
      },
    });

    dispatch(pairRequest());
    await settle();

    expect(redeemed).toEqual([{ url: `${ORIGIN}${EXTENSION_PAIR_PATH}`, method: 'POST', body: { code: 'K7MQ2PXD', browser: 'Chrome 142 Windows', version: EXTENSION_VERSION } }]);
    expect(items.get('pairing')).toEqual({ token: 'tok-new', accountId: 'a1' });
    expect(started).toEqual([{ token: 'tok-new', accountId: 'a1' }]);
    expect(posted).toEqual([{ message: outcomeOf({ status: 'paired', accountId: 'a1' }), targetOrigin: ORIGIN }]);
  });

  it('pairs again without asking when already paired to the same account', async () => {
    const { dispatch, posted, items } = extensionOnPage({ pairing: { token: 'tok-old', accountId: 'a1' }, app: () => jsonResponse(200, { token: 'tok-new', accountId: 'a1' }) });
    dispatch(pairRequest());
    await settle();
    expect(items.get('pairing')).toEqual({ token: 'tok-new', accountId: 'a1' });
    expect(posted.map((post) => post.message)).toEqual([outcomeOf({ status: 'paired', accountId: 'a1' })]);
  });

  it('answers a refusal with the server\'s code and message, and keeps what was stored', async () => {
    const tooOld = extensionVersionRefusal('0.9.0', '2.0.0') ?? '';
    const cases = [
      { app: refusal(400, 'code_invalid', '配对码不对'), outcome: { status: 'failed', code: 'code_invalid', message: '配对码不对' } },
      { app: refusal(403, 'version_too_old', tooOld), outcome: { status: 'failed', code: 'version_too_old', message: tooOld } },
      {
        app: () => {
          throw new TypeError('fetch failed');
        },
        outcome: { status: 'failed', code: 'network_error', message: expect.stringContaining(APP_UNREACHABLE) as unknown },
      },
    ];
    for (const { app, outcome } of cases) {
      const { dispatch, posted, items, started } = extensionOnPage({ pairing: { token: 'tok-old', accountId: 'a1' }, app });
      dispatch(pairRequest());
      await settle();
      expect(posted.map((post) => post.message)).toEqual([outcomeOf(outcome)]);
      expect(items.get('pairing')).toEqual({ token: 'tok-old', accountId: 'a1' });
      expect(started).toEqual([]);
    }
  });

  it('ignores a pair request from another origin or another window', async () => {
    let asked = 0;
    const { dispatch, posted, items } = extensionOnPage({
      app: () => {
        asked += 1;
        return jsonResponse(200, { token: 'tok-evil', accountId: 'evil' });
      },
    });

    dispatch({ ...pairRequest(), origin: 'https://evil.example' });
    dispatch({ ...pairRequest(), source: {} });
    dispatch({ ...pairRequest(), source: null });
    dispatch({ data: { kind: 'pair', code: 'K7MQ2PXD' } });
    await settle();

    expect(asked).toBe(0);
    expect(items.has('pairing')).toBe(false);
    expect(posted).toEqual([]);
  });

  it('never lets the page reach the popup\'s requests through a pair request', () => {
    expect(bridgeRequestFrom({ kind: 'pair', code: 'K7MQ2PXD' }, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN)).toBeNull();
  });
});
