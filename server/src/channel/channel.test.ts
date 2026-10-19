import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_CLOSE,
  CHANNEL_PING_METHOD,
  CHANNEL_HEARTBEAT_MS,
  MINIMUM_CLIENT_VERSION,
  PAIRING_PATH,
  CLIENT_VERSION,
  PairingViewSchema,
  PairingTokenSchema,
  type ChannelMessage,
  type PairingView,
} from '@baox/contract';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import { createClientChannel, type ChannelSocket, type ClientChannel } from './channel';
import { createPairingService } from './pairing';

// The channel seam (spec #246 Testing Decisions): a fake 本地执行器 client against the real channel the app wires up,
// with a real database behind it. No port is opened — `websocket.ts` is the only thing that knows about sockets, and
// what it hands over is exactly the two methods this fake provides.

const PAIRING = '/api/pairing';
const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';
const json = { 'content-type': 'application/json' };

let server: TestServer;
let alice: TestClient;

beforeEach(async () => {
  server = await createTestServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

const parse = async (response: Response): Promise<PairingView> => PairingViewSchema.parse(await response.json());
const view = (client: TestClient) => client.request(PAIRING).then(parse);

const redeem = (code: string, version: string | null = CLIENT_VERSION) =>
  server.app.request(PAIRING_PATH, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN }, body: JSON.stringify({ code, browser: 'Chrome 142 Windows', ...(version === null ? {} : { version }) }) });

async function pair(client: TestClient): Promise<string> {
  const issued = await parse(await client.post(`${PAIRING}/code`, {}));
  const redeemed = await redeem(issued.code ?? '');
  expect(redeemed.status).toBe(200);
  return PairingTokenSchema.parse(await redeemed.json()).token;
}

