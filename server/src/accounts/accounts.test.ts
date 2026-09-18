import { AccountListSchema, SessionSchema, TaskSnapshotSchema } from '@baox/contract';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations';
import { createTestServer, TEST_PASSWORD, type TestServer } from '../test/harness';

// Slice 14a (#193): 应用账号 (app accounts), login and sessions through `app.request()` (ADR-0018).

let server: TestServer;
beforeEach(async () => {
  server = await createTestServer();
});
afterEach(() => server.close());

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

// The `name=value` part of the session cookie a response set.
function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

async function session(cookie?: string) {
  const response = await server.app.request('/api/session', cookie ? { headers: { cookie } } : {});
  expect(response.status).toBe(200);
  return SessionSchema.parse(await response.json());
}

describe('first-admin bootstrap', () => {
  it('with no account the app asks only for the admin; the first account is the admin and is signed in', async () => {
    expect(await session()).toEqual({ status: 'setup_required', account: null });

    const response = await server.app.request('/api/auth/setup', json({ username: 'admin', password: 'correct horse' }));
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Max-Age=2592000/);

    const signedIn = await session(cookieOf(response));
    expect(signedIn).toMatchObject({ status: 'signed_in', account: { username: 'admin', role: 'admin' } });
    expect(await session()).toEqual({ status: 'signed_out', account: null });
  });

  it('refuses a second setup once an admin exists', async () => {
    expect((await server.app.request('/api/auth/setup', json({ username: 'admin', password: 'correct horse' }))).status).toBe(200);
    const again = await server.app.request('/api/auth/setup', json({ username: 'mallory', password: 'correct horse' }));
    expect(again.status).toBe(409);
    expect(again.headers.get('set-cookie')).toBeNull();
  });
});

describe('register, approval, login and logout', () => {
  it('keeps a self-registration pending until an admin explicitly approves it, then audits and permits login', async () => {
    const early = await server.app.request('/api/auth/register', json({ username: 'alice', password: 'correct horse' }));
    expect(early.status).toBe(409);

    const admin = await server.signIn('admin');
    const response = await server.app.request('/api/auth/register', json({ username: 'alice', password: 'correct horse' }));
    expect(response.status).toBe(200);
    expect(SessionSchema.parse(await response.json())).toEqual({ status: 'signed_out', account: null });
    expect((await server.app.request('/api/tasks', { headers: { cookie: cookieOf(response) } })).status).toBe(401);

    const listed = AccountListSchema.parse(await (await admin.request('/api/admin/accounts')).json());
    const pending = listed.accounts.find((account) => account.username === 'alice');
    expect(pending).toMatchObject({ role: 'user', active: true, approved: false, mustChangePassword: false });
    if (!pending) throw new Error('pending registration was not listed');

    const pendingLogin = await server.app.request('/api/auth/login', json({ username: 'alice', password: 'correct horse' }));
    expect(pendingLogin.status).toBe(403);
    expect(await pendingLogin.json()).toMatchObject({ error: { code: 'pending_approval' } });

    // No other administrator operation can turn a pending registration into usable credentials.
    for (const change of [{ active: true }, { role: 'admin' }, { temporaryPassword: 'temporary-1' }]) {
      const blocked = await admin.post(`/api/admin/accounts/${pending.accountId}`, change);
      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toMatchObject({ error: { code: 'approval_required' } });
    }
    expect((await server.app.request('/api/auth/login', json({ username: 'alice', password: 'correct horse' }))).status).toBe(403);

    const approved = await admin.post(`/api/admin/accounts/${pending.accountId}`, { approved: true });
    expect(approved.status).toBe(200);
    expect(AccountListSchema.parse(await approved.json()).accounts.find((account) => account.accountId === pending.accountId)).toMatchObject({ role: 'user', active: true, approved: true, mustChangePassword: false });
    expect(await server.db.selectFrom('account_event').select(['account_id', 'actor_account_id', 'action']).where('account_id', '=', pending.accountId).execute()).toEqual([{ account_id: pending.accountId, actor_account_id: admin.account.accountId, action: 'approved' }]);

    const login = await server.app.request('/api/auth/login', json({ username: 'alice', password: 'correct horse' }));
    expect(login.status).toBe(200);
    expect(await session(cookieOf(login))).toMatchObject({ status: 'signed_in', account: { username: 'alice', role: 'user' } });

    const taken = await server.app.request('/api/auth/register', json({ username: 'alice', password: 'another one' }));
    expect(taken.status).toBe(409);
  });

  it('clears a prior session when that browser submits a registration', async () => {
    const admin = await server.signIn('admin');
    const registered = await server.app.request('/api/auth/register', json({ username: 'alice', password: 'correct horse' }, admin.cookie));
    expect(registered.status).toBe(200);
    expect(SessionSchema.parse(await registered.json())).toEqual({ status: 'signed_out', account: null });
    expect(await session(cookieOf(registered))).toEqual({ status: 'signed_out', account: null });
    expect((await admin.request('/api/tasks')).status).toBe(401);
  });

  it('validates credentials before touching anything', async () => {
    const short = await server.app.request('/api/auth/setup', json({ username: 'admin', password: 'short' }));
    expect(short.status).toBe(400);
    expect((await session()).status).toBe('setup_required');
  });

  it('logs in with the right password only, and logout deletes the session', async () => {
    await server.signIn('admin');
    const wrong = await server.app.request('/api/auth/login', json({ username: 'admin', password: 'wrong password' }));
    expect(wrong.status).toBe(401);
    const unknown = await server.app.request('/api/auth/login', json({ username: 'nobody', password: TEST_PASSWORD }));
    expect(unknown.status).toBe(401);

    const login = await server.app.request('/api/auth/login', json({ username: ' admin ', password: TEST_PASSWORD }));
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    expect((await server.app.request('/api/tasks', { headers: { cookie } })).status).toBe(200);

    const logout = await server.app.request('/api/auth/logout', json({}, cookie));
    expect(SessionSchema.parse(await logout.json())).toEqual({ status: 'signed_out', account: null });
    // The old cookie is dead server-side, not just cleared in the browser.
    expect((await server.app.request('/api/tasks', { headers: { cookie } })).status).toBe(401);
    expect(await session(cookie)).toEqual({ status: 'signed_out', account: null });
  });
});

