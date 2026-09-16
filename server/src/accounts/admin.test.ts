import { AccountListSchema, SessionSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, TEST_PASSWORD, type TestClient, type TestServer } from '../test/harness';

// Slice 14b (#194): 管理员 (admin) powers over app accounts through `app.request()` (ADR-0018): promote and demote with
// at least one admin always left, deactivate (never delete), and temporary passwords that must be changed.

let server: TestServer;
let admin: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  admin = await server.signIn('admin');
});
afterEach(() => server.close());

async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

const update = (client: TestClient, accountId: string, change: unknown) => client.post(`/api/admin/accounts/${accountId}`, change);

describe('promote and demote', () => {
  it('refuses to demote the last admin; once another admin exists only that other admin may do it', async () => {
    await refused(await update(admin, admin.account.accountId, { role: 'user' }), 400, 'last_admin');

    const bob = await server.signIn('bob');
    const promoted = await update(admin, bob.account.accountId, { role: 'admin' });
    expect(promoted.status).toBe(200);
    expect(AccountListSchema.parse(await promoted.json()).accounts.find((a) => a.username === 'bob')).toMatchObject({ role: 'admin', active: true });

    // Even with a colleague around, giving up your own admin rights is refused: another admin does it for you.
    await refused(await update(admin, admin.account.accountId, { role: 'user' }), 400, 'self_change');
    expect((await update(bob, admin.account.accountId, { role: 'user' })).status).toBe(200);
    // The demoted account loses admin powers on its very next request.
    await refused(await admin.request('/api/admin/accounts'), 403, 'forbidden');
    await refused(await update(bob, bob.account.accountId, { role: 'user' }), 400, 'last_admin');
  });

  it('only an admin may manage accounts', async () => {
    const bob = await server.signIn('bob');
    await refused(await bob.request('/api/admin/accounts'), 403, 'forbidden');
    await refused(await update(bob, bob.account.accountId, { role: 'admin' }), 403, 'forbidden');
    await refused(await update(admin, 'no-such-account', { role: 'admin' }), 404, 'account_not_found');
  });
});

describe('deactivate, never delete', () => {
  it('a deactivated account is signed out and cannot log in; its tasks stay; reactivation restores it', async () => {
    const bob = await server.signIn('bob');
    const created = await bob.post('/api/tasks', { homeCity: '杭州' });
    expect(created.status).toBe(200);

    const listed = AccountListSchema.parse(await (await update(admin, bob.account.accountId, { active: false })).json());
    expect(listed.accounts.find((a) => a.username === 'bob')).toMatchObject({ active: false, role: 'user' });
    await refused(await bob.request('/api/tasks'), 401, 'unauthenticated');
    await refused(await login('bob', TEST_PASSWORD), 401, 'invalid_credentials');

    expect((await update(admin, bob.account.accountId, { active: true })).status).toBe(200);
    const again = await login('bob', TEST_PASSWORD);
    expect(again.status).toBe(200);
    const tasks = (await (await server.app.request('/api/tasks', { headers: { cookie: cookieOf(again) } })).json()) as { tasks: unknown[] };
    expect(tasks.tasks).toHaveLength(1);
  });

  it('refuses to deactivate the last active admin', async () => {
    await refused(await update(admin, admin.account.accountId, { active: false }), 400, 'last_admin');
  });
});

describe('temporary password', () => {
  it('an admin-set temporary password signs the user out and must be changed at next login', async () => {
    const bob = await server.signIn('bob');
    expect((await update(admin, bob.account.accountId, { temporaryPassword: 'temporary-1' })).status).toBe(200);
    await refused(await bob.request('/api/tasks'), 401, 'unauthenticated');
    await refused(await login('bob', TEST_PASSWORD), 401, 'invalid_credentials');

    const response = await login('bob', 'temporary-1');
    expect(response.status).toBe(200);
    expect(SessionSchema.parse(await response.json())).toMatchObject({ status: 'password_change_required', account: { username: 'bob' } });
    const cookie = cookieOf(response);
    const as = (path: string, init: RequestInit = {}) => server.app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
    await refused(await as('/api/tasks'), 403, 'password_change_required');
    expect(SessionSchema.parse(await (await as('/api/session')).json()).status).toBe('password_change_required');

    const change = (body: unknown) => as('/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await refused(await change({ currentPassword: 'wrong-one', newPassword: 'my-own-password' }), 400, 'wrong_password');
    const changed = await change({ currentPassword: 'temporary-1', newPassword: 'my-own-password' });
    expect(changed.status).toBe(200);
    expect(SessionSchema.parse(await changed.json()).status).toBe('signed_in');
    expect((await as('/api/tasks')).status).toBe(200);
    expect(SessionSchema.parse(await (await login('bob', 'my-own-password')).json()).status).toBe('signed_in');
  });
});

function cookieOf(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function login(username: string, password: string): Promise<Response> {
  return Promise.resolve(server.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }));
}
