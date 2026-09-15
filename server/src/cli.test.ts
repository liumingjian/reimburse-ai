import { rmSync } from 'node:fs';
import { SessionSchema } from '@baox/contract';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp, type App } from './app';
import { runCli } from './cli';
import { databasePath } from './data-dir';
import { openDatabase, type Db } from './db/database';
import { tempDataDir, TEST_PASSWORD } from './test/harness';

// Slice 14b (#194): `baox admin reset-password <username>`, the local way back in for a locked-out sole admin. It runs
// against the data directory's database file (the server may be running), prints a temporary password that must be
// changed at next login.

let dataDir: string;
let db: Db;
let app: App;
beforeEach(async () => {
  dataDir = tempDataDir();
  db = await openDatabase(databasePath(dataDir));
  app = createApp({ db, dataDir });
});
afterEach(async () => {
  await app.close();
  await db.destroy();
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => Promise.resolve(app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { dataDir, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

it('resets the sole admin password to a printed temporary one that must be changed at next login', async () => {
  expect((await post('/api/auth/setup', { username: 'admin', password: TEST_PASSWORD })).status).toBe(200);

  const result = await cli('admin', 'reset-password', 'admin');
  expect(result.code).toBe(0);
  const temporary = /临时密码：(\S+)/.exec(result.out)?.[1];
  expect(temporary).toBeTruthy();

  expect((await post('/api/auth/login', { username: 'admin', password: TEST_PASSWORD })).status).toBe(401);
  const login = await post('/api/auth/login', { username: 'admin', password: temporary });
  expect(login.status).toBe(200);
  expect(SessionSchema.parse(await login.json())).toMatchObject({ status: 'password_change_required', account: { username: 'admin', role: 'admin' } });
});

it('refuses an unknown username and unknown commands without touching anything', async () => {
  expect((await post('/api/auth/setup', { username: 'admin', password: TEST_PASSWORD })).status).toBe(200);
  expect(await cli('admin', 'reset-password', 'nobody')).toMatchObject({ code: 1, err: expect.stringContaining('nobody') });
  expect((await cli('admin', 'frobnicate')).code).toBe(2);
  expect((await post('/api/auth/login', { username: 'admin', password: TEST_PASSWORD })).status).toBe(200);
});
