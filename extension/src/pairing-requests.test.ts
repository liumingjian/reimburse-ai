import { EXTENSION_PAIR_PATH, EXTENSION_VERSION } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import type { ChannelStatus } from './connection';
import { createPairingRequests, type PairingChannel, type PairingStorage, type StoredPairing } from './pairing-requests';

const ORIGIN = 'http://10.250.0.222';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// `chrome.storage.local`, in memory.
function fakeStorage(initial: Record<string, unknown> = {}) {
  const items = new Map(Object.entries(initial));
  const storage: PairingStorage = {
    get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
    set: async (values) => void Object.entries(values).forEach(([key, value]) => items.set(key, value)),
    remove: async (key) => void items.delete(key),
  };
  return { storage, items };
}

// The channel client, recording every pairing it was started with.
function fakeChannel(initial: ChannelStatus | null = null) {
  const started: StoredPairing[] = [];
  let running = false;
  let status = initial;
  const channel: PairingChannel = {
    start: (pairing) => {
      started.push(pairing);
      running = true;
      status = { state: 'connecting' };
    },
    stop: () => {
      running = false;
      status = null;
    },
    running: () => running,
    status: () => status,
  };
  return { channel, started, isRunning: () => running };
}

const PAIRED = { pairing: { token: 'tok', accountId: 'a1' } };

describe('pairing from the popup', () => {
  it('stores the token and account and opens the channel with them', async () => {
    const { storage, items } = fakeStorage();
    const { channel, started } = fakeChannel();
    let seen: unknown = null;
    const requests = createPairingRequests({
      origin: ORIGIN,
      storage,
      channel,
      browser: () => 'Chrome 142 Windows',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)) as unknown };
        return jsonResponse(200, { token: 'tok', accountId: 'a1' });
      },
    });

    const answer = await requests.answer({ kind: 'pair', code: 'K7MQ2PXD' });

    expect(seen).toEqual({ url: `${ORIGIN}${EXTENSION_PAIR_PATH}`, body: { code: 'K7MQ2PXD', browser: 'Chrome 142 Windows', version: EXTENSION_VERSION } });
    expect(items.get('pairing')).toEqual({ token: 'tok', accountId: 'a1' });
    expect(started).toEqual([{ token: 'tok', accountId: 'a1' }]);
    expect(answer).toEqual({ paired: true, accountId: 'a1', version: EXTENSION_VERSION, status: { state: 'connecting' }, error: null });
  });

  it('stores nothing when the app refuses, and shows the refusal as the app wrote it', async () => {
    const { storage, items } = fakeStorage();
    const { channel, started } = fakeChannel();
    const message = '这台服务器要求浏览器扩展 2.0.0 或更新的版本，请回到设置页重新下载扩展包。';
    const requests = createPairingRequests({
      origin: ORIGIN,
      storage,
      channel,
      browser: () => null,
      fetchImpl: async () => jsonResponse(403, { error: { code: 'version_too_old', message } }),
    });

    const answer = await requests.answer({ kind: 'pair', code: 'K7MQ2PXD' });

    expect(items.size).toBe(0);
    expect(started).toEqual([]);
    expect(answer).toEqual({ paired: false, accountId: null, version: EXTENSION_VERSION, status: null, error: message });
  });
});

describe('撤销配对 from the popup', () => {
  it('forgets the pairing even when the app cannot be reached, and says it could not be revoked there', async () => {
    const { storage, items } = fakeStorage(PAIRED);
    const { channel, isRunning } = fakeChannel();
    channel.start(PAIRED.pairing);
    const requests = createPairingRequests({ origin: ORIGIN, storage, channel, browser: () => null, fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')) });

    const answer = await requests.answer({ kind: 'unpair' });

    expect(items.has('pairing')).toBe(false);
    expect(isRunning()).toBe(false);
    expect(answer.paired).toBe(false);
    expect(answer.status).toBeNull();
    expect(answer.error).toContain('应用那边没能撤销');
  });

  it('says nothing more when the app revoked it', async () => {
    const { storage, items } = fakeStorage(PAIRED);
    const { channel } = fakeChannel();
    const requests = createPairingRequests({ origin: ORIGIN, storage, channel, browser: () => null, fetchImpl: async () => jsonResponse(200, { revoked: true }) });

    const answer = await requests.answer({ kind: 'unpair' });

    expect(items.has('pairing')).toBe(false);
    expect(answer).toEqual({ paired: false, accountId: null, version: EXTENSION_VERSION, status: null, error: null });
  });
});

describe('the popup asking for status', () => {
  const unused = () => Promise.reject(new Error('status does not talk HTTP'));

  it('brings the channel back when a pairing is stored and no client is running', async () => {
    const { storage } = fakeStorage(PAIRED);
    const { channel, started } = fakeChannel();
    const requests = createPairingRequests({ origin: ORIGIN, storage, channel, browser: () => null, fetchImpl: unused });

    const answer = await requests.answer({ kind: 'status' });

    expect(started).toEqual([PAIRED.pairing]);
    expect(answer).toEqual({ paired: true, accountId: 'a1', version: EXTENSION_VERSION, status: { state: 'connecting' }, error: null });
  });

  it('leaves a running client alone, and starts nothing when unpaired', async () => {
    const paired = fakeChannel();
    paired.channel.start(PAIRED.pairing);
    await createPairingRequests({ origin: ORIGIN, storage: fakeStorage(PAIRED).storage, channel: paired.channel, browser: () => null, fetchImpl: unused }).status();
    expect(paired.started).toHaveLength(1);

    const unpaired = fakeChannel();
    const answer = await createPairingRequests({ origin: ORIGIN, storage: fakeStorage().storage, channel: unpaired.channel, browser: () => null, fetchImpl: unused }).status();
    expect(unpaired.started).toEqual([]);
    expect(answer.paired).toBe(false);
  });
});
