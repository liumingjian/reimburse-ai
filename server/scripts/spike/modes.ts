// S8 of docs/design/erp-headless-v1.md §验证计划: the same 去报销 on the employee's PC three ways — in the 浏览器扩展
// (`chrome.debugger`), in a dedicated headed Chromium and in a headless one (both over CDP) — compared by how often it
// gets through and how long it takes.
//
// Every mode runs the executor's own `runFillJob` on the same plan and the same test invoice; only the browser port
// differs. The extension gets the plan as the server's remote executor sends it (`erp.fill` over the channel), from a
// stand-in app that pairs it, serves the invoice original and answers its events. The CDP modes run the job in this
// process over `cdpBrowser`, with the same answers through `wireChannel`.
//
// READ-ONLY. The run stops at the one irreversible act, the 发票导入单据 click: the stand-in never acknowledges the
// `attempt_started` that must precede it (`{ persisted: false }` is refused by `wireChannel`), so the executor aborts
// with nothing imported and no attempt recorded. What it does before that — login probe, 报销信息核对 (a read-only
// query), opening one 费用报销单-新增, the compatibility fingerprint, opening the invoice assistant, uploading,
// recognising and ticking the invoice — ADR-0025 calls free and repeatable. The unsaved form is then closed with 否.
//
// Without a test invoice the run is a smoke test: the plan names an invoice nobody serves, so the executor stops at
// fetching it, after the login probe and 报销信息核对 and before the page is touched. That proves the browsers start,
// the extension pairs and the channel works, at no cost at all.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ChannelMessageSchema, EXTENSION_CHANNEL_PATH, EXTENSION_HEARTBEAT_MS, EXTENSION_PAIR_PATH, extensionBlobPath, type ChannelMessage,
} from '@baox/contract';
import { cdpBrowser } from '@baox/erp-executor/browser';
import { connect, evalIn, type CdpSession } from '@baox/erp-executor/cdp';
import { EXPENSE_ITEM_FORM, queryRows } from '@baox/erp-executor/catalog';
import { runFillJob } from '@baox/erp-executor/job';
import { sleep, waitFor } from '@baox/erp-executor/pace';
import { ExecutorError } from '@baox/erp-executor/page';
import { closeErpDialogs, closeInvoiceAssistant } from '@baox/erp-executor/steps';
import { sameOrigin } from '@baox/erp-executor/probe';
import { navigationScene } from '@baox/erp-executor/scene';
import { PROTOCOL_VERSION, type Compatibility, type ExecutorEvent, type FillPlan, type ResultEvent } from '@baox/erp-executor/protocol';
import { closeFormTab, tabActions } from '@baox/erp-executor/tabs';
import { EXECUTOR_METHODS, wireChannel } from '@baox/erp-executor/wire';
import { carriesOrigin, stampedManifestProblem, stampOrigin } from '@baox/extension/template';
import { launchBrowser, type Headless } from './browser';
import { login, logout, observe } from './erp';
import { tracePage, type PageTrace } from './trace';
import type { Observations, Report, Verdict } from './report';

export const MODES = ['extension', 'headed', 'headless'] as const;
export type Mode = (typeof MODES)[number];

