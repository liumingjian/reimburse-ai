import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBlob } from './data-dir';
import { api, sample } from './test/api';
import { createTestServer, tempDataDir, TEST_PASSWORD, type TestClient, type TestServer } from './test/harness';
import { PublicOriginRefusal } from './public-origin';
import { startServer } from './server';

// Regressions for the security findings of the #198 review. Each one is a way in that the code allowed before:
// a stored content type that runs as this origin, a page on another domain driving the app through DNS rebinding,
// two setups both becoming admin, and a password change that left the old sessions open.
// The last two describes are the intranet deployment (#251): the same defences, now around a configured address
// instead of 127.0.0.1.

let server: TestServer;
let alice: TestClient;
const json = { 'content-type': 'application/json' };

beforeEach(async () => {
  server = await createTestServer();
});
afterEach(() => server.close());

const setup = (username: string) => server.app.request('/api/auth/setup', { method: 'POST', headers: json, body: JSON.stringify({ username, password: TEST_PASSWORD }) });

describe('an uploaded original is never served as the type the browser claimed', () => {
  beforeEach(async () => {
    alice = await server.signIn('alice');
  });

  it('stores and serves the type its 本地执行器 says, with nosniff', async () => {
    const client = api(() => alice);
    const { task } = await client.createTask();
    // The upload claims `text/html`: served back as that, it would run as this origin for everyone sharing the blob.
    const uploaded = await client.upload(task.taskId, [{ ...sample('m01'), type: 'text/html' }]);
    const stored = uploaded.batches[0]!.files[0]!;
    expect(stored.status).toBe('accepted');

    const response = await alice.request(`/api/tasks/${task.taskId}/files/${stored.contentHash}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('neutralises a dangerous type already stored against the blob', async () => {
    const client = api(() => alice);
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01')]);
    const batchId = uploaded.batches[0]!.batchId;

    // Blobs are shared between accounts and their rows are append-only, so a dangerous type can already be on record
    // from an older upload (the first one to store the bytes wins). The serve side never trusts it either.
    const bytes = new Uint8Array(Buffer.from('<script>alert(1)</script>'));
    const sha = writeBlob(server.dataDir, bytes);
    const at = '2026-01-01T00:00:00Z';
    await server.db.insertInto('blob').values({ sha256: sha, size: bytes.byteLength, mime: 'text/html', created_at: at }).execute();
    await server.db
      .insertInto('material')
      .values({ material_id: randomUUID(), task_id: task.taskId, account_id: alice.account.accountId, batch_id: batchId, blob_sha256: sha, file_name: 'note.html', created_at: at, batch_seq: 9 })
      .execute();

    const response = await alice.request(`/api/tasks/${task.taskId}/files/${sha}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('only this machine may talk to the app', () => {
  it('refuses a request whose Host is another name pointed at this machine (DNS rebinding)', async () => {
    // The attacker's page resolves its own domain to 127.0.0.1; the browser still sends that domain as Host.
    const rebound = await server.app.request('http://evil.example.com/api/session');
    expect(rebound.status).toBe(403);
    expect(((await rebound.json()) as { error: { code: string } }).error.code).toBe('forbidden_host');

    for (const host of ['http://127.0.0.1:4319', 'http://localhost:4319']) {
      expect((await server.app.request(`${host}/api/session`)).status).toBe(200);
    }
  });

  it('refuses a cross-origin write even when Host is local', async () => {
    const body = JSON.stringify({ username: 'mallory', password: TEST_PASSWORD });
    const cross = await server.app.request('http://127.0.0.1:4319/api/auth/setup', { method: 'POST', headers: { ...json, origin: 'http://evil.example.com' }, body });
    expect(cross.status).toBe(403);
    // Nothing was created: the machine still has no admin.
    expect(await server.db.selectFrom('account').select('account_id').execute()).toEqual([]);

    const same = await server.app.request('http://127.0.0.1:4319/api/auth/setup', { method: 'POST', headers: { ...json, origin: 'http://127.0.0.1:4319' }, body });
    expect(same.status).toBe(200);
  });
});

describe('the app served to colleagues at a configured address', () => {
  // Phase 1 (docs/design/browser-extension-v1.md): Caddy on :80 in front of Node, which still binds 127.0.0.1.
  const INTRANET = 'http://10.250.0.222';
  const setupAt = (at: TestServer, origin: string, username: string) =>
    at.app.request(`${origin}/api/auth/setup`, { method: 'POST', headers: { ...json, origin }, body: JSON.stringify({ username, password: TEST_PASSWORD }) });

  let intranet: TestServer;
  beforeEach(async () => {
    intranet = await createTestServer({ publicOrigin: INTRANET });
  });
  afterEach(() => intranet.close());

  it('answers for the configured address and refuses any other name pointed at this machine (DNS rebinding)', async () => {
    expect((await intranet.app.request(`${INTRANET}/api/session`)).status).toBe(200);

    const rebound = await intranet.app.request('http://evil.example.com/api/session');
    expect(rebound.status).toBe(403);
    expect(((await rebound.json()) as { error: { code: string } }).error.code).toBe('forbidden_host');
    // The check is the configured address, not "anything that is not the attacker's": loopback is another address now.
    expect((await intranet.app.request('http://127.0.0.1:4319/api/session')).status).toBe(403);
  });

  it('refuses a cross-origin write even when Host is the configured address', async () => {
    const cross = await intranet.app.request(`${INTRANET}/api/auth/setup`, { method: 'POST', headers: { ...json, origin: 'http://evil.example.com' }, body: JSON.stringify({ username: 'mallory', password: TEST_PASSWORD }) });
    expect(cross.status).toBe(403);
    // Nothing was created: the instance still has no admin.
    expect(await intranet.db.selectFrom('account').select('account_id').execute()).toEqual([]);

    expect((await setupAt(intranet, INTRANET, 'alice')).status).toBe(200);
  });

  it('marks the session cookie Secure under https and leaves it unmarked under http, from the address alone', async () => {
    const overHttp = await setupAt(intranet, INTRANET, 'alice');
    expect(overHttp.status).toBe(200);
    // A Secure cookie sent over plain HTTP is dropped, and nobody on the intranet could stay signed in.
    expect(overHttp.headers.get('set-cookie')).not.toContain('Secure');

    const https = await createTestServer({ publicOrigin: 'https://baox.example.com' });
    try {
      const overHttps = await setupAt(https, 'https://baox.example.com', 'alice');
      expect(overHttps.status).toBe(200);
      expect(overHttps.headers.get('set-cookie')).toContain('Secure');
    } finally {
      await https.close();
    }
  });
});

describe('starting the server at a configured address', () => {
  it('refuses to start when plaintext would reach a public address, and starts for a private one', async () => {
    await expect(startServer({ dataDir: tempDataDir(), port: 0, publicOrigin: 'http://203.0.113.9' })).rejects.toBeInstanceOf(PublicOriginRefusal);

    const intranet = await startServer({ dataDir: tempDataDir(), port: 0, publicOrigin: 'http://10.250.0.222' });
    // Node keeps binding 127.0.0.1; the configured address is where the reverse proxy sends colleagues.
    expect(intranet.url.startsWith('http://127.0.0.1:')).toBe(true);
    await intranet.close();

    // Over https a public address is exactly what a domain deployment looks like.
    const secure = await startServer({ dataDir: tempDataDir(), port: 0, publicOrigin: 'https://baox.example.com' });
    await secure.close();
  });
});

describe('the first admin', () => {
  it('is created once even when two setups race', async () => {
    // scrypt sits between the check and the insert, so both requests used to pass the check and both became admin.
    const [one, two] = await Promise.all([setup('one'), setup('two')]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);

    const accounts = await server.db.selectFrom('account').select(['username', 'role']).where('username', 'is not', null).execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.role).toBe('admin');
    // The loser is told the machine already has its owner, not that the name was taken.
    const loser = one.status === 409 ? one : two;
    expect(((await loser.json()) as { error: { code: string } }).error.code).toBe('setup_done');
  });
});

describe('an admin acting on their own account', () => {
  it('refuses self-demotion and self-deactivation even when another admin exists', async () => {
    const admin = await server.signIn('admin');
    const bob = await server.signIn('bob');
    // With a second admin the last-admin guard no longer fires, so this pins the self-change guard on its own.
    expect((await admin.post(`/api/admin/accounts/${bob.account.accountId}`, { role: 'admin' })).status).toBe(200);

    for (const change of [{ role: 'user' }, { active: false }]) {
      const refused = await admin.post(`/api/admin/accounts/${admin.account.accountId}`, change);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('self_change');
    }
    // Still an admin, still signed in.
    expect((await admin.request('/api/admin/accounts')).status).toBe(200);
    // Another admin may still do it: the guard is about doing it to yourself, not about the change being forbidden.
    expect((await bob.post(`/api/admin/accounts/${admin.account.accountId}`, { role: 'user' })).status).toBe(200);
  });
});

describe('changing the password', () => {
  it('drops the account\'s other sessions and keeps the one that changed it', async () => {
    const first = await server.signIn('alice');
    const second = await server.app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ username: 'alice', password: TEST_PASSWORD }) });
    expect(second.status).toBe(200);
    const cookie = (second.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const changed = await server.app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' }),
    });
    expect(changed.status).toBe(200);

    // Whoever knew the old password holds nothing afterwards.
    expect((await first.request('/api/tasks')).status).toBe(401);
    // The browser that changed it stays signed in.
    expect((await server.app.request('/api/tasks', { headers: { cookie } })).status).toBe(200);
  });
});
