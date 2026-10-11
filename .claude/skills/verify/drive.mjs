// The verify skill's driver: boots one throwaway server, drives one scenario in headless Chrome, keeps the evidence,
// tears the server down. Started by `verify.sh run`; on its own: `node .claude/skills/verify/drive.mjs <scenario.mjs>`.
//
// A scenario is a module with `export const fake` (the BAOX_ERP_FAKE mode it needs, or null) and
// `export default async (v) => {...}`, where `v` is the kit below. It throws to fail; `v.step` names what it is doing.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_ENTRY = join(ROOT, 'server/dist/e2e-main.mjs');
const FIXTURES = join(ROOT, 'fixtures/generated');
const EVIDENCE_HOME = process.env['BAOX_VERIFY_HOME'] ?? join(homedir(), '.baox-verify');
const LISTENING = /listening on (http:\/\/\S+)/;
const BOOT_MS = 60_000;
export const PASSWORD = 'verify-password';

const scenarioPath = resolve(process.argv[2] ?? '');
const name = basename(scenarioPath, '.mjs');
const scenario = await import(pathToFileURL(scenarioPath).href);
// `--fake MODE` overrides the scenario's own; `--fake none` runs without a double (CDP executor, no browser).
const override = process.env['VERIFY_FAKE'] || null;
const fake = override === 'none' ? null : (override ?? scenario.fake ?? null);

const out = join(EVIDENCE_HOME, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
mkdirSync(out, { recursive: true });
const transcript = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(join(out, 'transcript.txt'), `${stamped}\n`);
};

// --- the server, ours alone -------------------------------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'baox-verify-'));
let server = null;

