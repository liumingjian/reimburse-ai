// The real app for the real-browser harness (#259): the server, started the way production starts it, on an ephemeral
// port, with the extension its employees download from it. Where `fakeBaox` (harness.ts) stands in for the app, this
// IS the app: its origin guard, its pairing, its judge of every read-back and its attempt discipline.
//
// It runs `server/src/main.ts` — the production entry, which wires no executor, so every ERP job goes to the paired
// 浏览器扩展 — in a child process, as `web/e2e/server/fixture.ts` runs its server, rather than importing
// `startServer`: `@baox/server` already depends on this package, and a child keeps the dependency one-way.
//
// The origin guard compares the origin as a literal string (#251), so the port is chosen first and the server is
// told its public origin `http://127.0.0.1:<port>` before it listens: the extension it hands out is stamped with
// exactly the string the guard and the WebSocket Host check admit.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountListSchema, EXTENSION_DOWNLOAD_PATH, ExtensionPairingSchema, HTTP_ENDPOINTS, STAY_TRIO_CONFIRM_NONE,
  stayTrioElementOf, TaskSnapshotSchema, type TaskSnapshot,
} from '@baox/contract';
import { test as base } from '@playwright/test';
import { buildExtensionTemplate, launchWithExtension, PAGE, pair, serveErpSites, type ErpSites, type Launched } from './harness';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const LISTENING = /listening on (http:\/\/\S+)/;
const PASSWORD = 'harness-password';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

