import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect as baseExpect, test as base, type Page } from '@playwright/test';
import { AccountListSchema, SessionSchema, STAY_TRIO_CONFIRM_NONE, stayTrioElementOf, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';

// Every server-project test gets its own built server on its own throwaway data directory and a free port, so
// tests never share tasks or accounts. `baseURL` points at it: `page.goto('/#/tasks')`.
// The e2e-only entry: the same server as dist/main.mjs plus the scripted ERP doubles, built only under
// BAOX_BUILD_E2E=1 so those doubles never ship. Root `pnpm test:e2e` builds it.
const SERVER_ENTRY = fileURLToPath(new URL('../../../server/dist/e2e-main.mjs', import.meta.url));
const LISTENING = /listening on (http:\/\/\S+)/;
// The fixture-backed project catalog (the live ERP query adapter is #191's): P-2307 华东客户交付, P-3312 产品调研.

export type ServerApp = { url: string; dataDir: string };

// `serverEnv`: extra environment for this file's servers, e.g. `test.use({ serverEnv: { BAOX_ERP_FAKE: 'uncertain_save' } })`.
export const test = base.extend<{ serverApp: ServerApp; serverEnv: Record<string, string> }>({
  serverEnv: [{}, { option: true }],
  serverApp: async ({ serverEnv }, use) => {
    if (!existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} is missing; run root pnpm test:e2e (it builds the server)`);
    const dataDir = mkdtempSync(join(tmpdir(), 'baox-e2e-'));
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      // BAOX_HOME points at a directory that does not exist, so first-admin setup never reads the machine's real ~/.baox.
      env: { ...process.env, BAOX_DATA_DIR: dataDir, BAOX_PORT: '0', BAOX_HOME: join(dataDir, 'no-legacy-baox'), BAOX_ERP_CHROMIUM: 'off', ...serverEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = LISTENING.exec(output);
        if (match?.[1]) resolve(match[1]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => reject(new Error(`server exited (${code}) before listening:\n${output}`)));
    });
    await use({ url, dataDir });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  },
  baseURL: async ({ serverApp }, use) => use(serverApp.url),
});

export { expect } from '@playwright/test';

export const E2E_PASSWORD = 'e2e-password';
const administrators = new Map<string, { username: string; password: string }>();

// Signs the page's browser context in without the UI: the first call creates the administrator; later calls submit a
// registration, approve it through that administrator, then log the requested user in. `page.request` shares the
// context's cookie jar, so the next `page.goto` is already signed in.
export async function signIn(page: Page, username = 'admin'): Promise<void> {
  let sessionResponse = await page.request.get('/api/session');
  let session = SessionSchema.parse(await sessionResponse.json());
  const origin = new URL(sessionResponse.url()).origin;
  if (session.status === 'signed_in' || session.status === 'password_change_required') {
    const logout = await page.request.post('/api/auth/logout');
    if (!logout.ok()) throw new Error(`signIn(${username}) could not clear the existing session: ${logout.status()} ${await logout.text()}`);
    sessionResponse = await page.request.get('/api/session');
    session = SessionSchema.parse(await sessionResponse.json());
  }

  if (session.status === 'setup_required') {
    const setup = await page.request.post('/api/auth/setup', { data: { username, password: E2E_PASSWORD } });
    if (!setup.ok()) throw new Error(`signIn(${username}) setup failed: ${setup.status()} ${await setup.text()}`);
    administrators.set(origin, { username, password: E2E_PASSWORD });
    return;
  }

  const registered = await page.request.post('/api/auth/register', { data: { username, password: E2E_PASSWORD } });
  if (!registered.ok()) throw new Error(`signIn(${username}) registration failed: ${registered.status()} ${await registered.text()}`);
  if (SessionSchema.parse(await registered.json()).status !== 'signed_out') throw new Error(`signIn(${username}) registration unexpectedly created a session`);
  const administrator = administrators.get(origin);
  if (!administrator) throw new Error(`signIn(${username}) has no administrator credentials for ${origin}`);
  const adminLogin = await page.request.post('/api/auth/login', { data: administrator });
  if (!adminLogin.ok()) throw new Error(`signIn(${username}) administrator login failed: ${adminLogin.status()} ${await adminLogin.text()}`);
  const listed = await page.request.get('/api/admin/accounts');
  if (!listed.ok()) throw new Error(`signIn(${username}) account listing failed: ${listed.status()} ${await listed.text()}`);
  const account = AccountListSchema.parse(await listed.json()).accounts.find((candidate) => candidate.username === username);
  if (!account || account.approved) throw new Error(`signIn(${username}) pending registration was not listed`);
  const approved = await page.request.post(`/api/admin/accounts/${account.accountId}`, { data: { approved: true } });
  if (!approved.ok()) throw new Error(`signIn(${username}) approval failed: ${approved.status()} ${await approved.text()}`);
  const logout = await page.request.post('/api/auth/logout');
  if (!logout.ok()) throw new Error(`signIn(${username}) administrator logout failed: ${logout.status()} ${await logout.text()}`);
  const login = await page.request.post('/api/auth/login', { data: { username, password: E2E_PASSWORD } });
  if (!login.ok()) throw new Error(`signIn(${username}) login failed: ${login.status()} ${await login.text()}`);
}

// The 住宿 (accommodation) trio check (#213) runs at 盘点 (inventory): a 住宿 invoice missing its 结账单 (hotel folio)
// or its 支付截图 (payment screenshot) gets one 待确认项 (pending item) per missing element, and the task waits at
// `answer_pending` until they are answered. A spec whose subject lies further down the flow uploads the invoice
// without those two, so it calls this to answer every open trio item with 确认没有 (confirm none) and move on; the
// check itself is covered by server/src/stay-trio.test.ts and, on the page, by hotel.spec.ts.
// Waits for the inventory run to finish first, so every item is derived. Returns the snapshot after the last answer.
export async function answerStayGaps(page: Page, taskId: string): Promise<TaskSnapshot> {
  const read = async (): Promise<TaskSnapshot> => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await baseExpect.poll(async () => (await read()).inventory.status, { timeout: 60_000 }).toBe('done');
  let snapshot = await read();
  for (const item of snapshot.pendingItems) {
    if (item.status !== 'open' || stayTrioElementOf(item.itemId) === null) continue;
    const answered = await page.request.post(`/api/tasks/${taskId}/actions/answer-pending`, {
      data: { itemId: item.itemId, answer: { choice: STAY_TRIO_CONFIRM_NONE }, stepToken: snapshot.step.stepToken },
    });
    if (!answered.ok()) throw new Error(`answer-pending ${item.itemId} failed: ${answered.status()} ${await answered.text()}`);
    snapshot = TaskSnapshotSchema.parse(await answered.json());
  }
  return snapshot;
}
