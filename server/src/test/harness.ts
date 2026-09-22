import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountListSchema, SessionSchema, type Account } from '@baox/contract';
import type { Hono } from 'hono';
import type { AppEnv } from '../accounts/http';
import { createApp, type App } from '../app';
import { ensureDataDir } from '../data-dir';
import { openDatabase, type Db } from '../db/database';
import { createInMemoryErpLease, type InMemoryErpLease } from '../erp-lease';
import { parsePublicOrigin } from '../public-origin';
import type { ParseExecutor } from '../parse/executor';
import type { ProjectCatalog } from '../catalog/project-catalog';
import type { ErpConfig } from '../erp/config';
import type { FillExecutor } from '../erp/fill-jobs';
import type { ReconcileExecutor } from '../erp/reconcile-job';
import type { Schedule } from '../extension/channel';

// The primary test seam: the Hono app on SQLite `:memory:`, with a throwaway data directory for blobs.
// The parser job runs in the real parse worker unless a test injects another executor (`createTestServer({ parser })`).
// Every `/api/*` route except the auth ones needs a session: get a signed-in client with `signIn()`.
//
//   const alice = await server.signIn();          // the first call creates the admin; later calls register, approve,
//                                                  // and log users in through the same public account routes
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

// `legacyHome`: a legacy `~/.baox` tree (e.g. @baox/fixtures `LEGACY_BAOX_DIR`) imported when the first admin signs up;
// without it the import finds nothing.
// `erpExecutor`: where 去报销 jobs run (e.g. `erp/testing/fake-executor.ts` `scripted(...)`); `erpConfig`: the ERP and
// build the plan targets (the fake ERP's, when running the real executor on it).
// `reconcileExecutor`: where 对账 jobs run (e.g. `runReconcileJob` on a fake ERP). `database` + `dataDir`: a file
// database and data directory shared with an earlier server, to test a restart (default `:memory:` + a fresh dir).
// `publicOrigin`: the address colleagues reach the app at (e.g. `http://10.250.0.222:8888`); without it only 127.0.0.1 is
// admitted, which is what every test but the deployment ones wants.
// `extensionTemplate`: a built extension template (`extension/scripts/build.mjs <dir>`) for the settings page's download.
// `schedule`: the extension channel's timers (hello deadline, reconnection window); real ones unless a test fires them.
export async function createTestServer({ parser, projectCatalog, legacyHome = null, erpExecutor, reconcileExecutor, erpConfig, publicOrigin, extensionTemplate = null, schedule, database = ':memory:', dataDir = tempDataDir() }: { parser?: ParseExecutor; projectCatalog?: ProjectCatalog; legacyHome?: string | null; erpExecutor?: FillExecutor; reconcileExecutor?: ReconcileExecutor; erpConfig?: ErpConfig; publicOrigin?: string; extensionTemplate?: string | null; schedule?: Schedule; database?: string; dataDir?: string } = {}): Promise<TestServer> {
  const db = await openDatabase(database);
  let offset = 0;
  const clock: TestClock = { now: () => new Date(Date.now() + offset), advance: (ms) => void (offset += ms) };
  const erpLease = createInMemoryErpLease();
  const app = createApp({ db, dataDir, now: clock.now, erpLease, legacyHome, publicOrigin: publicOrigin ? parsePublicOrigin(publicOrigin) : null, extensionTemplate, ...(parser ? { parser } : {}), ...(projectCatalog ? { projectCatalog } : {}), ...(erpExecutor ? { erpExecutor } : {}), ...(reconcileExecutor ? { reconcileExecutor } : {}), ...(erpConfig ? { erpConfig } : {}), ...(schedule ? { schedule } : {}) });
  await app.ready;
  let accounts = 0;
  let administrator: TestClient | null = null;

  const clientFrom = async (response: Response, action: string): Promise<TestClient> => {
    if (response.status !== 200) throw new Error(`${action} failed: ${response.status} ${await response.text()}`);
    const session = SessionSchema.parse(await response.json());
    if (!session.account) throw new Error(`${action}: no account in the session`);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return testClient(app, session.account, cookie);
  };

  async function signIn(username = `user${accounts + 1}`): Promise<TestClient> {
    const status = SessionSchema.parse(await (await app.request('/api/session')).json()).status;
    const credentials = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: TEST_PASSWORD }) };
    if (status === 'setup_required') {
      const client = await clientFrom(await app.request('/api/auth/setup', credentials), `signIn(${username})`);
      administrator = client;
      accounts += 1;
      return client;
    }

    const registered = await app.request('/api/auth/register', credentials);
    if (registered.status !== 200) throw new Error(`signIn(${username}) failed: ${registered.status} ${await registered.text()}`);
    const pending = SessionSchema.parse(await registered.json());
    if (pending.status !== 'signed_out' || pending.account !== null) throw new Error(`signIn(${username}): registration did not stay signed out`);
    if (!administrator) throw new Error(`signIn(${username}): no administrator is available to approve the registration`);
    const listed = await administrator.request('/api/admin/accounts');
    if (listed.status !== 200) throw new Error(`signIn(${username}): listing pending registration failed: ${listed.status} ${await listed.text()}`);
    const account = AccountListSchema.parse(await listed.json()).accounts.find((candidate) => candidate.username === username);
    if (!account || account.approved) throw new Error(`signIn(${username}): pending registration was not listed`);
    const approved = await administrator.post(`/api/admin/accounts/${account.accountId}`, { approved: true });
    if (approved.status !== 200) throw new Error(`signIn(${username}): approval failed: ${approved.status} ${await approved.text()}`);

    const client = await clientFrom(await app.request('/api/auth/login', credentials), `signIn(${username})`);
    accounts += 1;
    return client;
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
