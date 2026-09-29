import { EXTENSION_BRIDGE_NAMESPACE, EXTENSION_PAIR_PATH, EXTENSION_VERSION, extensionVersionRefusal } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { bridgeRequestFrom, relayPageBridge, type BridgeMessageEvent, type BridgeRequest, type RelayWindow } from './bridge';
import type { ChannelStatus } from './connection';
import { APP_UNREACHABLE } from './messages';
import { createPairingRequests, type ConfirmSwitch, type CurrentAccount, type PairingChannel, type StoredPairing } from './pairing-requests';

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
  const window: RelayWindow = {
    addEventListener: (_type, listener) => void listeners.push(listener),
    postMessage: (message, targetOrigin) => void posted.push({ message, targetOrigin }),
  };
  const dispatch = (event: Partial<BridgeMessageEvent>) => listeners.forEach((listener) => listener({ data: PROBE, origin: ORIGIN, source: window, ...event }));
  return { window, posted, dispatch };
}

// `report` plays the channel's socket: what the app last told it (`ready`, or a `refused` frame on 撤销配对).
function fakeChannel(initial: ChannelStatus | null = null, started: StoredPairing[] = []) {
  let running = false;
  let status = initial;
  const channel: PairingChannel & { report(next: ChannelStatus): void } = {
    report: (next) => {
      status = next;
    },
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

type Setup = { pairing?: StoredPairing; status?: ChannelStatus; app?: (url: string, init?: RequestInit) => Response | Promise<Response>; confirmSwitch?: ConfirmSwitch };

// The content script wired to the service worker's answer, as `content-script.ts` and `service-worker.ts` wire them.
function extensionOnPage({ pairing, status, app = () => jsonResponse(200, { accountId: pairing?.accountId, username: 'alice' }), confirmSwitch }: Setup = {}) {
  const items = new Map<string, unknown>(pairing ? [['pairing', pairing]] : []);
  const started: StoredPairing[] = [];
  const channel = fakeChannel(status ?? null, started);
  const requests = createPairingRequests({
    origin: ORIGIN,
    storage: {
      get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
      set: async (values) => void Object.entries(values).forEach(([key, value]) => items.set(key, value)),
      remove: async (key) => void items.delete(key),
    },
    channel,
    browser: () => 'Chrome 142 Windows',
    ...(confirmSwitch ? { confirmSwitch } : {}),
    fetchImpl: async (url, init) => app(String(url), init),
  });
  const page = fakeWindow();
  const worker = async (request: BridgeRequest) => {
    const message = bridgeRequestFrom(request, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN);
    return message ? requests.bridge(message) : undefined;
  };
  const relay = relayPageBridge({ window: page.window, origin: ORIGIN, ask: worker });
  return { ...page, relay, items, started, channel };
}

// A few turns of the event loop: a request can read more than one response body before it answers.
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('the page bridge', () => {
  it('answers a probe from the baox page with the version and the account it is paired to', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      app: (url, init) => {
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        return jsonResponse(200, { accountId: 'a1', username: 'alice' });
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
      app: () => (revoked ? jsonResponse(401, { error: { code: 'not_paired', message: '...' } }) : jsonResponse(200, { accountId: 'a1', username: 'alice' })),
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

  // The same criterion over a live channel: the app refuses the socket as it revokes, and that refusal is the answer.
  it('reads as unpaired once a connected pairing is revoked, from the channel refusal alone', async () => {
    let asked = 0;
    const { dispatch, posted, channel } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      status: { state: 'ready', accountId: 'a1' },
      app: () => {
        asked += 1;
        return jsonResponse(200, { accountId: 'a1', username: 'alice' });
      },
    });

    dispatch({});
    await settle();
    channel.report({ state: 'refused', code: 'not_paired', message: '...' });
    dispatch({});
    await settle();

    expect(posted.map((post) => post.message)).toEqual([
      expect.objectContaining({ paired: true, accountId: 'a1' }),
      expect.objectContaining({ paired: false, accountId: null }),
    ]);
    expect(asked).toBe(0);
  });

  // Every answer the app gives the token moves 最近连接 (last connected) on the settings page, so opening that page must
  // not ask it when the channel already says the pairing is live.
  it('trusts a ready channel without asking the app', async () => {
    let asked = 0;
    const { dispatch, posted } = extensionOnPage({
      pairing: { token: 'tok', accountId: 'a1' },
      status: { state: 'ready', accountId: 'a1' },
      app: () => {
        asked += 1;
        return jsonResponse(401, { error: { code: 'not_paired', message: '...' } });
      },
    });
    dispatch({});
    await settle();
    expect(posted.map((post) => post.message)).toEqual([expect.objectContaining({ paired: true, accountId: 'a1' })]);
    expect(asked).toBe(0);
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
  const pairRequest = (code = 'K7MQ2PXD', accountId = 'a1') => ({ data: { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code, accountId } });
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
    dispatch({ data: { kind: 'pair', code: 'K7MQ2PXD', accountId: 'a1' } });
    await settle();

    expect(asked).toBe(0);
    expect(items.has('pairing')).toBe(false);
    expect(posted).toEqual([]);
  });

  it('never lets the page reach the popup\'s requests through a pair request', () => {
    expect(bridgeRequestFrom({ kind: 'pair', code: 'K7MQ2PXD', accountId: 'a1' }, { tab: { id: 1 }, url: PAGE_URL }, ORIGIN)).toBeNull();
  });
});

// #292: an extension acting for another 应用账号 asks the employee before it switches. The page asks first (a switch
// request, before it issues a 配对码, since issuing one already ends the signed-in account's earlier pairing), and
// the pair request that follows an agreed switch is not asked about again.
describe('switching accounts through the page bridge', () => {
  const COLLEAGUE: StoredPairing = { token: 'tok-bob', accountId: 'a2' };
  const switchRequest = (accountId = 'a1') => ({ data: { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'switch', accountId } });
  const pairRequest = (accountId = 'a1') => ({ data: { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code: 'K7MQ2PXD', accountId } });
  const switchOutcome = (outcome: string) => ({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'switch_outcome', outcome });
  const pairOutcome = (outcome: unknown) => ({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair_outcome', outcome });

  // Bob (a2) is paired in this browser and the app still honours him (unless `revoked`); a 配对码 redeems to alice
  // (a1). The employee answers the questions in `answers` order.
  function colleagueOnThisBrowser(answers: boolean[], { revoked = false } = {}) {
    const asked: CurrentAccount[] = [];
    const redeemed: string[] = [];
    const extension = extensionOnPage({
      pairing: COLLEAGUE,
      status: { state: 'ready', accountId: 'a2' },
      confirmSwitch: async (current) => {
        asked.push(current);
        return answers[asked.length - 1] ?? false;
      },
      app: (_url, init) => {
        if (init?.method === 'POST') {
          redeemed.push(String(init.body));
          return jsonResponse(200, { token: 'tok-alice', accountId: 'a1' });
        }
        return revoked ? jsonResponse(401, { error: { code: 'not_paired', message: '...' } }) : jsonResponse(200, { accountId: 'a2', username: 'bob' });
      },
    });
    return { ...extension, asked, redeemed };
  }

  it('asks, naming the account it acts for, and on yes redeems the next code without asking again', async () => {
    const { dispatch, posted, items, started, asked, redeemed } = colleagueOnThisBrowser([true]);

    dispatch(switchRequest());
    await settle();
    expect(asked).toEqual([{ accountId: 'a2', name: 'bob' }]);
    expect(posted.map((post) => post.message)).toEqual([switchOutcome('accepted')]);
    expect(redeemed).toEqual([]);

    dispatch(pairRequest());
    await settle();
    expect(asked).toHaveLength(1);
    expect(redeemed).toHaveLength(1);
    expect(items.get('pairing')).toEqual({ token: 'tok-alice', accountId: 'a1' });
    expect(started).toEqual([{ token: 'tok-alice', accountId: 'a1' }]);
    expect(posted.map((post) => post.message)[1]).toEqual(pairOutcome({ status: 'paired', accountId: 'a1' }));
  });

  it('on no, answers declined and keeps the old pairing and its connection', async () => {
    const { dispatch, posted, items, started, channel, asked, redeemed } = colleagueOnThisBrowser([false]);

    dispatch(switchRequest());
    await settle();

    expect(asked).toEqual([{ accountId: 'a2', name: 'bob' }]);
    expect(posted.map((post) => post.message)).toEqual([switchOutcome('declined')]);
    expect(redeemed).toEqual([]);
    expect(items.get('pairing')).toEqual(COLLEAGUE);
    expect(started).toEqual([]);
    expect(channel.status()).toEqual({ state: 'ready', accountId: 'a2' });
  });

  it('asks before redeeming a pair request no agreed switch covers, and on no redeems nothing', async () => {
    const { dispatch, posted, items, started, asked, redeemed } = colleagueOnThisBrowser([false]);

    dispatch(pairRequest());
    await settle();

    expect(asked).toEqual([{ accountId: 'a2', name: 'bob' }]);
    expect(posted.map((post) => post.message)).toEqual([pairOutcome({ status: 'declined' })]);
    expect(redeemed).toEqual([]);
    expect(items.get('pairing')).toEqual(COLLEAGUE);
    expect(started).toEqual([]);
  });

  it('an agreed switch covers a pair request for that account only', async () => {
    const { dispatch, posted, asked, redeemed } = colleagueOnThisBrowser([true, false]);

    dispatch(switchRequest('a1'));
    await settle();
    dispatch(pairRequest('a3'));
    await settle();

    expect(asked).toHaveLength(2);
    expect(posted.map((post) => post.message)).toEqual([switchOutcome('accepted'), pairOutcome({ status: 'declined' })]);
    expect(redeemed).toEqual([]);
  });

  it('does not ask when the stored pairing is one the app no longer honours', async () => {
    const { dispatch, posted, asked } = colleagueOnThisBrowser([false], { revoked: true });
    dispatch(switchRequest());
    await settle();
    expect(asked).toEqual([]);
    expect(posted.map((post) => post.message)).toEqual([switchOutcome('accepted')]);
  });

  it('names the account by its id when the app cannot be reached to give its username', async () => {
    const asked: CurrentAccount[] = [];
    const { dispatch } = extensionOnPage({
      pairing: COLLEAGUE,
      confirmSwitch: async (current) => {
        asked.push(current);
        return false;
      },
      app: () => {
        throw new TypeError('fetch failed');
      },
    });
    dispatch(switchRequest());
    await settle();
    expect(asked).toEqual([{ accountId: 'a2', name: 'a2' }]);
  });

  it('does not ask when unpaired or already acting for the same account', async () => {
    for (const pairing of [undefined, { token: 'tok-old', accountId: 'a1' }]) {
      const asked: CurrentAccount[] = [];
      const { dispatch, posted, items } = extensionOnPage({
        ...(pairing ? { pairing } : {}),
        confirmSwitch: async (current) => {
          asked.push(current);
          return false;
        },
        app: () => jsonResponse(200, { token: 'tok-new', accountId: 'a1' }),
      });
      dispatch(switchRequest());
      await settle();
      dispatch(pairRequest());
      await settle();
      expect(asked).toEqual([]);
      expect(posted.map((post) => post.message)).toEqual([switchOutcome('accepted'), pairOutcome({ status: 'paired', accountId: 'a1' })]);
      expect(items.get('pairing')).toEqual({ token: 'tok-new', accountId: 'a1' });
    }
  });
});
