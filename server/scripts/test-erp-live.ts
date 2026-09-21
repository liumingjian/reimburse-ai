// `pnpm test:erp-live`: one real ERP draft from a desensitised sample, through the whole app, judged by the strict
// read-back (ticket #191, AC 4). It settles what the fake ERP can only assume: the compatibility fingerprint, whether
// ERP links 收票单号 on the detail rows after the fill, and how many detail rows a new form brings.
//
// It needs the user at the machine and a dedicated ERP test identity, so it refuses to start unless:
//   BAOX_ERP_LIVE=1
//   BAOX_ERP_TEST_ACCOUNT, BAOX_ERP_TEST_TENANT  the dedicated test identity (ERP account + 账套); the run stops before
//                                                any write when the logged-in ERP identity is anyone else
//   BAOX_ERP_TEST_PASSWORD                       optional; when set the harness fills the ERP login form itself so a
//                                                run needs nobody at the machine. Development only: the product never
//                                                fills ERP credentials (ADR-0016), the employee logs in and thereby
//                                                authorises ERP. Empty falls back to waiting for a human to log in.
//   BAOX_ERP_LIVE_SAMPLE                         a directory with sample.json:
//                                                { "homeCity": "合肥", "purpose": "…", "project": "<项目号>", "files": ["a.pdf"] }
//
// `--probe-only` logs in, prints the ERP identity (this is how you read 账套 the first time) and exits. It builds no
// task, starts no app and writes nothing, so it needs neither BAOX_ERP_LIVE nor a sample.
//
// `--probe-toolbar` goes one step further and still costs nothing: it opens one fresh 费用报销单-新增, reveals the
// 收票信息 section and prints every visible control on every toolbar, with its id. It uploads nothing, imports nothing
// and saves nothing, so no invoice is consumed and no 收票占用 is created (ADR-0025 puts that boundary at the
// 发票导入单据 click, which this never reaches). It exists because nothing in the repo has ever touched a delete
// control on the 收票网格 — `steps.ts` knows only tbReceiveInv / tbNotFillEntry / tbNewList — and ADR-0026 unbanned
// 「删除发票」 for human use while leaving what it actually does unverified. Knowing the control's id is the first
// thing any later experiment needs, and this is the only part of that experiment that is free.
//
// Optional: BAOX_ERP_ORIGIN / BAOX_ERP_BUILD / BAOX_ERP_FORM_ID (erp/config.ts), BAOX_CHROMIUM_CDP_PORT (9333),
// BAOX_ERP_LIVE_PROFILE (dedicated Chromium profile, default ~/.baox-erp-live/chromium-profile), BAOX_EGO_TASK_SPACE.
//
// Headed: the ERP runs in the dedicated Chromium window (it is the executor's browser), and the app page opens in the
// ego-browser task space so the run can be watched. The app runs on a throwaway data directory; it never reads or
// writes ~/.baox or ~/.baox-app. The app only ever saves a draft: this script never submits, approves or deletes, and
// calls no reconcile or hand-off action.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

function refuse(message: string): never {
  console.error(`test:erp-live refused: ${message}`);
  process.exit(2);
}

const env = process.env;
const probeOnly = process.argv.includes('--probe-only');
const probeToolbar = process.argv.includes('--probe-toolbar');
// Both probes are read-only, so they are exempt from the same guards: neither builds a task nor reaches a mutation.
const readOnly = probeOnly || probeToolbar;
if (!readOnly && env['BAOX_ERP_LIVE'] !== '1') refuse('set BAOX_ERP_LIVE=1 to run against the real ERP (it saves a real draft).');
const account = env['BAOX_ERP_TEST_ACCOUNT']?.trim();
const tenant = env['BAOX_ERP_TEST_TENANT']?.trim();
const password = env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
if (!account) refuse('set BAOX_ERP_TEST_ACCOUNT to the dedicated ERP test account.');
if (!tenant && !readOnly) refuse('set BAOX_ERP_TEST_TENANT to the dedicated 账套; `--probe-only` prints it off a logged-in session.');
const sampleDir = env['BAOX_ERP_LIVE_SAMPLE']?.trim();
if (!readOnly && (!sampleDir || !existsSync(join(sampleDir, 'sample.json')))) refuse('set BAOX_ERP_LIVE_SAMPLE to a directory holding sample.json and the desensitised invoices.');

type Sample = { homeCity: string; purpose: string; project: string; files: string[] };
const sample: Sample = readOnly ? { homeCity: '', purpose: '', project: '', files: [] } : (JSON.parse(readFileSync(join(sampleDir!, 'sample.json'), 'utf8')) as Sample);
if (!readOnly && (!sample.homeCity || !sample.purpose || !sample.project || !Array.isArray(sample.files) || sample.files.length === 0)) refuse('sample.json needs homeCity, purpose, project and files.');