describe('sessions', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('expires after 30 days without use', async () => {
    const admin = await server.signIn('admin');
    server.clock.advance(30 * DAY + 1000);
    expect((await admin.request('/api/tasks')).status).toBe(401);
    expect((await session(admin.cookie)).status).toBe('signed_out');
  });

  it('slides: each use pushes the expiry 30 days out and re-sends the cookie', async () => {
    const admin = await server.signIn('admin');
    server.clock.advance(20 * DAY);
    const used = await admin.request('/api/tasks');
    expect(used.status).toBe(200);
    expect(used.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
    server.clock.advance(20 * DAY);
    expect((await admin.request('/api/tasks')).status).toBe(200);
  });

  it('refuses every non-auth endpoint without a valid session', async () => {
    const admin = await server.signIn('admin');
    const created = await admin.post('/api/tasks', { homeCity: '杭州' });
    const taskId = TaskSnapshotSchema.parse(await created.json()).task.taskId;
    const attempts: Array<[string, RequestInit]> = [
      ['/api/tasks', {}],
      ['/api/tasks', json({ homeCity: '杭州' })],
      [`/api/tasks/${taskId}`, {}],
      [`/api/tasks/${taskId}/events`, {}],
      [`/api/tasks/${taskId}/batches`, { method: 'POST' }],
      [`/api/tasks/${taskId}/actions/start-erp-write`, json({ stepToken: 'x' })],
      ['/api/reset', json({})],
      ['/api/no-such-endpoint', {}],
    ];
    for (const [path, init] of attempts) {
      for (const cookie of [undefined, 'baox_session=forged']) {
        const headers = new Headers(init.headers);
        if (cookie) headers.set('cookie', cookie);
        const response = await server.app.request(path, { ...init, headers });
        expect(response.status, `${init.method ?? 'GET'} ${path} cookie=${cookie}`).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
      }
    }
  });

  it('drops an existing session when its account becomes pending approval', async () => {
    const admin = await server.signIn('admin');
    await server.db.updateTable('account').set({ approved: 0 }).where('account_id', '=', admin.account.accountId).execute();

    expect((await admin.request('/api/tasks')).status).toBe(401);
    expect(await session(admin.cookie)).toEqual({ status: 'signed_out', account: null });
    expect(await server.db.selectFrom('session').select('token_sha256').where('account_id', '=', admin.account.accountId).execute()).toEqual([]);
  });
});

describe('migration 0002_193_accounts', () => {
  async function migrateFrom0001(seed: (db: Kysely<unknown>) => Promise<void>) {
    const db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
    const initialOnly = new Migrator({ db, provider: { getMigrations: async () => ({ '0001_initial': MIGRATIONS['0001_initial']! }) } });
    expect((await initialOnly.migrateToLatest()).error).toBeUndefined();
    await seed(db);
    expect((await new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } }).migrateToLatest()).error).toBeUndefined();
    const rows = await sql<{ account_id: string; username: string | null; active: number; approved: number }>`SELECT account_id, username, active, approved FROM account`.execute(db);
    await db.destroy();
    return rows.rows;
  }

  it('drops the implicit account when it owns nothing', async () => {
    expect(await migrateFrom0001(async () => {})).toEqual([]);
  });

  it('keeps an implicit account that owns tasks, deactivated and without credentials', async () => {
    const rows = await migrateFrom0001(async (db) => {
      await sql`INSERT INTO task (task_id, account_id, name, home_city, lifecycle, revision, created_at, updated_at)
                VALUES ('t1', 'local', 'x', '杭州', 'open', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`.execute(db);
    });
    expect(rows).toEqual([{ account_id: 'local', username: null, active: 0, approved: 1 }]);
  });
});

describe('migration 0013_222_account_approval', () => {
  it('preserves the active state of existing accounts while authorizing them', async () => {
    const db = new Kysely<unknown>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
    try {
      const beforeApproval = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '0013_222_account_approval'));
      expect((await new Migrator({ db, provider: { getMigrations: async () => beforeApproval } }).migrateToLatest()).error).toBeUndefined();
      await sql`INSERT INTO account (account_id, display_name, created_at, username, password_hash, role, active, must_change_password)
                VALUES ('active-user', 'active-user', '2026-09-01T00:00:00Z', 'active-user', 'hash', 'user', 1, 0),
                       ('inactive-user', 'inactive-user', '2026-09-01T00:00:00Z', 'inactive-user', 'hash', 'user', 0, 0)`.execute(db);

      expect((await new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } }).migrateToLatest()).error).toBeUndefined();
      const rows = await sql<{ username: string; active: number; approved: number }>`SELECT username, active, approved FROM account WHERE username IS NOT NULL ORDER BY username`.execute(db);
      expect(rows.rows).toEqual([
        { username: 'active-user', active: 1, approved: 1 },
        { username: 'inactive-user', active: 0, approved: 1 },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