async function boot() {
  const env = { ...process.env, BAOX_DATA_DIR: dataDir, BAOX_PORT: '0', BAOX_HOME: join(dataDir, 'no-legacy-baox'), BAOX_ERP_CHROMIUM: 'off', ...(fake ? { BAOX_ERP_FAKE: fake } : {}) };
  server = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(out, 'server.pid'), `${server.pid} ${dataDir}\n`);
  let seen = '';
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not print "listening on" within ${BOOT_MS} ms`)), BOOT_MS);
    const onData = (chunk) => {
      appendFileSync(join(out, 'server.log'), chunk);
      seen += chunk.toString();
      const match = LISTENING.exec(seen);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.once('exit', (code) => reject(new Error(`server exited (${code}) before listening; see server.log`)));
  });
}

async function teardown() {
  if (server && server.exitCode === null) {
    const exited = new Promise((done) => server.once('exit', done));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(out, 'server.pid'), { force: true });
}

// rexec's deadline and an operator's Ctrl-C both end here: never strand the server.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => void teardown().finally(() => process.exit(128 + (signal === 'SIGTERM' ? 15 : 2))));
}

// --- the kit a scenario drives with -------------------------------------------------------------------------------

function kit(page, url) {
  let shots = 0;
  const api = {
    async json(response, what) {
      if (!response.ok()) throw new Error(`${what}: ${response.status()} ${await response.text()}`);
      return response.json();
    },
    get: async (path) => api.json(await page.request.get(path), `GET ${path}`),
    post: async (path, data) => api.json(await page.request.post(path, { data }), `POST ${path}`),
    snapshot: (taskId) => api.get(`/api/tasks/${taskId}`),
    // A task action exactly as the page sends it: the step token of the snapshot it acts on.
    act: (snapshot, action, body = {}) => api.post(`/api/tasks/${snapshot.task.taskId}/actions/${action}`, { ...body, stepToken: snapshot.step.stepToken }),
  };
  const v = {
    page, url, api, expect, fake, out,
    fixture: (file) => join(FIXTURES, file),
    step: async (label, body) => {
      transcript(`step  ${label}`);
      return body();
    },
    note: (text) => transcript(`note  ${text}`),
    async shot(label) {
      shots += 1;
      const file = join(out, `${String(shots).padStart(2, '0')}-${label.replace(/[^\w一-龥-]+/g, '-')}.png`);
      await page.screenshot({ path: file, fullPage: true });
      transcript(`shot  ${basename(file)}`);
    },
    // Writes a task snapshot into the evidence: the server's state, not the screen's.
    async record(label, taskId) {
      const snapshot = await api.snapshot(taskId);
      writeFileSync(join(out, `snapshot-${label}.json`), JSON.stringify(snapshot, null, 2));
      transcript(`state ${label}: stage=${snapshot.stage} step=${snapshot.step.kind} erp=${snapshot.erp?.status}`);
      return snapshot;
    },
    // The first administrator, created through the API: `/api/auth/setup` signs the page's context in.
    signIn: () => api.post('/api/auth/setup', { username: 'admin', password: PASSWORD }),
    // Setup through the API for scenarios whose subject lies after it: hotel invoice + folio (m01, m02) uploaded,
    // 盘点 done, the 住宿 trio gap answered 确认没有, every line on P-2307, 整单确认 confirmed. Ends at choose_action.
    async confirmedTask() {
      const created = await api.post('/api/tasks', { homeCity: '杭州' });
      const taskId = created.task.taskId;
      for (const [file, fileName] of [['m01-hotel-invoice.pdf', '全季酒店_发票.pdf'], ['m02-hotel-folio.pdf', '全季酒店_结账单.pdf']]) {
        await api.json(await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: fileName, mimeType: 'application/pdf', buffer: readFileSync(join(FIXTURES, file)) } } }), `upload ${file}`);
      }
      await api.act(await api.snapshot(taskId), 'start-inventory');
      await expect.poll(async () => (await api.snapshot(taskId)).inventory.status, { timeout: 90_000 }).toBe('done');
      let snapshot = await api.snapshot(taskId);
      for (const item of snapshot.pendingItems) {
        if (item.status !== 'open' || !/^stay_(invoice|folio|screenshot)_missing\./.test(item.itemId)) continue;
        snapshot = await api.post(`/api/tasks/${taskId}/actions/answer-pending`, { itemId: item.itemId, answer: { choice: 'confirm_none' }, stepToken: snapshot.step.stepToken });
      }
      await api.post('/api/project-book/intake', { number: 'P-2307', name: '华东客户交付' });
      const ready = await api.snapshot(taskId);
      const review = await api.act(ready, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, 'P-2307'])) });
      const confirmed = await api.act(review, 'confirm-review', { digest: review.confirmation.digest });
      expect(confirmed).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' } });
      transcript(`setup confirmed task ${taskId} (through the API)`);
      return taskId;
    },
  };
  return v;
}

// --- one run ----------------------------------------------------------------------------------------------------

let verdict = 'FAIL';
let browser = null;
let page = null;
try {
  transcript(`run   ${name}${fake ? ` (BAOX_ERP_FAKE=${fake})` : ''}; evidence ${out}`);
  const url = await boot();
  transcript(`boot  ${url} (data ${dataDir})`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', (error) => transcript(`pageerror ${String(error.message).slice(0, 200)}`));
  page.on('response', (response) => {
    if (response.status() >= 500) transcript(`http  ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await scenario.default(kit(page, url));
  verdict = 'PASS';
} catch (error) {
  transcript(`error ${String(error?.stack ?? error).split('\n').slice(0, 6).join(' | ')}`);
  if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  await teardown();
  transcript(`${verdict} ${name}`);
  publish();
}
process.exitCode = verdict === 'PASS' ? 0 : 1;

// rexec exports only UTF-8 text: the transcript, snapshots and server log go back; screenshots stay in `out`.
function publish() {
  const artifacts = process.env['REXEC_ARTIFACTS'];
  if (!artifacts) return;
  const into = join(artifacts, 'verify', basename(out));
  mkdirSync(into, { recursive: true });
  for (const file of readdirSync(out)) {
    if (/\.(txt|json|log)$/.test(file)) copyFileSync(join(out, file), join(into, file));
  }
  writeFileSync(join(into, 'screenshots.txt'), `${readdirSync(out).filter((file) => file.endsWith('.png')).map((file) => join(out, file)).join('\n')}\n`);
}
