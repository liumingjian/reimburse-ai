import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_CLOSE,
  CHANNEL_PING_METHOD,
  EXTENSION_HEARTBEAT_MS,
  EXTENSION_MINIMUM_VERSION,
  EXTENSION_PAIR_PATH,
  EXTENSION_VERSION,
  ExtensionPairingSchema,
  ExtensionTokenSchema,
  type ChannelMessage,
  type ExtensionPairing,
} from '@baox/contract';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import { createExtensionChannel, type ChannelSocket, type ExtensionChannel } from './channel';
import { createPairingService } from './pairing';

// The channel seam (spec #246 Testing Decisions): a fake extension client against the real channel the app wires up,
// with a real database behind it. No port is opened — `websocket.ts` is the only thing that knows about sockets, and
// what it hands over is exactly the two methods this fake provides.

const PAIRING = '/api/extension/pairing';
const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';
const json = { 'content-type': 'application/json' };

let server: TestServer;
let alice: TestClient;

beforeEach(async () => {
  server = await createTestServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

const parse = async (response: Response): Promise<ExtensionPairing> => ExtensionPairingSchema.parse(await response.json());
const view = (client: TestClient) => client.request(PAIRING).then(parse);

const redeem = (code: string, version: string | null = EXTENSION_VERSION) =>
  server.app.request(EXTENSION_PAIR_PATH, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN }, body: JSON.stringify({ code, browser: 'Chrome 142 Windows', ...(version === null ? {} : { version }) }) });

async function pair(client: TestClient): Promise<string> {
  const issued = await parse(await client.post(`${PAIRING}/code`, {}));
  const redeemed = await redeem(issued.code ?? '');
  expect(redeemed.status).toBe(200);
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

// The extension's end of the wire, minus the wire.
function fakeExtension(channel: ExtensionChannel = server.app.extensionChannel) {
  const heard: ChannelMessage[] = [];
  let closedWith: { code: number; reason: string } | null = null;
  const socket: ChannelSocket = {
    send: (data) => heard.push(JSON.parse(data) as ChannelMessage),
    close: (code, reason) => {
      closedWith = { code, reason };
    },
  };
  const session = channel.open(socket);
  return {
    heard,
    closedWith: () => closedWith,
    say: (message: unknown) => session.message(JSON.stringify(message)),
    raw: (text: string) => session.message(text),
    disconnect: () => session.closed(),
  };
}

describe('the 浏览器扩展 channel', () => {
  it('takes the pairing credential from the first message, with nothing in the address to leak', async () => {
    const token = await pair(alice);
    const extension = fakeExtension();

    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });

    expect(extension.heard[0]).toMatchObject({ type: 'ready', accountId: alice.account.accountId });
    expect(server.app.extensionChannel.connected(alice.account.accountId)).toBe(true);
  });

  it('answers a heartbeat so the service worker stays alive', async () => {
    const token = await pair(alice);
    const extension = fakeExtension();
    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });

    await extension.say({ type: 'request', id: 'e1', method: CHANNEL_PING_METHOD, payload: null });

    expect(extension.heard.at(-1)).toEqual({ type: 'response', id: 'e1', ok: true, payload: null });
  });

  it('matches every answer to the request that asked for it', async () => {
    const token = await pair(alice);
    const extension = fakeExtension();
    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });

    // Two in flight at once; only the id says which answer belongs to which.
    const first = server.app.extensionChannel.request(alice.account.accountId, 'fill', { step: 1 });
    const second = server.app.extensionChannel.request(alice.account.accountId, 'readback', { step: 2 });
    const asked = extension.heard.filter((message) => message.type === 'request');
    expect(asked).toHaveLength(2);
    const ids = asked.map((message) => ('id' in message ? message.id : ''));
    expect(new Set(ids).size).toBe(2);

    await extension.say({ type: 'response', id: ids[1] ?? '', ok: true, payload: { read: 'back' } });
    await extension.say({ type: 'response', id: ids[0] ?? '', ok: true, payload: { filled: true } });
    await expect(first).resolves.toEqual({ filled: true });
    await expect(second).resolves.toEqual({ read: 'back' });
  });

  it('refuses an extension below the minimum and tells it how to update, instead of running half a plan', async () => {
    const token = await pair(alice);
    const extension = fakeExtension();

    await extension.say({ type: 'hello', token, version: '0.9.0' });

    const refusal = extension.heard[0];
    expect(refusal).toMatchObject({ type: 'refused', code: 'version_too_old' });
    expect(refusal && 'message' in refusal ? refusal.message : '').toContain(EXTENSION_MINIMUM_VERSION);
    expect(refusal && 'message' in refusal ? refusal.message : '').toContain('重新下载');
    expect(extension.closedWith()).toEqual({ code: CHANNEL_CLOSE.versionTooOld, reason: 'version_too_old' });
    expect(server.app.extensionChannel.connected(alice.account.accountId)).toBe(false);
  });

  it('refuses a credential that no longer names a pairing', async () => {
    const token = await pair(alice);
    await alice.post(`${PAIRING}/revoke`, {});
    const extension = fakeExtension();

    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'not_paired' });
    expect(extension.closedWith()?.code).toBe(CHANNEL_CLOSE.notPaired);
  });

  it('acts on nothing a socket says before it has said who it is', async () => {
    const extension = fakeExtension();

    await extension.say({ type: 'request', id: 'e1', method: 'fill', payload: null });

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'bad_message' });
    expect(extension.closedWith()?.code).toBe(CHANNEL_CLOSE.badMessage);
  });

  it('closes a socket that sends something it cannot read at all', async () => {
    const extension = fakeExtension();

    await extension.raw('not json');

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'bad_message' });
  });

  it("ends that account's ERP 自动化控制权 when the connection goes, and no other account's (ADR-0019)", async () => {
    const bob = await server.signIn('bob');
    const aliceToken = await pair(alice);
    const bobToken = await pair(bob);
    const aliceExtension = fakeExtension();
    const bobExtension = fakeExtension();
    await aliceExtension.say({ type: 'hello', token: aliceToken, version: EXTENSION_VERSION });
    await bobExtension.say({ type: 'hello', token: bobToken, version: EXTENSION_VERSION });
    server.erpLease.acquire({ accountId: alice.account.accountId, taskId: 't-a', jobId: 'j-a' });
    server.erpLease.acquire({ accountId: bob.account.accountId, taskId: 't-b', jobId: 'j-b' });

    aliceExtension.disconnect();

    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    expect(server.erpLease.holder(bob.account.accountId)).toMatchObject({ jobId: 'j-b' });
    expect(server.app.extensionChannel.connected(bob.account.accountId)).toBe(true);
  });

  it('tells the settings page whether the extension is listening right now', async () => {
    const token = await pair(alice);
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: false, version: EXTENSION_VERSION });

    const extension = fakeExtension();
    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: true });

    extension.disconnect();
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: false });
  });

  it('refuses to ask an extension that is not connected, rather than waiting for one', async () => {
    await pair(alice);
    await expect(server.app.extensionChannel.request(alice.account.accountId, 'fill', null)).rejects.toThrow();
  });
});