// The 本地执行器's end of the wire, minus the wire.
function fakeLocalExecutor(channel: ClientChannel = server.app.clientChannel) {
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

describe('the 本地执行器 channel', () => {
  it('takes the pairing credential from the first message, with nothing in the address to leak', async () => {
    const token = await pair(alice);
    const extension = fakeLocalExecutor();

    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });

    expect(extension.heard[0]).toMatchObject({ type: 'ready', accountId: alice.account.accountId });
    expect(server.app.clientChannel.connected(alice.account.accountId)).toBe(true);
  });

  it('answers a heartbeat so the client knows the channel is alive', async () => {
    const token = await pair(alice);
    const extension = fakeLocalExecutor();
    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });

    await extension.say({ type: 'request', id: 'e1', method: CHANNEL_PING_METHOD, payload: null });

    expect(extension.heard.at(-1)).toEqual({ type: 'response', id: 'e1', ok: true, payload: null });
  });

  it('matches every answer to the request that asked for it', async () => {
    const token = await pair(alice);
    const extension = fakeLocalExecutor();
    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });

    // Two in flight at once; only the id says which answer belongs to which.
    const first = server.app.clientChannel.request(alice.account.accountId, 'fill', { step: 1 });
    const second = server.app.clientChannel.request(alice.account.accountId, 'readback', { step: 2 });
    const asked = extension.heard.filter((message) => message.type === 'request');
    expect(asked).toHaveLength(2);
    const ids = asked.map((message) => ('id' in message ? message.id : ''));
    expect(new Set(ids).size).toBe(2);

    await extension.say({ type: 'response', id: ids[1] ?? '', ok: true, payload: { read: 'back' } });
    await extension.say({ type: 'response', id: ids[0] ?? '', ok: true, payload: { filled: true } });
    await expect(first).resolves.toEqual({ filled: true });
    await expect(second).resolves.toEqual({ read: 'back' });
  });

  it('refuses a 本地执行器 below the minimum and tells it how to update, instead of running half a plan', async () => {
    const token = await pair(alice);
    const extension = fakeLocalExecutor();

    await extension.say({ type: 'hello', token, version: '0.9.0' });

    const refusal = extension.heard[0];
    expect(refusal).toMatchObject({ type: 'refused', code: 'version_too_old' });
    expect(refusal && 'message' in refusal ? refusal.message : '').toContain(MINIMUM_CLIENT_VERSION);
    expect(refusal && 'message' in refusal ? refusal.message : '').toContain('安装命令');
    expect(extension.closedWith()).toEqual({ code: CHANNEL_CLOSE.versionTooOld, reason: 'version_too_old' });
    expect(server.app.clientChannel.connected(alice.account.accountId)).toBe(false);
  });

  it('refuses a credential that no longer names a pairing', async () => {
    const token = await pair(alice);
    await alice.post(`${PAIRING}/revoke`, {});
    const extension = fakeLocalExecutor();

    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'not_paired' });
    expect(extension.closedWith()?.code).toBe(CHANNEL_CLOSE.notPaired);
  });

  it('acts on nothing a socket says before it has said who it is', async () => {
    const extension = fakeLocalExecutor();

    await extension.say({ type: 'request', id: 'e1', method: 'fill', payload: null });

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'bad_message' });
    expect(extension.closedWith()?.code).toBe(CHANNEL_CLOSE.badMessage);
  });

  it('closes a socket that sends something it cannot read at all', async () => {
    const extension = fakeLocalExecutor();

    await extension.raw('not json');

    expect(extension.heard[0]).toMatchObject({ type: 'refused', code: 'bad_message' });
  });

  it("tells whoever runs work over it that the account's connection went, and no other account's", async () => {
    const bob = await server.signIn('bob');
    const lost: string[] = [];
    const channel = createClientChannel({ pairings: createPairingService(server.db, server.clock.now), now: server.clock.now, onLost: (accountId) => lost.push(accountId) });
    const aliceToken = await pair(alice);
    const aliceExecutor = fakeLocalExecutor(channel);
    const bobExecutor = fakeLocalExecutor(channel);
    await aliceExecutor.say({ type: 'hello', token: aliceToken, version: CLIENT_VERSION });
    await bobExecutor.say({ type: 'hello', token: await pair(bob), version: CLIENT_VERSION });
    // The lease is the job's, not the socket's (ADR-0020): the channel leaves it alone.
    server.erpLease.acquire({ accountId: alice.account.accountId, taskId: 't-a', jobId: 'j-a' });

    aliceExecutor.disconnect();
    // The same 本地执行器 dialling again over a socket the server never saw close: the older one is lost too.
    await fakeLocalExecutor(channel).say({ type: 'hello', token: aliceToken, version: CLIENT_VERSION });
    await fakeLocalExecutor(channel).say({ type: 'hello', token: aliceToken, version: CLIENT_VERSION });

    expect(lost).toEqual([alice.account.accountId, alice.account.accountId]);
    expect(server.erpLease.holder(alice.account.accountId)).toMatchObject({ jobId: 'j-a' });
    expect(channel.connected(bob.account.accountId)).toBe(true);
    channel.close();
  });

  it('tells the settings page whether the 本地执行器 is listening right now', async () => {
    const token = await pair(alice);
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: false, version: CLIENT_VERSION });

    const extension = fakeLocalExecutor();
    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: true });

    extension.disconnect();
    expect(await view(alice)).toMatchObject({ status: 'paired', connected: false });
  });

  it('refuses to ask a 本地执行器 that is not connected, rather than waiting for one', async () => {
    await pair(alice);
    await expect(server.app.clientChannel.request(alice.account.accountId, 'fill', null)).rejects.toThrow();
  });
});

describe('版本协商 at the HTTP seam', () => {
  it('refuses to pair with a 本地执行器 below the minimum, and leaves the 配对码 unspent', async () => {
    const issued = await parse(await alice.post(`${PAIRING}/code`, {}));
    const code = issued.code ?? '';

    const refused = await redeem(code, '0.9.0');
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('version_too_old');
    expect(body.error.message).toContain(MINIMUM_CLIENT_VERSION);
    expect(body.error.message).toContain('安装命令');
    expect(await view(alice)).toMatchObject({ status: 'waiting' });

    // The employee updates and types the same 配对码 again; nothing was burnt by the refusal.
    expect((await redeem(code)).status).toBe(200);
    expect(await view(alice)).toMatchObject({ status: 'paired', version: CLIENT_VERSION });
  });

  it('refuses a 本地执行器 too old to report a version at all', async () => {
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
    createClientChannel({ pairings: createPairingService(server.db, server.clock.now), now: server.clock.now, schedule: timers.schedule });

  it('is closed once the hello deadline passes, having been told nothing', () => {
    const timers = manualTimers();
    const channel = channelWith(timers);
    const extension = fakeLocalExecutor(channel);

    expect(timers.due.map((entry) => entry.ms)).toEqual([CHANNEL_HEARTBEAT_MS]);
    timers.elapse();

    expect(extension.closedWith()).toEqual({ code: 1008, reason: 'hello_timeout' });
    expect(extension.heard).toEqual([]);
    channel.close();
  });

  it('leaves a socket that said a valid hello in time alone', async () => {
    const token = await pair(alice);
    const timers = manualTimers();
    const channel = channelWith(timers);
    const extension = fakeLocalExecutor(channel);

    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });
    timers.elapse();

    expect(extension.closedWith()).toBeNull();
    expect(channel.connected(alice.account.accountId)).toBe(true);
    channel.close();
  });
});

