import { SessionSchema } from '@baox/contract';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runCli } from './cli';
import { databasePath } from './data-dir';
import { createTestServer, TEST_PASSWORD, tempDataDir, type TestServer } from './test/harness';

// #228 (spec #246, phase 0): `baox admin emergency-reset <username>`, the emergency way back in for a locked-out
// administrator, replaces the unconditional `baox admin reset-password <username>`. A shell on the host may reset an
// administrator account and nothing else; a colleague's password is reset by an administrator in the web UI
// (ADR-0018). The command runs against the data directory's database file while the server may be running, prints a
// temporary password that must be changed at next login, and writes an audit record.

let server: TestServer;
let dataDir: string;
beforeEach(async () => {
  dataDir = tempDataDir();
  server = await createTestServer({ database: databasePath(dataDir), dataDir });
});
afterEach(() => server.close());

const login = (username: string, password: string) =>
  server.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { dataDir, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const events = (accountId: string) => server.db.selectFrom('account_event').selectAll().where('account_id', '=', accountId).execute();

it('resets a locked-out administrator to a printed temporary password that must be changed at next login', async () => {
  const admin = await server.signIn('admin');

  const result = await cli('admin', 'emergency-reset', 'admin');
  expect(result.code).toBe(0);
  const temporary = /临时密码：(\S+)/.exec(result.out)?.[1];
  expect(temporary).toBeTruthy();

  expect((await login('admin', TEST_PASSWORD)).status).toBe(401);
  const signedIn = await login('admin', temporary as string);
  expect(signedIn.status).toBe(200);
  expect(SessionSchema.parse(await signedIn.json())).toMatchObject({ status: 'password_change_required', account: { username: 'admin', role: 'admin' } });

  // The reset leaves a trace. Nobody has a session to act from, so the audit record names no actor.
  expect(await events(admin.account.accountId)).toContainEqual(expect.objectContaining({ action: 'cli_reset_password', actor_account_id: null }));
});

it('refuses a target that is not an administrator, and leaves that account untouched', async () => {
  await server.signIn('admin');
  const bob = await server.signIn('bob');

  const result = await cli('admin', 'emergency-reset', 'bob');
  expect(result).toMatchObject({ code: 1, err: expect.stringContaining('bob') });

  const unchanged = await login('bob', TEST_PASSWORD);
  expect(unchanged.status).toBe(200);
  expect(SessionSchema.parse(await unchanged.json())).toMatchObject({ status: 'signed_in' });
  expect(await events(bob.account.accountId)).not.toContainEqual(expect.objectContaining({ action: 'cli_reset_password' }));
});

it('no longer offers the unconditional reset-password command, and refuses an unknown username', async () => {
  await server.signIn('admin');
  const bob = await server.signIn('bob');

  for (const argv of [
    ['admin', 'reset-password', 'bob'],
    ['admin', 'reset-password', 'admin'],
    ['admin', 'frobnicate'],
  ]) {
    expect(await cli(...argv)).toMatchObject({ code: 2, err: expect.not.stringContaining('reset-password') });
  }
  expect((await login('bob', TEST_PASSWORD)).status).toBe(200);
  expect((await login('admin', TEST_PASSWORD)).status).toBe(200);
  expect(await events(bob.account.accountId)).toEqual([expect.objectContaining({ action: 'approved' })]);

  expect(await cli('admin', 'emergency-reset', 'nobody')).toMatchObject({ code: 1, err: expect.stringContaining('nobody') });
});