/** A job that has not reached the import boundary by then has failed; a real run's import alone takes far less. */
const JOB_MS = 6 * 60_000;
const extensionRoot = fileURLToPath(new URL('../../../extension/', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// The stand-in app

export type Stamped = { at: number; event: ExecutorEvent };

/**
 * How the stand-in answers every executor event, in both modes. `attempt_started` is the brake: anything but
 * `{ persisted: true }` is refused by `wireChannel`, before the 发票导入单据 click. A `readback` is never reached;
 * were it, the answer would stop the job too.
 */
function answer(event: ExecutorEvent): unknown {
  if (event.type === 'attempt_started') return { persisted: false };
  if (event.type === 'readback') return { ok: false, reasons: ['S8 的替身应用不判定回读'] };
  return null;
}

export type StandIn = Awaited<ReturnType<typeof standInApp>>;

/**
 * The app as far as the extension can tell, on a fixed port (the extension is stamped with its origin once, so its
 * pairing survives between runs in the persistent profile): it redeems any 配对码, accepts the channel, sends one
 * `erp.fill` at a time, serves the one invoice original, and answers every `erp.event` with `answer`.
 */
export async function standInApp({ port, invoice }: { port: number; invoice: { sha256: string; bytes: Uint8Array } | null }) {
  let log: Stamped[] = [];
  let socket: WebSocket | null = null;
  const pending = new Map<string, (message: Extract<ChannelMessage, { type: 'response' }>) => void>();
  let seq = 0;
  /** What the extension has asked of the stand-in so far: a pairing that never connects shows where it stopped. */
  const seen = { pairRequests: 0, sockets: 0, hellos: 0 };
  const record = (event: ExecutorEvent) => { log.push({ at: Date.now(), event }); return answer(event); };

  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === EXTENSION_PAIR_PATH) {
      seen.pairRequests += 1;
      request.resume();
      request.on('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ token: 's8-token', accountId: 's8-account' })); });
    } else if (invoice && request.method === 'GET' && request.url === extensionBlobPath(invoice.sha256)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from(invoice.bytes));
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  const channel = new WebSocketServer({ server, path: EXTENSION_CHANNEL_PATH });
  const write = (ws: WebSocket, message: ChannelMessage) => ws.send(JSON.stringify(message));
  channel.on('connection', (ws) => {
    seen.sockets += 1;
    ws.on('close', () => { if (socket === ws) socket = null; });
    ws.on('message', (data) => {
      const message = ChannelMessageSchema.parse(JSON.parse(String(data)));
      if (message.type === 'hello') {
        seen.hellos += 1;
        socket = ws;
        write(ws, { type: 'ready', accountId: 's8-account', heartbeatMs: EXTENSION_HEARTBEAT_MS });
      } else if (message.type === 'response') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else if (message.type === 'request') {
        if (message.method === 'ping') return write(ws, { type: 'response', id: message.id, ok: true, payload: null });
        if (message.method !== EXECUTOR_METHODS.event) return write(ws, { type: 'response', id: message.id, ok: false, error: { code: 'unknown_method', message: message.method } });
        const { event } = message.payload as { event: ExecutorEvent };
        write(ws, { type: 'response', id: message.id, ok: true, payload: record(event) ?? null });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });

  return {
    origin: `http://127.0.0.1:${port}`,
    connected: () => socket !== null,
    seen: () => ({ ...seen }),
    /** This job's events, each stamped when it arrived; `fresh()` starts a new log. */
    events: () => log,
    fresh() { log = []; },
    /** The executor's `request` for a job run in this process: the same answers, the same log. */
    request: async (_method: string, payload: unknown) => record((payload as { event: ExecutorEvent }).event),
    /** One 去报销, as the remote executor sends it (with the ERP 凭据 for a 本地执行器). Resolves with the job's result. */
    fill(plan: FillPlan, trigger: 'start' | 'confirm_login' = 'start', credentials?: { account: string; password: string }): Promise<ResultEvent> {
      if (!socket) return Promise.reject(new Error('扩展没有连上替身应用'));
      seq += 1;
      const id = `s8-${seq}`;
      const answered = new Promise<ResultEvent>((resolve, reject) => {
        pending.set(id, (message) => (message.ok ? resolve(message.payload as ResultEvent) : reject(new Error(message.error.message))));
      });
      write(socket, { type: 'request', id, method: EXECUTOR_METHODS.fill, payload: { plan, trigger, ...(credentials ? { credentials } : {}) } });
      return answered;
    },
    /** The 试登录 the app asks a 本地执行器 for after the employee saves the ERP 凭据. */
    trySignIn(erpOrigin: string, credentials: { account: string; password: string }): Promise<unknown> {
      if (!socket) return Promise.reject(new Error('执行器没有连上替身应用'));
      seq += 1;
      const id = `s8-${seq}`;
      const answered = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (message) => (message.ok ? resolve(message.payload) : reject(new Error(message.error.message))));
      });
      write(socket, { type: 'request', id, method: EXECUTOR_METHODS.trySignIn, payload: { erpOrigin, credentials } });
      return answered;
    },
    close: async () => {
      for (const client of channel.clients) client.terminate();
      channel.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The extension as Chromium loads it: the build's origin-less template stamped with `origin` by the server's own rule
 * (`@baox/extension/template`), at a fixed path so its id — and with it the pairing kept in the profile — is stable.
 */
export function stampedExtension(dir: string, origin: string): string {
  const template = join(dir, 'template');
  const built = spawnSync(process.execPath, [join(extensionRoot, 'scripts', 'build.mjs'), template], { cwd: extensionRoot, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`扩展构建失败：${built.stderr || built.stdout}`);
  const out = join(dir, 'unpacked');
  rmSync(out, { recursive: true, force: true });
  cpSync(template, out, { recursive: true });
  for (const name of readdirSync(out, { recursive: true, encoding: 'utf8' })) {
    const path = join(out, name);
    if (statSync(path).isFile() && carriesOrigin(name)) writeFileSync(path, stampOrigin(readFileSync(path, 'utf8'), origin));
  }
  const problem = stampedManifestProblem(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { host_permissions?: unknown; content_scripts?: unknown }, origin);
  if (problem) throw new Error(problem);
  return out;
}

/**
 * Whether the extension connected with the pairing kept in its profile; if not, pair it. Not through the popup: opened
 * in a tab, as CDP can only open it, the popup has a `sender.tab` and the worker takes it for a content script
 * (`bridge.ts` `fromContentScript`) and never answers it. So the worker is given what a redeemed 配对码 leaves behind,
 * the stored pairing (`pairing-requests.ts`), and the caller restarts the browser, after which the worker dials the
 * channel with it as it does after any restart. (Reloading the extension in place did not reconnect within 20 s.)
 */
async function paired(h: Headless, app: StandIn): Promise<'kept' | 'written'> {
  if (await waitFor(async () => app.connected(), Boolean, 15_000, 300)) return 'kept';
  const targets = await waitFor(
    async () => (await (await fetch(`http://127.0.0.1:${h.port}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>,
    (list) => list.some((t) => t.type === 'service_worker' && t.url.endsWith('/service-worker.js')), 15_000, 500);
  // Chrome for Testing carries a component extension of its own; ours is the one whose worker is service-worker.js.
  const worker = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/service-worker.js'));
  if (!worker?.webSocketDebuggerUrl) throw new Error('浏览器里看不到扩展的 service worker（--load-extension 没有生效）');
  const session = await connect(worker.webSocketDebuggerUrl);
  try {
    await evalIn(session, `chrome.storage.local.set({ pairing: { token: 's8-token', accountId: 's8-account' } }).then(() => true)`);
  } finally {
    session.close();
  }
  return 'written';
}

// ---------------------------------------------------------------------------------------------------------------
// One run

export type ModeCtx = {
  report: Report;
  origin: string; entry: string; compatibility: Compatibility;
  account: string; password: string; prefetch: boolean;
  chromium: string | null; profileRoot: string; extensionDir: string;
  /** null: a smoke run (see the top of this file). */
  invoice: { sha256: string; bytes: Uint8Array; mime: string } | null;
  app: StandIn;
  /** One real expense item, read on the first login and kept in memory, so 报销信息核对 really queries. */
  catalogItem: { code: string; name: string } | null;
};

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One task per run; a `confirm_login` is a new job of the same task, which is how the extension finds its tab again. */
const planFor = (ctx: ModeCtx, taskId: string, jobId = taskId): FillPlan => ({
  protocolVersion: PROTOCOL_VERSION, kind: 'fill', jobId, taskId, erpOrigin: ctx.origin, compatibility: ctx.compatibility,
  catalog: { projects: [], expenseItems: ctx.catalogItem ? [ctx.catalogItem] : [] },
  invoices: [{ sha256: ctx.invoice?.sha256 ?? '0'.repeat(64), fileName: 's8-test-invoice.pdf', mime: ctx.invoice?.mime ?? 'application/pdf' }],
  purpose: 'S8 执行方式对比',
});

/** Every step's running→done (or →failed) time, in the order the job ran them. */
function stepTimes(events: Stamped[], started: number) {
  const out: Array<{ step: string; ms: number; status: string }> = [];
  const open = new Map<string, number>();
  for (const { at, event } of events) {
    if (event.type !== 'step') continue;
    if (event.status === 'running') open.set(event.step, at);
    else out.push({ step: event.step, ms: at - (open.get(event.step) ?? started), status: event.status });
  }
  return out;
}

/** Close every 费用报销单 tab in every ERP page of the browser, answering 是否保存 with 否 (tabs.ts `closeFormTab`). */
async function discardEverywhere(h: Headless, origin: string): Promise<string[]> {
  const notes: string[] = [];
  const browser = cdpBrowser(h.port);
  for (const page of (await browser.listPages().catch(() => [])).filter((p) => sameOrigin(p.url, origin))) {
    const attached = await browser.attach(page).catch(() => null);
    if (!attached) continue;
    try {
      // The job stops with the 发票助手 still open over the 新增单, and its window covers the tab's close button: shut
      // it (and any ERP dialog) first, or closing the form waits out its whole reach budget for nothing.
      const page = { session: attached.session };
      if ((await closeInvoiceAssistant(page)).ok) notes.push('关闭发票助手');
      await closeErpDialogs(page).catch(() => null);
      const actions = tabActions(attached.session);
      for (const tab of (await actions.tabs().catch(() => [])).filter((t) => t.isForm)) {
        const outcome = await closeFormTab(actions, tab.id);
        notes.push(`关闭「${tab.text}」：${outcome.closed ? '已关闭' : '没有关掉'}（${outcome.note}）`);
      }
    } finally {
      attached.session.close();
    }
  }
  return notes;
}

/** The ERP page the job ran in: the extension's own tab, or the one page the CDP modes share. */
async function jobPage(h: Headless, origin: string): Promise<CdpSession | null> {
  const browser = cdpBrowser(h.port);
  const pages = (await browser.listPages().catch(() => [])).filter((p) => sameOrigin(p.url, origin));
  const page = pages[pages.length - 1];
  return page ? (await browser.attach(page).catch(() => null))?.session ?? null : null;
}

type Signed = { session: CdpSession; trace: PageTrace | null; own: boolean };

/** Sign in on `session` with the spike's login (spike/erp.ts), or find it signed in already. */
async function signIn(ctx: ModeCtx, session: CdpSession, trace: PageTrace | null, label: string, obs: Observations): Promise<string | null> {
  const before = await observe(session, ctx.origin);
  if (before.verdict === 'matched') {
    obs['login'] = { ok: true, reused: true };
    return null;
  }
  const outcome = await login(session, { origin: ctx.origin, account: ctx.account, password: ctx.password, prefetch: ctx.prefetch, ...(trace ? { trace } : {}) });
  ctx.report.secret(outcome.displayName);
  obs['login'] = { ok: outcome.ok, reused: false, ms: outcome.ms, why: outcome.why, alreadyOnline: outcome.alreadyOnline.seen, submits: outcome.submits, reloads: outcome.reloads };
  if (outcome.ok) return null;
  obs['loginPage'] = { url: await evalIn<string>(session, 'location.href').catch(() => null), state: outcome.pageState, end: outcome.diagnostics['end'] ?? null };
  await ctx.report.shot(session, `${label}-login-failed`);
  return `登录失败：${outcome.why}`;
}

const pageIds = async (port: number, origin: string) =>
  new Set((await cdpBrowser(port).listPages().catch(() => [])).filter((p) => sameOrigin(p.url, origin)).map((p) => String(p.cdpTargetId)));

/**
 * One run in `mode`: start the browser on the mode's persistent profile, run the job to the import boundary, then
 * discard the form, sign out and close the browser. PASS when the job got to `attempt_started` for the import, i.e.
 * everything before the irreversible click worked.
 *
 * Signing in follows each mode's real flow. The CDP modes sign in on the page the browser opened and run the job there.
 * The extension's 去报销 (`start`) always opens a tab of its own, and ERP keeps its login per tab — a session signed in
 * on another tab of the same browser is not seen there (measured 2026-10-12) — so, as in the product, the job stops at
 * `waiting_login`, the employee signs in on that tab, and 我已登录，继续 (`confirm_login`) runs the job in it. The
 * comparison times the job that ran: `confirm_login` for the extension, `start` for the others; the extension's
 * `start` and its login are reported beside it.
 */
export async function runMode(ctx: ModeCtx, mode: Mode, label: string, obs: Observations): Promise<Verdict> {
  const started = Date.now();
  const profileDir = join(ctx.profileRoot, mode);
  const launch = () => {
    // The profile keeps its cache, not its last tabs: a restored ERP tab next to the new one is two identical pages,
    // and the executor rightly refuses to guess between them (CHROMIUM_CDP_AMBIGUOUS).
    rmSync(join(profileDir, 'Default', 'Sessions'), { recursive: true, force: true });
    // Nor the extension's last worker: Chrome keeps an unpacked extension's service-worker script in the profile and,
    // its version unchanged, ran yesterday's executor over today's build (measured 2026-10-12: the old login probe and
    // error texts after a rebuild). The pairing lives in chrome.storage, not here.
    if (mode === 'extension') rmSync(join(profileDir, 'Default', 'Service Worker'), { recursive: true, force: true });
    return launchBrowser({
      label, openUrl: ctx.entry, origin: ctx.origin, chromium: ctx.chromium, headless: mode === 'headless', profileDir,
      // Chrome for Testing turns every field trial on; one of them (measured on 153, 2026-10-12) refuses a navigation
      // to the ERP, a public name on a private address, with ERR_BLOCKED_BY_CLIENT. Without the trials it behaves as stable.
      extraArgs: ['--disable-field-trial-config', ...(mode === 'extension' ? [`--disable-extensions-except=${ctx.extensionDir}`, `--load-extension=${ctx.extensionDir}`] : [])],
    });
  };
  let h = await launch();
  obs['launchMs'] = h.launchMs;
  let signed: Signed | null = null;
  let jobSession: CdpSession | null = null;
  const blobs = { read: async () => { if (!ctx.invoice) throw new ExecutorError('INVOICE_BLOB_UNAVAILABLE', '冒烟运行：没有测试发票'); return ctx.invoice.bytes; } };
  const race = <T>(run: Promise<T>) => Promise.race([run, sleep(JOB_MS).then(() => null)]);
  try {
    let plan = planFor(ctx, `s8-${label}-${Date.now()}`);
    let result: ResultEvent | null;
    let jobStarted: number;
    if (mode === 'extension') {
      const t = Date.now();
      const how = await paired(h, ctx.app);
      if (how === 'written') {
        await h.close();
        h = await launch();
        if (!await waitFor(async () => ctx.app.connected(), Boolean, 30_000, 300)) {
          return { status: 'FAIL', reason: `写入配对并重启浏览器后 30 秒内扩展没有连上替身应用（替身应用收到 ${JSON.stringify(ctx.app.seen())}）` };
        }
      }
      obs['pairing'] = { how, ms: Date.now() - t };

      // The page the browser opened goes first: next to the extension's tab it would be a second identical ERP page,
      // which CDP attach refuses (CHROMIUM_CDP_AMBIGUOUS). It is blanked, not closed: closing the window's only tab
      // closes the window, and the extension then has none to open its tab in ("No current window").
      await h.session.send('Page.navigate', { url: 'about:blank' }).catch(() => null);
      await waitFor(async () => (await pageIds(h.port, ctx.origin)).size, (n) => n === 0, 10_000, 300);
      // 去报销: the extension opens its own tab and, finding it signed out, waits for the employee there.
      const before = await pageIds(h.port, ctx.origin);
      ctx.app.fresh();
      const s = Date.now();
      const first = await race(ctx.app.fill(plan, 'start'));
      obs['start'] = { ms: Date.now() - s, status: first?.status ?? null, code: first?.code ?? null };
      if (!first) return { status: 'FAIL', reason: `去报销（start）${JOB_MS / 60_000} 分钟内没有结束` };
      if (first.status === 'waiting_login') {
        const browser = cdpBrowser(h.port);
        const tab = (await browser.listPages()).find((p) => sameOrigin(p.url, ctx.origin) && !before.has(String(p.cdpTargetId)));
        if (!tab) return { status: 'FAIL', reason: '扩展说在等登录，但找不到它新开的 ERP 标签页' };
        const session = (await browser.attach(tab)).session;
        signed = { session, trace: await tracePage(session).catch(() => null), own: true };
        const failed = await signIn(ctx, session, signed.trace, label, obs);
        if (failed) return { status: 'FAIL', reason: failed };
        await catalogOnce(ctx, session);
        plan = planFor(ctx, plan.taskId, `${plan.taskId}-confirm`);
        ctx.app.fresh();
        jobStarted = Date.now();
        result = await race(ctx.app.fill(plan, 'confirm_login'));
      } else {
        if (first.status === 'aborted') {
          // What the extension's tab showed when its login probe gave up: path, load state and shape, never its text.
          const tab = await jobPage(h, ctx.origin);
          obs['startTab'] = tab ? await evalIn(tab, `({ path: location.pathname, ready: document.readyState, textLength: (document.body?.innerText || '').trim().length,
            loginForm: !!document.querySelector('input[type=password]'), console: !!document.querySelector('span.kd-mainconsole-usernametext'), sinceLoadMs: Math.round(performance.now()) })`).catch((e: Error) => e.message) : null;
          tab?.close();
        }
        // Signed in already (the tab saw a session): the start itself was the job.
        jobStarted = s;
        result = first;
      }
    } else {
      signed = { session: h.session, trace: h.trace, own: false };
      const failed = await signIn(ctx, h.session, h.trace, label, obs);
      if (failed) return { status: 'FAIL', reason: failed };
      await catalogOnce(ctx, h.session);
      plan = planFor(ctx, `s8-${label}-${Date.now()}`);
      ctx.app.fresh();
      jobStarted = Date.now();
      result = await race(runFillJob(plan, { browser: cdpBrowser(h.port), channel: wireChannel(plan.jobId, ctx.app.request), probeWaitMs: 30_000, blobs }));
    }
    obs['catalogEntries'] = ctx.catalogItem ? 1 : 0;

    const events = ctx.app.events();
    const boundary = events.find((e) => e.event.type === 'attempt_started' && e.event.action === 'import');
    obs['job'] = {
      ms: Date.now() - jobStarted,
      toBoundaryMs: boundary ? boundary.at - jobStarted : null,
      steps: stepTimes(events, jobStarted),
      result: result ? { status: result.status, code: result.code, message: (result.message ?? '').slice(0, 300) } : null,
      waitingLogin: events.some((e) => e.event.type === 'waiting_login'),
    };
    obs['memory'] = h.memory();
    obs['crashes'] = [...h.crashes];
    if (!result) return { status: 'FAIL', reason: `任务 ${JOB_MS / 60_000} 分钟内没有结束` };
    if (!ctx.invoice) {
      const done = stepTimes(events, jobStarted).filter((st) => st.status === 'done').map((st) => st.step);
      const through = done.includes('login') && done.includes('catalog') && result.code === 'INVOICE_BLOB_UNAVAILABLE';
      return through
        ? { status: 'PASS', reason: `冒烟：${((Date.now() - jobStarted) / 1000).toFixed(1)}s 走完 ${done.join('→')}，在取发票原件处按预期停下` }
        : { status: 'FAIL', reason: `冒烟没走通：完成 ${done.join('→') || '无'}；${result.status} ${result.code ?? ''} ${result.message ?? ''}`.slice(0, 300) };
    }
    if (!boundary) {
      jobSession = await jobPage(h, ctx.origin);
      if (jobSession && /ERP_NEW_FORM_NOT_OPENED|CHROMIUM_TARGET_NOT_FOUND/.test(result.code ?? '')) {
        obs['navigationScene'] = await navigationScene(jobSession).catch((e: Error) => e.message);
      }
      await ctx.report.shot(jobSession, `${label}-failed`);
      return { status: 'FAIL', reason: `没有走到导入前：${result.status} ${result.code ?? ''} ${result.message ?? ''}`.slice(0, 300) };
    }
    if (result.status !== 'aborted') return { status: 'FAIL', reason: `走到了导入前，但结果是 ${result.status}（期望替身应用的刹车让它 aborted）` };
    return { status: 'PASS', reason: `${((boundary.at - jobStarted) / 1000).toFixed(1)}s 走到导入前（登录探测→核对→新增单→指纹→发票助手→上传识别勾选）` };
  } finally {
    jobSession?.close();
    const notes = await discardEverywhere(h, ctx.origin).catch((e: Error) => [`关闭表单出错：${e.message}`]);
    if (signed && (obs['login'] as { ok?: boolean } | undefined)?.ok) {
      const out = await logout(signed.session, ctx.origin).catch((e: Error) => ({ verified: false, after: e.message }));
      notes.push(out.verified ? '已登出 ERP' : `登出没有得到确认（${out.after}）`);
    }
    if (signed?.own) { signed.trace?.stop(); signed.session.close(); }
    notes.push(...await h.close());
    obs['cleanup'] = notes;
    obs['totalMs'] = Date.now() - started;
  }
}


/** One real expense item, read once on the first signed-in page and kept in memory, so 报销信息核对 really queries. */
async function catalogOnce(ctx: ModeCtx, session: CdpSession) {
  if (ctx.catalogItem) return;
  const item = await queryRows(session, { formId: EXPENSE_ITEM_FORM, fieldKeys: 'FNumber,FName', filter: "FDocumentStatus = 'C' and FForbidStatus = 'A'", limit: 1 });
  const row = item.ok ? item.rows[0] : null;
  if (row) ctx.catalogItem = { code: String(row[0]), name: String(row[1]) };
  for (const value of [ctx.catalogItem?.code, ctx.catalogItem?.name]) ctx.report.secret(value);
}

export const invoiceMime = (path: string) => (/\.pdf$/i.test(path) ? 'application/pdf' : /\.png$/i.test(path) ? 'image/png' : 'image/jpeg');
export const readInvoice = (path: string) => {
  if (!existsSync(path)) throw new Error(`找不到测试发票 ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, sha256: sha256Of(bytes), mime: invoiceMime(path) };
};