describe('a pairing that goes away takes its live socket with it', () => {
  // Stories 10 and 12: whichever way the pairing ends, the old extension is refused for good — the terminal `refused`
  // frame, not a close it would redial after — and the next 去报销 of the account is never sent to it.
  async function connectedExecutor() {
    const token = await pair(alice);
    const extension = fakeLocalExecutor();
    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });
    expect(server.app.clientChannel.connected(alice.account.accountId)).toBe(true);
    return { token, extension };
  }

  function expectCutOff(extension: ReturnType<typeof fakeLocalExecutor>, accountId: string) {
    expect(extension.heard.at(-1)).toMatchObject({ type: 'refused', code: 'not_paired' });
    expect(extension.closedWith()).toEqual({ code: CHANNEL_CLOSE.notPaired, reason: 'not_paired' });
    expect(server.app.clientChannel.connected(accountId)).toBe(false);
  }

  async function expectNoFillReaches(extension: ReturnType<typeof fakeLocalExecutor>, accountId: string) {
    const heard = extension.heard.length;
    await expect(server.app.clientChannel.request(accountId, 'erp.fill', {})).rejects.toMatchObject({ code: 'executor_offline' });
    expect(extension.heard).toHaveLength(heard);
  }

  it('on 撤销配对 in the settings page', async () => {
    const { extension } = await connectedExecutor();

    expect((await alice.post(`${PAIRING}/revoke`, {})).status).toBe(200);

    expectCutOff(extension, alice.account.accountId);
    await expectNoFillReaches(extension, alice.account.accountId);
  });

  it('on a new 配对码, before the new 本地执行器 has even paired', async () => {
    const { extension } = await connectedExecutor();

    expect((await alice.post(`${PAIRING}/code`, {})).status).toBe(200);

    expectCutOff(extension, alice.account.accountId);
    await expectNoFillReaches(extension, alice.account.accountId);
  });

  it('on the account being deactivated', async () => {
    const bob = await server.signIn('bob');
    const token = await pair(bob);
    const extension = fakeLocalExecutor();
    await extension.say({ type: 'hello', token, version: CLIENT_VERSION });

    expect((await alice.post(`/api/admin/accounts/${bob.account.accountId}`, { active: false })).status).toBe(200);

    expectCutOff(extension, bob.account.accountId);
    await expectNoFillReaches(extension, bob.account.accountId);
  });

  it('on 撤销配对 from the 本地执行器 itself, authorised by its own token', async () => {
    const { token, extension } = await connectedExecutor();
    const revokeWith = (bearer: string) =>
      server.app.request(PAIRING_PATH, { method: 'DELETE', headers: { authorization: `Bearer ${bearer}`, origin: EXTENSION_ORIGIN } });

    expect((await revokeWith('not-a-token')).status).toBe(401);
    expect(server.app.clientChannel.connected(alice.account.accountId)).toBe(true);

    expect((await revokeWith(token)).status).toBe(200);

    expectCutOff(extension, alice.account.accountId);
    expect(await view(alice)).toMatchObject({ status: 'none' });
    await expectNoFillReaches(extension, alice.account.accountId);
    // Gone for good: the token answers nothing any more, and a second revocation finds nothing to revoke.
    expect((await server.app.request(PAIRING_PATH, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await revokeWith(token)).status).toBe(401);
  });

  it('refuses a hello whose token was checked just before the pairing went', async () => {
    const token = await pair(alice);
    const pairings = createPairingService(server.db, server.clock.now);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = createClientChannel({
      pairings: {
        ...pairings,
        lookup: async (value) => {
          const found = await pairings.lookup(value);
          await held;
          return found;
        },
      },
      now: server.clock.now,
    });
    const extension = fakeLocalExecutor(channel);

    const hello = extension.say({ type: 'hello', token, version: CLIENT_VERSION });
    channel.disconnect(alice.account.accountId);
    release();
    await hello;

    expect(extension.heard).toEqual([expect.objectContaining({ type: 'refused', code: 'not_paired' })]);
    expect(channel.connected(alice.account.accountId)).toBe(false);
    channel.close();
  });
});