// Only now load the app: a refused run touches nothing.
const { TaskSnapshotSchema } = await import('@baox/contract');
const { databasePath } = await import('../src/data-dir');
const { openDatabase } = await import('../src/db/database');
const { cdpFillExecutor } = await import('../src/erp/cdp-executor');
const { erpConfigFromEnv } = await import('../src/erp/config');
const { cdpBrowser, ensureChromium } = await import('@baox/erp-executor/browser');
const { cdpPortOf, evaluateChromiumPage } = await import('@baox/erp-executor/chromium');
const { erpEntryOf, probeIdentity, sameOrigin } = await import('@baox/erp-executor/probe');
const { showSection } = await import('@baox/erp-executor/erpform');
const { DEFAULT_PACE } = await import('@baox/erp-executor/pace');
const { openNewReimbursement } = await import('@baox/erp-executor/steps');
const { startServer } = await import('../src/server');

type Snapshot = ReturnType<typeof TaskSnapshotSchema.parse>;

const erpConfig = erpConfigFromEnv(env);
const cdpPort = cdpPortOf(env);
const dataDir = mkdtempSync(join(tmpdir(), 'baox-erp-live-'));
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const ask = createInterface({ input: process.stdin, output: process.stdout });
const say = (line: string) => console.log(`[erp-live] ${line}`);

// 1. The dedicated Chromium, headed, on its own persistent profile. The session lives in that profile, so a second run
// usually finds it already logged in and types nothing.
await ensureChromium({ port: cdpPort, profileDir: env['BAOX_ERP_LIVE_PROFILE'] || join(homedir(), '.baox-erp-live', 'chromium-profile'), openUrl: erpEntryOf(erpConfig.origin), env });
const browser = cdpBrowser(cdpPort);
const probeNow = () => probeIdentity({ origin: erpConfig.origin, waitMs: 30_000, transport: 'chromium-cdp', listTabs: () => browser.listPages(), evaluate: (page, expression) => evaluateChromiumPage(page as never, expression) });

let probe = await probeNow();
if (probe.status !== 'matched') {
  if (password) probe = await signIn();
  else {
    await ask.question(`[erp-live] In the dedicated Chromium window, log in to ${erpConfig.origin} as ${account}${tenant ? ` (账套 ${tenant})` : ''}, then press Enter. `);
    probe = await probeNow();
  }
}
if (probe.status !== 'matched' || !probe.identity) refuse(`no logged-in ERP session (${probe.status}: ${probe.hint ?? ''}). Nothing was written.`);
if (probeOnly) {
  say(`ERP identity: 显示名 ${probe.identity.displayName} / 账号 ${probe.identity.account} / 账套 ${probe.identity.tenant}`);
  say(`put this in .env:  export BAOX_ERP_TEST_TENANT='${probe.identity.tenant}'`);
  process.exit(0);
}
if (probeToolbar) {
  // One fresh form, the 收票信息 section revealed, every toolbar read out. Nothing is clicked beyond the menu path
  // that opens the form, so this run ends with an unsaved 新增单 and no ERP-side trace.
  const session = await browser.attach(probe.page as never);
  const write = { session, pace: DEFAULT_PACE };
  await openNewReimbursement(write as never);
  const section = await showSection(session as never, '收票信息', { settleMs: DEFAULT_PACE.settleMs });
  if (!section.ok) refuse(`收票信息 section did not open: ${section.reason}. Nothing was written.`);
  const bars = await evaluateChromiumPage(probe.page as never, `(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return JSON.stringify([...document.querySelectorAll('[id*="ENTRYBAR"]')].filter(vis).map((bar) => ({
      barId: bar.id,
      items: [...bar.querySelectorAll('a[id], span[id], button[id]')].filter(vis)
        .map((el) => ({ id: el.id, text: (el.innerText || '').trim().slice(0, 40) }))
        .filter((item) => item.text),
    })));
  })()` as never) as unknown as string;
  say('toolbars on a fresh 费用报销单-新增 (read-only; nothing uploaded, imported or saved):');
  console.log(JSON.stringify(JSON.parse(bars), null, 2));
  say('the form is an unsaved 新增单; close the tab and it leaves no trace.');
  process.exit(0);
}
if (probe.identity.account !== account || probe.identity.tenant !== tenant) refuse(`the logged-in ERP identity is ${probe.identity.account} / ${probe.identity.tenant}, not the dedicated test identity. Nothing was written.`);
say(`ERP identity ${probe.identity.displayName} (${account}, 账套 ${tenant}) confirmed.`);