/** One signed-in 应用账号 (app account), speaking to the app as its browser would: its cookie, and its origin on writes. */
export type Client = {
  request(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
};

export type App = Awaited<ReturnType<typeof startApp>>;

/** The server on a free port, ERP jobs pointed at `erpOrigin`, compatibility pinned to the served fake ERP. */
export async function startApp({ erpOrigin }: { erpOrigin: string }) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'baox-harness-app-'));
  // The template the download is stamped from (`run.ts` serves `extension/dist`); built before the first download.
  buildExtensionTemplate();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repoRoot, 'server'),
    env: {
      ...process.env,
      BAOX_DATA_DIR: dataDir, BAOX_PORT: String(port), BAOX_PUBLIC_ORIGIN: origin,
      // A directory that does not exist, so first-admin setup never reads the machine's real ~/.baox.
      BAOX_HOME: join(dataDir, 'no-legacy-baox'),
      BAOX_ERP_ORIGIN: erpOrigin, BAOX_ERP_BUILD: PAGE.erpBuild, BAOX_ERP_FORM_ID: PAGE.formId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (LISTENING.test(output)) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited (${code}) before listening:\n${output}`)));
  });

  const clientFor = (cookie: string): Client => {
    const request = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      if (init.method && init.method !== 'GET') headers.set('origin', origin);
      return fetch(`${origin}${path}`, { ...init, headers });
    };
    return { request, post: (path, body = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
  };
  const signedIn = async (path: string, username: string): Promise<Client> => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username, password: PASSWORD }),
    });
    if (response.status !== 200) throw new Error(`${path} for ${username}: ${response.status} ${await response.text()}`);
    return clientFor((response.headers.get('set-cookie') ?? '').split(';')[0] ?? '');
  };
  const ok = async (response: Response): Promise<Response> => {
    if (response.status !== 200) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
    return response;
  };

  return {
    origin,

    /**
     * An employee's 应用账号, set up the way one is: the first account becomes the administrator, the employee
     * registers, the administrator approves the registration, and the employee signs in.
     */
    async employee(username = 'employee'): Promise<Client> {
      const admin = await signedIn('/api/auth/setup', 'admin');
      await ok(await fetch(`${origin}/api/auth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username, password: PASSWORD }),
      }));
      const pending = AccountListSchema.parse(await (await ok(await admin.request('/api/admin/accounts'))).json()).accounts.find((account) => account.username === username);
      if (!pending) throw new Error(`${username}'s registration is not listed`);
      await ok(await admin.post(`/api/admin/accounts/${pending.accountId}`, { approved: true }));
      return signedIn('/api/auth/login', username);
    },

    /** The extension as the settings page hands it out: the zip from `GET /api/extension/download`, unpacked. */
    async downloadExtension(client: Client): Promise<{ dir: string; remove(): void }> {
      const bytes = new Uint8Array(await (await ok(await client.request(EXTENSION_DOWNLOAD_PATH))).arrayBuffer());
      const dir = mkdtempSync(join(tmpdir(), 'baox-extension-download-'));
      writeFileSync(join(dir, 'extension.zip'), bytes);
      const unzipped = spawnSync('unzip', ['-q', 'extension.zip', '-d', 'extension'], { cwd: dir, encoding: 'utf8' });
      if (unzipped.status !== 0) throw new Error(`unzip failed: ${unzipped.stderr}`);
      const unpacked = join(dir, 'extension');
      const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8')) as { host_permissions?: unknown };
      if (JSON.stringify(manifest.host_permissions) !== JSON.stringify([`${origin}/*`])) {
        throw new Error(`the downloaded extension carries host_permissions ${JSON.stringify(manifest.host_permissions)}, not ${origin}/*`);
      }
      return { dir: unpacked, remove: () => rmSync(dir, { recursive: true, force: true }) };
    },

    /** A fresh 配对码 (pairing code), as the settings page's 生成配对码 issues it. */
    async pairingCode(client: Client): Promise<string> {
      const issued = ExtensionPairingSchema.parse(await (await ok(await client.post(HTTP_ENDPOINTS.createExtensionPairingCode.path))).json());
      if (!issued.code) throw new Error('no 配对码 was issued');
      return issued.code;
    },

    /** Resolves once the account's paired extension holds its channel open, as the settings page shows it. */
    async connected(client: Client, timeoutMs = 15_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!ExtensionPairingSchema.parse(await (await ok(await client.request(HTTP_ENDPOINTS.getExtensionPairing.path))).json()).connected) {
        if (Date.now() > deadline) throw new Error('the paired extension never connected');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },

    async snapshot(client: Client, taskId: string): Promise<TaskSnapshot> {
      return TaskSnapshotSchema.parse(await (await ok(await client.request(`/api/tasks/${taskId}`))).json());
    },

    /** One task action, answered with the new snapshot. */
    async act(client: Client, snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<TaskSnapshot> {
      const response = await client.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { ...body, stepToken: snapshot.step.stepToken });
      return TaskSnapshotSchema.parse(await (await ok(response)).json());
    },

    /** Polls the task until `done` holds of it. */
    async until(client: Client, taskId: string, done: (snapshot: TaskSnapshot) => boolean, timeoutMs: number): Promise<TaskSnapshot> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const snapshot = await this.snapshot(client, taskId);
        if (done(snapshot)) return snapshot;
        if (Date.now() > deadline) throw new Error(`task ${taskId} still stage ${snapshot.stage}, ERP ${snapshot.erp.status} after ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },

    /**
     * A task confirmed and ready for 去报销: the given originals uploaded and parsed, every line on `project`, the
     * 住宿 (hotel) trio's open questions answered 确认没有, the review confirmed.
     */
    async confirmedTask(client: Client, { files, project, purpose }: { files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }>; project: { number: string; name: string }; purpose: string }): Promise<TaskSnapshot> {
      await ok(await client.post('/api/project-book/intake', project));
      let snapshot = TaskSnapshotSchema.parse(await (await ok(await client.post('/api/tasks', { homeCity: '杭州' }))).json());
      const form = new FormData();
      for (const file of files) form.append('files', new File([file.bytes], file.name, { type: 'application/pdf' }));
      snapshot = TaskSnapshotSchema.parse(await (await ok(await client.request(`/api/tasks/${snapshot.task.taskId}/batches`, { method: 'POST', body: form }))).json());
      snapshot = await this.act(client, snapshot, 'start-inventory');
      snapshot = await this.until(client, snapshot.task.taskId, (s) => s.inventory.status === 'done', 120_000);
      for (const item of snapshot.pendingItems) {
        if (item.status !== 'open' || stayTrioElementOf(item.itemId) === null) continue;
        snapshot = await this.act(client, snapshot, 'answer-pending', { itemId: item.itemId, answer: { choice: STAY_TRIO_CONFIRM_NONE } });
      }
      snapshot = await this.act(client, snapshot, 'submit-project-assignment', { purpose, projects: Object.fromEntries(snapshot.lines.map((line) => [line.lineId, project.number])) });
      return this.act(client, snapshot, 'confirm-review', { digest: snapshot.confirmation.digest });
    },

    /** 去报销, and the task once its ERP job has ended (the same rule as the server's own remote-executor tests). */
    async goReimburse(client: Client, snapshot: TaskSnapshot, timeoutMs = 180_000): Promise<TaskSnapshot> {
      await this.act(client, snapshot, 'start-erp-write');
      return this.until(client, snapshot.task.taskId, jobEnded, timeoutMs);
    },

    close: async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** No ERP job of the task runs any more. */
export const jobEnded = (snapshot: TaskSnapshot) =>
  (snapshot.erp.status !== 'running' && snapshot.step.kind !== 'none') || (snapshot.stage !== 'erp' && snapshot.stage !== 'reconcile');

/**
 * The harness on the real app: `erp` (the served fake ERP), `app` (the server), `employee` (an approved 应用账号,
 * signed in) and `extension` (Chromium with the extension the employee downloaded, paired through its popup with a
 * 配对码 the employee issued, its channel open).
 */
export const test = base.extend<{ erp: ErpSites; app: App; employee: Client; extension: Launched }>({
  erp: async ({}, use) => {
    const sites = await serveErpSites();
    await use(sites);
    await sites.close();
  },
  app: async ({ erp }, use) => {
    const app = await startApp({ erpOrigin: erp.erpOrigin });
    await use(app);
    await app.close();
  },
  employee: async ({ app }, use) => use(await app.employee()),
  extension: async ({ app, employee }, use) => {
    const downloaded = await app.downloadExtension(employee);
    const launched = await launchWithExtension(downloaded.dir);
    await pair(launched.context, launched.extensionId, await app.pairingCode(employee), () => app.connected(employee));
    await use(launched);
    await launched.context.close();
    downloaded.remove();
  },
});
