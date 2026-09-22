import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, TEST_PASSWORD, type TestServer } from '../test/harness';

let server: TestServer;
beforeEach(async () => { server = await createTestServer(); });
afterEach(() => server.close());

const login = (username: string, password: string) => server.app.request('/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
});

describe('self-service password change', () => {
  it.each(['admin', 'member'])('%s changes only their own password and keeps this session', async (role) => {
    const admin = await server.signIn('admin');
    const member = await server.signIn('member');
    const actor = role === 'admin' ? admin : member;
    const other = role === 'admin' ? member : admin;
    const response = await actor.post('/api/auth/change-password', {
      currentPassword: TEST_PASSWORD, newPassword: 'replacement-password', accountId: other.account.accountId,
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('replacement-password');
    expect((await actor.request('/api/tasks')).status).toBe(200);
    expect((await login(actor.account.username, TEST_PASSWORD)).status).toBe(401);
    expect((await login(actor.account.username, 'replacement-password')).status).toBe(200);
    expect((await login(other.account.username, TEST_PASSWORD)).status).toBe(200);
  });

  it('refuses an anonymous request or incorrect current password', async () => {
    const actor = await server.signIn('admin');
    const input = { currentPassword: 'incorrect-password', newPassword: 'replacement-password' };
    expect((await server.app.request('/api/auth/change-password', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })).status).toBe(401);
    const response = await actor.post('/api/auth/change-password', input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'wrong_password' } });
    expect((await login('admin', TEST_PASSWORD)).status).toBe(200);
  });

  it('keeps the old password and sessions when durable recording fails', async () => {
    const actor = await server.signIn('admin');
    await sql`CREATE TRIGGER fail_password_audit BEFORE INSERT ON account_event
      WHEN NEW.action = 'password_changed' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`.execute(server.db);
    const response = await actor.post('/api/auth/change-password', {
      currentPassword: TEST_PASSWORD, newPassword: 'replacement-password',
    });
    expect(response.status).toBe(500);
    expect((await actor.request('/api/tasks')).status).toBe(200);
    expect((await login('admin', TEST_PASSWORD)).status).toBe(200);
    expect((await login('admin', 'replacement-password')).status).toBe(401);
  });
});