// 2. The app on a throwaway data directory, with the real executor. (Project numbers are checked by the job itself.)
const server = await startServer({ dataDir, port: 0, webDist: existsSync(webDist) ? webDist : null, legacyHome: null, erpExecutor: cdpFillExecutor({ dataDir, env }), erpConfig });
say(`app on ${server.url} (data ${dataDir})`);
let cookie = '';
const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${server.url}${path}`, { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';
  return { status: response.status, body: await response.json().catch(() => null) };
};
const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const snapshotOf = (body: unknown): Snapshot => TaskSnapshotSchema.parse(body);
const act = async (snapshot: Snapshot, name: string, body: Record<string, unknown> = {}): Promise<Snapshot> => {
  const answer = await post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { ...body, stepToken: snapshot.step.stepToken });
  if (answer.status !== 200) throw new Error(`${name}: HTTP ${answer.status} ${JSON.stringify(answer.body?.error ?? answer.body)}`);
  return snapshotOf(answer.body);
};
const until = async (taskId: string, done: (snapshot: Snapshot) => boolean, timeoutMs = 15 * 60_000): Promise<Snapshot> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = snapshotOf((await call(`/api/tasks/${taskId}`)).body);
    if (done(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`timed out at stage ${snapshot.stage}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

let exitCode = 1;
try {
  if ((await post('/api/auth/setup', { username: 'erp-live', password: `erp-live-${Date.now()}` })).status !== 200) throw new Error('could not create the app admin');
  await openInEgo(`${server.url}/#/tasks`);
  const intake = await post('/api/project-book/intake', { number: sample.project });
  if (intake.body?.status !== 'admitted') throw new Error(`project ${sample.project} was not admitted by the live catalog: ${JSON.stringify(intake.body)}`);

  let task = snapshotOf((await post('/api/tasks', { homeCity: sample.homeCity })).body);
  const form = new FormData();
  for (const file of sample.files) form.append('files', new File([readFileSync(join(sampleDir!, file))], basename(file), { type: file.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' }));
  task = snapshotOf((await call(`/api/tasks/${task.task.taskId}/batches`, { method: 'POST', body: form })).body);
  task = await act(task, 'start-inventory');
  task = await until(task.task.taskId, (s) => s.inventory.status === 'done', 5 * 60_000);
  if (task.step.kind !== 'assign_projects') throw new Error(`the sample is not clean: stage ${task.stage}, step ${task.step.kind} (resolve it in the app first)`);
  task = await act(task, 'submit-project-assignment', { purpose: sample.purpose, projects: Object.fromEntries(task.lines.map((line) => [line.lineId, sample.project])) });
  task = await act(task, 'confirm-review', { digest: task.confirmation.digest });
  await openInEgo(`${server.url}/#/task/${task.task.taskId}/erp`);

  task = await act(task, 'start-erp-write');
  for (;;) {
    task = await until(task.task.taskId, (s) => s.erp.status !== 'running');
    if (task.step.kind !== 'erp_login') break;
    if (password) { say(`ERP asks for a login${task.erp.loginNotice ? ` (${task.erp.loginNotice})` : ''}; signing in again.`); await signIn(); }
    else await ask.question(`[erp-live] ERP asks for a login${task.erp.loginNotice ? ` (${task.erp.loginNotice})` : ''}. Log in, then press Enter. `);
    task = await act(task, 'confirm-login');
  }

  say(`stage ${task.stage}; draft ${task.erp.draftNo ?? '-'}; read-back ${task.readback.summary ?? task.readback.status}`);
  if (task.erp.abortReason) say(`stopped: ${task.erp.abortReason}`);
  exitCode = task.stage === 'done' && task.readback.status === 'matched' ? 0 : 1;
} catch (error) {
  console.error(`[erp-live] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await server.close();
  await report();
  ask.close();
}
say(exitCode === 0 ? 'PASS: a real draft was saved and passed the strict read-back.' : `FAIL. Facts kept in ${dataDir}.`);
process.exit(exitCode);

// The decisions this run settles, from the persisted job log.
async function report(): Promise<void> {
  const db = await openDatabase(databasePath(dataDir));
  try {
    const attempts = await db.selectFrom('erp_attempt').select(['action', 'erp_build', 'form_id', 'preconditions']).orderBy('started_at').execute();
    for (const attempt of attempts) say(`attempt ${attempt.action}: build ${attempt.erp_build} / form ${attempt.form_id}; detail rows before ${JSON.parse(attempt.preconditions).detailRowCount}`);
    const events = await db.selectFrom('erp_job_event').select('payload').where('type', '=', 'readback').orderBy('created_at').execute();
    for (const { payload } of events) {
      const event = JSON.parse(payload) as { stage: string; readings: { detailGrid: { ok: boolean; rows?: Array<{ kind: string; values: Record<string, string> }> } } };
      const rows = event.readings.detailGrid.ok ? (event.readings.detailGrid.rows ?? []).filter((row) => row.kind === 'data') : [];
      const linked = rows.filter((row) => (row.values['收票单号'] ?? '').trim()).length;
      say(`read-back ${event.stage}: ${rows.length} detail row(s), ${linked} with 收票单号`);
    }
  } finally {
    await db.destroy();
  }
}

// Fills the ERP login form in the dedicated Chromium and waits for the console. Harness only: in the product the
// employee logs in themselves, and that login IS the ERP authorisation (ADR-0016). The form is plain HTML — the Kendo
// controls that ignore programmatic assignment live on the bill, not here — so a native-setter write plus input/change
// is enough. The password is never logged, and never leaves this process except into the page it authenticates.
function loginScript(user: string, secret: string): string {
  return `(() => {
    const seen = (el) => !!el && (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
    // Measured on 金蝶云星空 8.2.0.20250701: the login page carries #user (account) and #password, plus a second
    // visible #CAuser for certificate login that must not be mistaken for the account box. Ids first, shape as fallback.
    const byId = (id) => { const el = document.getElementById(id); return seen(el) ? el : null; };
    const secretBox = byId('password') || [...document.querySelectorAll('input[type=password]')].filter(seen)[0];
    if (!secretBox) return { ok: false, why: 'no visible password input' };
    const userBox = byId('user') || [...document.querySelectorAll('input')].filter((el) => el !== secretBox && seen(el) && !/^(checkbox|radio|hidden|submit|button|file)$/i.test(el.type))[0];
    if (!userBox) return { ok: false, why: 'no visible account input' };
    const put = (el, value) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    put(userBox, ${JSON.stringify(user)});
    put(secretBox, ${JSON.stringify(secret)});
    const button = [...document.querySelectorAll('button, a, input[type=submit], div[role=button]')].filter(seen)
      .find((el) => ((el.innerText || el.value || '').trim() === '登录'));
    if (!button) return { ok: false, why: 'no visible 登录 button' };
    button.click();
    return { ok: true };
  })()`;
}

async function signIn(fillMs = 60_000, settleMs = 90_000): Promise<Awaited<ReturnType<typeof probeNow>>> {
  // `document.readyState` reaches 'complete' well before Kendo has laid the login form out, so a single attempt
  // fires into an empty page and reports "no visible password input". Keep trying until the form is really there.
  const fillDeadline = Date.now() + fillMs;
  let submitted = false;
  let lastWhy = 'no ERP tab';
  while (!submitted && Date.now() < fillDeadline) {
    for (const page of (await browser.listPages()).filter((page) => sameOrigin(page.url, erpConfig.origin))) {
      const outcome = await evaluateChromiumPage<{ ok: boolean; why?: string }>(page as never, loginScript(account!, password), { timeoutMs: 10_000 }).catch(() => null);
      if (outcome?.ok) { submitted = true; break; }
      if (outcome?.why) lastWhy = outcome.why;
    }
    if (!submitted) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  say(submitted ? `submitted the login form as ${account}.` : `could not fill the login form (${lastWhy}); waiting in case someone logs in by hand.`);
  const settleDeadline = Date.now() + settleMs;
  for (;;) {
    const result = await probeNow();
    if (result.status === 'matched' || Date.now() > settleDeadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// Opens a page in the ego-browser task space (headed) so the user can watch; prints the URL when ego is unavailable.
async function openInEgo(url: string): Promise<void> {
  const space = env['BAOX_EGO_TASK_SPACE']?.trim();
  if (!space) return say(`open ${url} to watch (BAOX_EGO_TASK_SPACE is not set)`);
  const id = /^\d+$/.test(space) ? space : JSON.stringify(space);
  const script = `const tab = await openOrReuseTab(${JSON.stringify(url)}, { wait: true, timeout: 30 }); console.log('__BAOX_EGO_RESULT__' + JSON.stringify({ ok: true, value: tab?.targetId ?? null }));`;
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(env['BAOX_EGO_BROWSER'] || 'ego-browser', ['nodejs'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...env, EGO_TASK_SPACE: String(id) } });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(script);
  });
  if (!ok) say(`ego-browser did not open the page; open ${url} to watch`);
}
