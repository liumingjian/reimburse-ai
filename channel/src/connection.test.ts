import { CHANNEL_PATH, CHANNEL_HEARTBEAT_MS, CLIENT_VERSION, type ChannelMessage } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelUrl, channelWatch, createChannelClient, type ChannelStatus, type ClientSocket } from './connection';

// A fake server on the other end of the socket: it records what the extension says and can say anything back.
function fakeServer() {
  const dialled: string[] = [];
  const said: ChannelMessage[] = [];
  let live: ClientSocket | null = null;
  const open = (url: string): ClientSocket => {
    dialled.push(url);
    const socket: ClientSocket = {
      send: (data) => said.push(JSON.parse(data) as ChannelMessage),
      close: () => socket.onclose?.({ code: 1006, reason: '' }),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    live = socket;
    return socket;
  };
  return {
    open,
    dialled,
    said,
    accept: () => live?.onopen?.(),
    reply: (message: ChannelMessage) => live?.onmessage?.({ data: JSON.stringify(message) }),
    drop: () => live?.onclose?.({ code: 1006, reason: '' }),
  };
}

// The handler's answer travels through a promise chain, not a timer.
const flush = async () => {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
};

describe('the extension opens the channel and holds it', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the pairing credential in the first message and never in the address', () => {
    const server = fakeServer();
    const client = createChannelClient({ origin: 'http://10.250.0.222', token: 'secret-token', open: server.open });
    server.accept();

    expect(server.dialled).toEqual([`ws://10.250.0.222${CHANNEL_PATH}`]);
    expect(server.dialled[0]).not.toContain('secret-token');
    expect(server.said[0]).toEqual({ type: 'hello', token: 'secret-token', version: CLIENT_VERSION });
    client.stop();
  });

  it('reports its version on every connect, not only when pairing', () => {
    const server = fakeServer();
    const client = createChannelClient({ origin: 'http://10.250.0.222', token: 't', open: server.open });
    server.accept();
    server.reply({ type: 'ready', accountId: 'a1', heartbeatMs: CHANNEL_HEARTBEAT_MS });
    server.drop();
    // The reconnect is on a timer; the second dial is a second `hello`, carrying the version again.
    vi.advanceTimersByTime(600);
    server.accept();

    expect(server.said.filter((message) => message.type === 'hello').map((message) => 'version' in message && message.version)).toEqual([CLIENT_VERSION, CLIENT_VERSION]);
    client.stop();
  });

  it('keeps the service worker alive with a heartbeat well inside 20 seconds', () => {
    const server = fakeServer();
    const client = createChannelClient({ origin: 'http://127.0.0.1:4319', token: 't', open: server.open });
    server.accept();
    server.reply({ type: 'ready', accountId: 'a1', heartbeatMs: CHANNEL_HEARTBEAT_MS });

    expect(CHANNEL_HEARTBEAT_MS).toBeLessThanOrEqual(20_000);
    vi.advanceTimersByTime(20_000);
    const pings = server.said.filter((message) => message.type === 'request' && message.method === 'ping');
    expect(pings.length).toBeGreaterThanOrEqual(1);
    client.stop();
  });

  it('matches an answer to the request that asked for it, in both directions', async () => {
    const server = fakeServer();
    const client = createChannelClient({
      origin: 'http://127.0.0.1:4319',
      token: 't',
      open: server.open,
      onRequest: async (method, payload) => ({ ran: method, saw: payload }),
    });
    server.accept();
    server.reply({ type: 'ready', accountId: 'a1', heartbeatMs: CHANNEL_HEARTBEAT_MS });

    // Extension asks, server answers out of order: two requests are in flight and only the id says which is which.
    const first = client.request('readback', { bill: 1 });
    const second = client.request('attempt_started', { bill: 2 });
    const asked = server.said.filter((message) => message.type === 'request' && message.method !== 'ping');
    const ids = asked.map((message) => ('id' in message ? message.id : ''));
    expect(new Set(ids).size).toBe(2);
    server.reply({ type: 'response', id: ids[1] ?? '', ok: true, payload: { persisted: true } });
    server.reply({ type: 'response', id: ids[0] ?? '', ok: true, payload: { verdict: 'ok' } });
    await expect(first).resolves.toEqual({ verdict: 'ok' });
    await expect(second).resolves.toEqual({ persisted: true });

    // Server asks, extension answers, echoing the id it was given.
    server.reply({ type: 'request', id: 'server-7', method: 'fill', payload: { plan: 'p' } });
    await flush();
    expect(server.said.at(-1)).toEqual({ type: 'response', id: 'server-7', ok: true, payload: { ran: 'fill', saw: { plan: 'p' } } });
    client.stop();
  });

  it('stops dialling once the server has refused this version, and shows what it said', () => {
    const server = fakeServer();
    const seen: ChannelStatus[] = [];
    const client = createChannelClient({ origin: 'http://127.0.0.1:4319', token: 't', open: server.open, onStatus: (status) => seen.push(status) });
    server.accept();
    server.reply({ type: 'refused', code: 'version_too_old', message: '这台服务器要求浏览器扩展 2.0.0 或更新的版本' });
    server.drop();
    vi.advanceTimersByTime(60_000);

    expect(server.dialled).toHaveLength(1);
    expect(client.status()).toEqual({ state: 'refused', code: 'version_too_old', message: '这台服务器要求浏览器扩展 2.0.0 或更新的版本' });
    expect(seen.map((status) => status.state)).toContain('refused');
    client.stop();
  });

  it('dials again after a connection is lost, with a growing pause', () => {
    const server = fakeServer();
    const client = createChannelClient({ origin: 'http://127.0.0.1:4319', token: 't', open: server.open });
    server.accept();
    server.drop();
    expect(server.dialled).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(server.dialled).toHaveLength(2);
    server.accept();
    server.drop();
    vi.advanceTimersByTime(500);
    expect(server.dialled).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(server.dialled).toHaveLength(3);
    client.stop();
  });

  it('follows the scheme the app is served over', () => {
    expect(channelUrl('https://baox.example.com')).toBe(`wss://baox.example.com${CHANNEL_PATH}`);
  });
});

describe('what a running 去报销 hears of the channel', () => {
  it('hears a ready socket go, and waits for the next one to be ready', async () => {
    const server = fakeServer();
    const watch = channelWatch();
    let closed = 0;
    watch.onClosed(() => {
      closed += 1;
    });
    const client = createChannelClient({ origin: 'http://10.250.0.222', token: 't', open: server.open, onStatus: watch.status });
    server.accept();
    server.reply({ type: 'ready', accountId: 'a1', heartbeatMs: CHANNEL_HEARTBEAT_MS });
    await watch.ready();

    server.drop();
    expect(closed).toBe(1);
    let back = false;
    const waiting = watch.ready().then(() => {
      back = true;
    });
    await flush();
    expect(back).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 600));
    server.accept();
    server.reply({ type: 'ready', accountId: 'a1', heartbeatMs: CHANNEL_HEARTBEAT_MS });
    await waiting;
    expect(closed).toBe(1);
    client.stop();
  });
});
