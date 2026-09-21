import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_PAIRING_CODE_TTL_MS, EXTENSION_PAIR_PATH, ExtensionIdentitySchema, ExtensionPairingSchema, ExtensionTokenSchema, type ExtensionPairing } from '@baox/contract';
import { createTestServer, TEST_PASSWORD, type TestClient, type TestServer } from '../test/harness';

// The HTTP seam (spec #246 Testing Decisions): 扩展配对 (extension pairing, ADR-0019) driven through `app.request()`,
// which is where both sides of it live — the settings page behind the session cookie, and the extension, which has
// no session, at EXTENSION_PAIR_PATH.
//
// The extension's requests are written the way a real one arrives: an `Origin` of its own
// `chrome-extension://…`, which the app's exact-origin guard would refuse for any other write.

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

const parse = async (response: Response): Promise<ExtensionPairing> => {
  expect(response.status).toBe(200);
  return ExtensionPairingSchema.parse(await response.json());
};
const view = (client: TestClient) => client.request(PAIRING).then(parse);
const issue = (client: TestClient) => client.post(`${PAIRING}/code`, {}).then(parse);
const revoke = (client: TestClient) => client.post(`${PAIRING}/revoke`, {}).then(parse);

const redeem = (code: string, browser?: string) =>
  server.app.request(EXTENSION_PAIR_PATH, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN }, body: JSON.stringify({ code, ...(browser === undefined ? {} : { browser }) }) });
const whoami = (token: string) => server.app.request(EXTENSION_PAIR_PATH, { headers: { authorization: `Bearer ${token}` } });

const codeOf = (pairing: ExtensionPairing): string => {
  expect(pairing.code).not.toBeNull();
  return pairing.code ?? '';
};
const pair = async (client: TestClient, browser?: string): Promise<string> => {
  const redeemed = await redeem(codeOf(await issue(client)), browser);
  expect(redeemed.status).toBe(200);
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
};
const errorOf = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

describe('扩展配对 (extension pairing)', () => {
  it('issues a 配对码 of 8 characters an extension exchanges once for a long-lived token carrying the 应用账号', async () => {
    const issued = await issue(alice);
    expect(issued.status).toBe('waiting');
    expect(codeOf(issued)).toMatch(/^[A-Z2-9]{8}$/);
    expect(Date.parse(issued.codeExpiresAt ?? '') - server.clock.now().getTime()).toBeCloseTo(EXTENSION_PAIRING_CODE_TTL_MS, -3);

    const redeemed = await redeem(codeOf(issued), 'Chrome 142 on Windows');
    expect(redeemed.status).toBe(200);
    const paired = ExtensionTokenSchema.parse(await redeemed.json());
    expect(paired.accountId).toBe(alice.account.accountId);
    // The token is what routes ERP work afterwards, and it names the same 应用账号 without a session anywhere near it.
    expect(ExtensionIdentitySchema.parse(await (await whoami(paired.token)).json()).accountId).toBe(alice.account.accountId);

    // Single use: the code the employee read is spent, and reading it again pairs nothing.
    const again = await redeem(codeOf(issued));
    expect(again.status).toBe(401);
    expect(await errorOf(again)).toBe('pairing_code_invalid');

    // Stored the way a session is: the code and the token themselves are nowhere in the row, only their sha256.
    const rows = JSON.stringify(await server.db.selectFrom('extension_pairing').selectAll().execute());
    expect(rows).not.toContain(paired.token);
    expect(rows).not.toContain(codeOf(issued));
  });

  it('refuses a 配对码 older than ten minutes, and the settings page then shows no pairing at all', async () => {
    const issued = await issue(alice);
    server.clock.advance(EXTENSION_PAIRING_CODE_TTL_MS + 1000);

    const late = await redeem(codeOf(issued));
    expect(late.status).toBe(401);
    expect(await errorOf(late)).toBe('pairing_code_invalid');
    // Not left saying an extension is still expected: an unused code that ran out is no pairing.
    expect((await view(alice)).status).toBe('none');
  });

  it('replaces the previous 扩展配对 when a new 配对码 is issued: the old extension is no longer this account\'s', async () => {
    const first = await pair(alice);
    expect((await view(alice)).status).toBe('paired');

    const reissued = await issue(alice);
    expect(reissued.status).toBe('waiting');
    expect((await whoami(first)).status).toBe(401);

    const second = await pair(alice);
    expect(second).not.toBe(first);
    expect((await whoami(second)).status).toBe(200);
    expect((await whoami(first)).status).toBe(401);
  });

  it('revokes the pairing without signing the account out, and a logout leaves the extension paired', async () => {
    const token = await pair(alice);
    expect((await revoke(alice)).status).toBe('none');
    expect((await whoami(token)).status).toBe(401);
    // 撤销配对 is not a logout: the same browser is still signed in.
    expect((await alice.request('/api/tasks')).status).toBe(200);

    const kept = await pair(alice);
    expect((await alice.post('/api/auth/logout', {})).status).toBe(200);
    expect((await alice.request('/api/tasks')).status).toBe(401);
    // A logout is not an unpair: the extension keeps working for the 应用账号 it was paired with.
    expect(ExtensionIdentitySchema.parse(await (await whoami(kept)).json()).accountId).toBe(alice.account.accountId);
  });

  it('lists the paired browser and its last connection, and the connection time follows the extension', async () => {
    const token = await pair(alice, 'Chrome 142 on Windows');
    const paired = await view(alice);
    expect(paired).toMatchObject({ status: 'paired', browser: 'Chrome 142 on Windows', code: null, codeExpiresAt: null });
    expect(paired.lastConnectedAt).toBe(paired.pairedAt);

    server.clock.advance(60_000);
    expect((await whoami(token)).status).toBe(200);
    const later = await view(alice);
    expect(later.pairedAt).toBe(paired.pairedAt);
    expect(Date.parse(later.lastConnectedAt ?? '')).toBeGreaterThan(Date.parse(paired.pairedAt ?? ''));
  });

  it('pairs per 应用账号: one colleague\'s 配对码 never reaches another\'s account', async () => {
    const bob = await server.signIn('bob');
    const bobsCode = codeOf(await issue(bob));
    const aliceToken = await pair(alice);

    expect(ExtensionIdentitySchema.parse(await (await whoami(aliceToken)).json()).accountId).toBe(alice.account.accountId);
    // Alice pairing hers left Bob's outstanding code alone, and redeeming it pairs Bob, never Alice.
    const redeemed = await redeem(bobsCode);
    expect(ExtensionTokenSchema.parse(await redeemed.json()).accountId).toBe(bob.account.accountId);
  });
});

