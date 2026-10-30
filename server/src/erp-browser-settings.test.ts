import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

let server: TestServer;
let alice: TestClient;
const path = '/api/erp-browser-settings';
beforeEach(async () => {
  server = await createTestServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

it('defaults to headless and saves independently of credentials, vault and pairing', async () => {
  expect(await (await alice.request(path)).json()).toEqual({ browserMode: 'headless' });
  expect((await alice.post(path, { browserMode: 'headed' })).status).toBe(200);
  expect(await (await alice.request(path)).json()).toEqual({ browserMode: 'headed' });
  expect(await server.db.selectFrom('erp_credential').selectAll().execute()).toEqual([]);
  expect(await server.db.selectFrom('pairing').selectAll().execute()).toEqual([]);
  await alice.post(path, { browserMode: 'headless' });
  expect(await server.db.selectFrom('erp_browser_setting').selectAll().execute()).toEqual([
    { account_id: alice.account.accountId, browser_mode: 'headless' },
  ]);
});

it('isolates accounts and resets only the current account preference', async () => {
  const bob = await server.signIn('bob');
  await alice.post(path, { browserMode: 'headed' });
  expect(await (await bob.request(path)).json()).toEqual({ browserMode: 'headless' });
  await bob.post(path, { browserMode: 'headed' });
  expect((await alice.post('/api/reset', {})).status).toBe(200);
  expect(await (await alice.request(path)).json()).toEqual({ browserMode: 'headless' });
  expect(await (await bob.request(path)).json()).toEqual({ browserMode: 'headed' });
});

it.each([{}, { browserMode: 'visible' }, { browserMode: null }, { browserMode: true }, { browserMode: 'headed', accountId: 'other' }, null, [], 'headed'])('rejects invalid input %j without changing the preference', async (input) => {
  await alice.post(path, { browserMode: 'headed' });
  expect((await alice.post(path, input)).status).toBe(400);
  expect(await (await alice.request(path)).json()).toEqual({ browserMode: 'headed' });
});

it('rejects malformed JSON and requires an authenticated session for reads and writes', async () => {
  expect((await alice.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
  expect((await server.app.request(path)).status).toBe(401);
  expect((await server.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"browserMode":"headed"}' })).status).toBe(401);
});

it('admits reads but rejects writes during maintenance', async () => {
  await server.app.maintenance.admit();
  expect((await alice.request(path)).status).toBe(200);
  expect((await alice.post(path, { browserMode: 'headed' })).status).toBe(503);
  expect(await (await alice.request(path)).json()).toEqual({ browserMode: 'headless' });
});