describe('版本协商 at the HTTP seam', () => {
  it('refuses to pair with an extension below the minimum, and leaves the 配对码 unspent', async () => {
    const issued = await parse(await alice.post(`${PAIRING}/code`, {}));
    const code = issued.code ?? '';

    const refused = await redeem(code, '0.9.0');
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('version_too_old');
    expect(body.error.message).toContain(EXTENSION_MINIMUM_VERSION);
    expect(body.error.message).toContain('重新下载');
    expect(await view(alice)).toMatchObject({ status: 'waiting' });

    // The employee updates and types the same 配对码 again; nothing was burnt by the refusal.
    expect((await redeem(code)).status).toBe(200);
    expect(await view(alice)).toMatchObject({ status: 'paired', version: EXTENSION_VERSION });
  });

  it('refuses an extension too old to report a version at all', async () => {
    const issued = await parse(await alice.post(`${PAIRING}/code`, {}));

    const refused = await redeem(issued.code ?? '', null);

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('version_too_old');
  });
});

describe('a socket that never says who it is', () => {
  // A scheduler fired by hand, so the deadline is exercised without waiting for it.
  function manualTimers() {
    const due: Array<{ run: () => void; ms: number }> = [];
    return {
      due,
      schedule: (run: () => void, ms: number) => {
        const entry = { run, ms };
        due.push(entry);
        return () => {
          const at = due.indexOf(entry);
          if (at >= 0) due.splice(at, 1);
        };
      },
      elapse: () => {
        for (const entry of due.splice(0)) entry.run();
      },
    };
  }

  // The same channel the app wires, over the same database, with only the timer swapped.
  const channelWith = (timers: ReturnType<typeof manualTimers>) =>
    createExtensionChannel({ pairings: createPairingService(server.db, server.clock.now), lease: server.erpLease, now: server.clock.now, schedule: timers.schedule });

  it('is closed once the hello deadline passes, having been told nothing', () => {
    const timers = manualTimers();
    const channel = channelWith(timers);
    const extension = fakeExtension(channel);

    expect(timers.due.map((entry) => entry.ms)).toEqual([EXTENSION_HEARTBEAT_MS]);
    timers.elapse();

    expect(extension.closedWith()).toEqual({ code: 1008, reason: 'hello_timeout' });
    expect(extension.heard).toEqual([]);
    channel.close();
  });

  it('leaves a socket that said a valid hello in time alone', async () => {
    const token = await pair(alice);
    const timers = manualTimers();
    const channel = channelWith(timers);
    const extension = fakeExtension(channel);

    await extension.say({ type: 'hello', token, version: EXTENSION_VERSION });
    timers.elapse();

    expect(extension.closedWith()).toBeNull();
    expect(channel.connected(alice.account.accountId)).toBe(true);
    channel.close();
  });
});