describe('扩展配对 at the address colleagues reach the app at', () => {
  // Phase 1 (docs/design/browser-extension-v1.md): the exact-origin guard of #251 is live, and the extension is the
  // one caller that is not the app's own page.
  const INTRANET = 'http://10.250.0.222';
  let intranet: TestServer;
  let cookie: string;

  beforeEach(async () => {
    intranet = await createTestServer({ publicOrigin: INTRANET });
    const setup = await intranet.app.request(`${INTRANET}/api/auth/setup`, { method: 'POST', headers: { ...json, origin: INTRANET }, body: JSON.stringify({ username: 'alice', password: TEST_PASSWORD }) });
    expect(setup.status).toBe(200);
    cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });
  afterEach(() => intranet.close());

  it('admits the extension\'s redemption from its own origin while still refusing every other cross-origin write', async () => {
    const issued = ExtensionPairingSchema.parse(await (await intranet.app.request(`${INTRANET}${PAIRING}/code`, { method: 'POST', headers: { ...json, origin: INTRANET, cookie }, body: '{}' })).json());
    const code = issued.code ?? '';

    const fromExtension = await intranet.app.request(`${INTRANET}${EXTENSION_PAIR_PATH}`, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN }, body: JSON.stringify({ code }) });
    expect(fromExtension.status).toBe(200);

    // The exemption is this one route, not the guard going soft: another origin's write is still refused.
    const write = await intranet.app.request(`${INTRANET}${PAIRING}/revoke`, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN, cookie }, body: '{}' });
    expect(write.status).toBe(403);
    expect(await errorOf(write)).toBe('forbidden_host');

    // And the Host check still covers the redemption: a rebound name reaches it no more than anything else.
    const rebound = await intranet.app.request(`http://evil.example.com${EXTENSION_PAIR_PATH}`, { method: 'POST', headers: { ...json, origin: EXTENSION_ORIGIN }, body: JSON.stringify({ code }) });
    expect(rebound.status).toBe(403);
    expect(await errorOf(rebound)).toBe('forbidden_host');
  });
});
