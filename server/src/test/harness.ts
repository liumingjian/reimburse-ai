import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSchema, type Account } from '@baox/contract';
import type { Hono } from 'hono';
import type { AppEnv } from '../accounts/http';
import { createApp, type App } from '../app';
import { ensureDataDir } from '../data-dir';
import { openDatabase, type Db } from '../db/database';
import { createInMemoryErpLease, type InMemoryErpLease } from '../erp-lease';
import type { ParseExecutor } from '../parse/executor';

// The primary test seam: the Hono app on SQLite `:memory:`, with a throwaway data directory for blobs.
// The parser job runs in the real parse worker unless a test injects another executor (`createTestServer({ parser })`).
// Every `/api/*` route except the auth ones needs a session: get a signed-in client with `signIn()`.
//
//   const alice = await server.signIn();          // the first call creates the admin, later calls register users
//   const response = await alice.request('/api/tasks');
//   await alice.post('/api/tasks', { homeCity: '杭州' });

export type TestClock = { now: () => Date; advance: (ms: number) => void };

export type TestClient = {
  account: Account;
  // `name=value` of the session cookie, for hand-built requests.
  cookie: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, body: unknown) => Promise<Response>;
};

export type TestServer = {
  app: App;
  db: Db;
  dataDir: string;
  // Drives session expiry; starts at the real time.
  clock: TestClock;
  // The ERP lease the app consults; tests hold it to simulate another task's ERP job.
  erpLease: InMemoryErpLease;
  signIn: (username?: string) => Promise<TestClient>;
  close: () => Promise<void>;
};

export const TEST_PASSWORD = 'test-password';

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baox-test-'));
  ensureDataDir(dir);
  return dir;
}

export function testClient(app: Hono<AppEnv>, account: Account, cookie: string): TestClient {
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    return Promise.resolve(app.request(path, { ...init, headers }));
  };
  return {
    account,
    cookie,
    request,
    post: (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

export async function createTestServer({ parser }: { parser?: ParseExecutor } = {}): Promise<TestServer> {
  const dataDir = tempDataDir();
  const db = await openDatabase(':memory:');
  let offset = 0;
  const clock: TestClock = { now: () => new Date(Date.now() + offset), advance: (ms) => void (offset += ms) };
  const erpLease = createInMemoryErpLease();
  const app = createApp({ db, dataDir, now: clock.now, erpLease, ...(parser ? { parser } : {}) });
  let accounts = 0;

  async function signIn(username = `user${accounts + 1}`): Promise<TestClient> {
    const status = SessionSchema.parse(await (await app.request('/api/session')).json()).status;
    const path = status === 'setup_required' ? '/api/auth/setup' : '/api/auth/register';
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: TEST_PASSWORD }),
    });
    if (response.status !== 200) throw new Error(`signIn(${username}) failed: ${response.status} ${await response.text()}`);
    accounts += 1;
    const session = SessionSchema.parse(await response.json());
    if (!session.account) throw new Error('signIn: no account in the session');
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return testClient(app, session.account, cookie);
  }

  return {
    app,
    db,
    dataDir,
    clock,
    erpLease,
    signIn,
    async close() {
      await app.close();
      await db.destroy();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
