// The real-browser harness (spec #246, seam 4): Chromium with the unpacked extension loaded, the fake ERP's recorded
// pages served over HTTP, and the app on the other end of the extension's channel. It is the only place
// `chrome.debugger` really executes. Runs on the maintainer's mac through rexec, never on the dev server.
//
// Four pieces, each one function, so a case can swap one without touching the others:
// - `serveErpSites` — the fake ERP on 127.0.0.1 and the 发票无忧助手 (invoice assistant) page on `localhost`, a
//   second site, so an assistant frame is genuinely cross-origin (and out of process) in Chromium;
// - `fakeBaox`      — a stand-in for the app: the #253 channel envelope and the fill methods, answering the executor's
//                     events. It cannot judge a read-back, so it carries no run past the first one; the full runs use
//                     the real server instead (`app.ts`);
// - `unpackedExtension` — the extension, stamped for one origin, as a directory Chromium can load;
// - `launchWithExtension` / `pair` — Chromium with that directory loaded, paired through its own popup.
//
// The recorded pages carry no behaviour of their own; the jsdom fake ERP supplies it from outside the page, which a
// real browser cannot use. So the served pages load `fake-erp-page.js`, the same behaviour run inside the page, and a
// real 去报销 can run on them end to end.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { WebSocketServer, type WebSocket } from 'ws';
import { ChannelMessageSchema, EXTENSION_CHANNEL_PATH, EXTENSION_HEARTBEAT_MS, EXTENSION_PAIR_PATH, type ChannelMessage } from '@baox/contract';
import { PROTOCOL_VERSION, type ExecutorEvent, type FillPlan, type ResultEvent } from '@baox/erp-executor/protocol';
import { answerBillQuery, erpFixtureHtml, fixture, type FakeMasterData } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS } from '@baox/erp-executor/wire';
import { carriesOrigin, stampedManifestProblem, stampOrigin } from '../src/template';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));

export const ACCOUNT = { displayName: '刘明建', account: 'luo.liu', tenant: 'tenant-a' };
export const PROJECTS: FakeMasterData[] = [{ code: '39163', name: '中国农业发展银行河南省分行-20-2614' }];
export const EXPENSE_ITEMS: FakeMasterData[] = [{ code: 'FY010003', name: '长途交通' }];
export const PAGE = { uuid: 'a1b2c3d4e5f6', displayName: ACCOUNT.displayName, erpBuild: '8.2.830.9', formId: 'ER_ExpReimbursement', today: '2026/9/15' };
const QUERY_PATH = '/k3cloud/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc';

const listen = async (handler: RequestListener): Promise<{ server: Server; port: number }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  return { server, port: address.port };
};
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const bodyOf = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => resolve(text));
  });
const send = (response: ServerResponse, status: number, type: string, body: string) =>
  response.writeHead(status, { 'content-type': `${type}; charset=utf-8` }).end(body);

export type ErpSites = Awaited<ReturnType<typeof serveErpSites>>;

/** An invoice the fake ERP knows, by the sha256 of its bytes, and what it mints and shows for it. */
export type StockedInvoice = {
  sha256: string; invoiceNumber: string; receiptNumber: string; seller: string; issueDate: string;
  net: string; tax: string; gross: string; category: string;
};

const PAGE_SCRIPT = readFileSync(fileURLToPath(new URL('./fake-erp-page.js', import.meta.url)), 'utf8');
const PAGE_SCRIPT_PATH = '/__fake/page.js';
const IMPORT_CLICK_PATH = '/__fake/import-click';
// The executor finds the assistant's child target by `url.includes('piaozone')` (steps.ts `assistantSession`).
const ASSISTANT_PATH = '/piaozone/m4-web/fpzs/index';
// Starts `fake-erp-page.js` with its configuration; `<` escaped so no value can close the script element.
const behaviour = (config: Record<string, unknown>) =>
  `<script>window.__FAKE_ERP__ = ${JSON.stringify(config).replace(/</g, '\\u003c')};</script><script src="${PAGE_SCRIPT_PATH}"></script>`;
// The little CSS the recorded pages need to lay out as live: Kendo's icons have a size (the 选择发票 split arrow is
// nothing but one), and the assistant's entry anchor is inline around a 76x74 block icon.
const ERP_STYLE = '<style>.k-icon { display: inline-block; width: 16px; height: 16px; }</style>';
const ASSISTANT_STYLE = '<style>.accessItem img { display: block; width: 76px; height: 74px; }</style>';

/**
 * The fake ERP's pages over HTTP: the main console when `loggedIn`, the login page otherwise, and the assistant. Both
 * run `fake-erp-page.js`, so the invoices `stock` names are recognised, imported and written as the jsdom fake does.
 * `onImportClick` holds the assistant's 发票导入单据 click in flight until the hook resolves.
 */
export async function serveErpSites({ loggedIn = true, projects = PROJECTS, expenseItems = EXPENSE_ITEMS } = {}) {
  const stock: { invoices: StockedInvoice[]; projects: FakeMasterData[]; expenseItems: FakeMasterData[] } = { invoices: [], projects, expenseItems };
  let importClick: () => Promise<void> = async () => {};
  let erpOrigin = '';
  let assistantOrigin = '';
  const assistant = await listen(async (request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path === PAGE_SCRIPT_PATH) send(response, 200, 'text/javascript', PAGE_SCRIPT);
    else if (request.method === 'POST' && path === IMPORT_CLICK_PATH) {
      await importClick();
      response.writeHead(204).end();
    } else if (path.includes('/fpzs/')) {
      const page = fixture('piaozone-assistant.html')
        .replace('</head>', `${ASSISTANT_STYLE}</head>`)
        .replace('</body>', `${behaviour({ role: 'assistant', invoices: stock.invoices, erpOrigin })}</body>`);
      send(response, 200, 'text/html', page);
    } else send(response, 404, 'text/plain', 'not found');
  });
  const erp = await listen(async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path === '/k3cloud/html5/index.aspx') {
      // What the jsdom fake sets from outside, the served page sets for itself: the build K3Cloud hangs on
      // `KDResVer`, and the last account, which localStorage keeps even on the login page.
      const boot = `<script>window.KDResVer = ${JSON.stringify(`?ver=${PAGE.erpBuild}`)};`
        + `localStorage.setItem('k3cloudloginInfo', ${JSON.stringify(JSON.stringify({ user: ACCOUNT.account, acc: ACCOUNT.tenant }))});</script>`;
      const config = { role: 'erp', assistantUrl: `${assistantOrigin}${ASSISTANT_PATH}`, assistantOrigin, today: PAGE.today, ...stock };
      send(response, 200, 'text/html', erpFixtureHtml(loggedIn, PAGE).replace('</head>', `${ERP_STYLE}${boot}</head>`)
        .replace('</body>', `${loggedIn ? behaviour(config) : ''}</body>`));
    } else if (request.method === 'GET' && path === PAGE_SCRIPT_PATH) {
      send(response, 200, 'text/javascript', PAGE_SCRIPT);
    } else if (request.method === 'POST' && path === QUERY_PATH) {
      send(response, 200, 'application/json', JSON.stringify(answerBillQuery(await bodyOf(request), stock)));
    } else {
      send(response, 404, 'text/plain', 'not found');
    }
  });
  erpOrigin = `http://127.0.0.1:${erp.port}`;
  assistantOrigin = `http://localhost:${assistant.port}`;
  return {
    erpOrigin,
    entry: `${erpOrigin}/k3cloud/html5/index.aspx`,
    assistantOrigin,
    /** What the ERP holds from now on: the invoices it recognises, and its master data. */
    stock(next: Partial<typeof stock>) { Object.assign(stock, next); },
    /** Hold every 发票导入单据 click until `hook` resolves: the click's own `Input.dispatchMouseEvent` waits with it. */
    onImportClick(hook: () => Promise<void>) { importClick = hook; },
    close: async () => { await close(erp.server); await close(assistant.server); },
  };
}

/** A page Chrome refuses to put in a frame, and refuses to let an extension debug. */
const RESTRICTED_URL = 'chrome://version';

/**
 * Chrome takes the extension's debugger away from the tab `page` is, and nothing else changes: the page, its form and
 * its assistant stay exactly as they were.
 *
 * The employee's way is 取消 on the "started debugging this browser" banner, which Chromium without a UI does not draw.
 * This is Chrome's other way, measured on Playwright's Chromium 2026-09-21: a frame of an attached tab navigating to a
 * URL no extension may debug makes Chrome detach the extension from the whole tab, raising the same
 * `chrome.debugger.onDetach` (reason `target_closed` where the banner gives `canceled_by_user`; the extension treats
 * both alike), and the tab can be attached again straight away. The extension's own `chrome.debugger.detach` is no
 * substitute: Chrome raises no `onDetach` for it (measured the same day).
 */
export async function detachLikeChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.name = 'harness-detach';
    document.body.appendChild(frame);
  });
  // Chrome refuses the navigation itself (ERR_BLOCKED_BY_RESPONSE); the detach happens on the way.
  await page.frame({ name: 'harness-detach' })?.goto(RESTRICTED_URL).catch(() => undefined);
  await page.evaluate(() => document.querySelector('iframe[name="harness-detach"]')?.remove());
}

export const fillPlan = (erpOrigin: string, overrides: Partial<FillPlan> = {}): FillPlan => ({
  protocolVersion: PROTOCOL_VERSION, kind: 'fill', jobId: 'harness-job-1', taskId: 'harness-task-1', erpOrigin,
  compatibility: { erpBuild: PAGE.erpBuild, formId: PAGE.formId },
  catalog: { projects: PROJECTS.map(({ code, name }) => ({ code, name })), expenseItems: EXPENSE_ITEMS.map(({ code, name }) => ({ code, name })) },
  invoices: [{ sha256: '0'.repeat(64), fileName: '铁路电子客票.pdf', mime: 'application/pdf' }],
  purpose: '客户支持', ...overrides,
});

/** How the stand-in app answers an executor event. `defaultReply` answers as the server's channel does. */
export type EventReply = (event: ExecutorEvent) => Promise<unknown>;

const defaultReply: EventReply = async (event) => {
  if (event.type === 'attempt_started') return { persisted: true };
  // The stand-in cannot judge a read-back; the real server's judge is #259's.
  if (event.type === 'readback') return { ok: false, reasons: ['测试替身不判定回读'] };
  return null;
};

export type FakeBaox = Awaited<ReturnType<typeof fakeBaox>>;

/**
 * The app, as far as the extension can tell: it redeems a 配对码 (pairing code), accepts the channel, and asks for
 * a 去报销 with #254's `erp.fill`, answering each `erp.event` the way the server's channel would.
 */
export async function fakeBaox({ accountId = 'harness-account' } = {}) {
  const events: ExecutorEvent[] = [];
  let reply: EventReply = defaultReply;
  let socket: WebSocket | null = null;
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => { markConnected = resolve; });
  const pending = new Map<string, (message: Extract<ChannelMessage, { type: 'response' }>) => void>();
  let seq = 0;

  const { server, port } = await listen(async (request, response) => {
    if (request.method === 'POST' && request.url === EXTENSION_PAIR_PATH) {
      await bodyOf(request);
      send(response, 200, 'application/json', JSON.stringify({ token: 'harness-token', accountId }));
    } else {
      send(response, 404, 'text/plain', 'not found');
    }
  });
  const channel = new WebSocketServer({ server, path: EXTENSION_CHANNEL_PATH });
  const write = (ws: WebSocket, message: ChannelMessage) => ws.send(JSON.stringify(message));

  channel.on('connection', (ws) => {
    ws.on('message', async (data) => {
      const message = ChannelMessageSchema.parse(JSON.parse(String(data)));
      if (message.type === 'hello') {
        socket = ws;
        write(ws, { type: 'ready', accountId, heartbeatMs: EXTENSION_HEARTBEAT_MS });
        markConnected();
      } else if (message.type === 'response') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else if (message.type === 'request') {
        if (message.method === 'ping') return write(ws, { type: 'response', id: message.id, ok: true, payload: null });
        if (message.method !== EXECUTOR_METHODS.event) return write(ws, { type: 'response', id: message.id, ok: false, error: { code: 'unknown_method', message: message.method } });
        const { event } = message.payload as { event: ExecutorEvent };
        events.push(event);
        write(ws, { type: 'response', id: message.id, ok: true, payload: (await reply(event)) ?? null });
      }
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    events,
    connected,
    /** Answer the executor's events with `next` from now on; it may also stall, to look at the browser mid-run. */
    answerWith(next: EventReply) { reply = next; },
    defaultReply,
    /** One 去报销, as #254's remote executor sends it. Resolves with the job's result event. */
    fill(plan: FillPlan): Promise<ResultEvent> {
      if (!socket) throw new Error('the extension is not connected');
      seq += 1;
      const id = `s${seq}`;
      const answer = new Promise<ResultEvent>((resolve, reject) => {
        pending.set(id, (message) => (message.ok ? resolve(message.payload as ResultEvent) : reject(new Error(message.error.message))));
      });
      write(socket, { type: 'request', id, method: EXECUTOR_METHODS.fill, payload: { plan, trigger: 'start' } });
      return answer;
    },
    close: async () => {
      for (const client of channel.clients) client.terminate();
      channel.close();
      await close(server);
    },
  };
}

/** Build the origin-less extension template (#258) into the package's `dist/`, where the server's download reads it. */
export function buildExtensionTemplate(): string {
  const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: extensionRoot, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`extension build failed: ${built.stderr}`);
  return join(extensionRoot, 'dist');
}

/**
 * The extension as a directory Chromium can load, speaking to `origin` and nothing else: the build's origin-less
 * template, stamped with `origin`. The cases on the real server download the zip instead (`app.ts`), as an employee
 * installs it.
 */
export function unpackedExtension(origin: string): { dir: string; remove(): void } {
  const template = buildExtensionTemplate();
  const dir = mkdtempSync(join(tmpdir(), 'baox-extension-'));
  cpSync(template, dir, { recursive: true });
  // The build leaves an origin-less template (#258); this stamps an unpacked copy by the same rule the server's
  // download stamps its zip with (`src/template.ts`).
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, name);
    if (!statSync(path).isFile() || !carriesOrigin(name)) continue;
    writeFileSync(path, stampOrigin(readFileSync(path, 'utf8'), origin));
  }
  const problem = stampedManifestProblem(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { host_permissions?: unknown }, origin);
  if (problem) throw new Error(problem);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Chromium (Playwright's own build: branded Chrome no longer loads unpacked extensions) with one extension loaded. */
export async function launchWithExtension(dir: string): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  return { context, worker, extensionId: new URL(worker.url()).host };
}

/** Pair through the popup with `code`, as an employee does, and wait for `connected`. */
export async function pair(context: BrowserContext, extensionId: string, code: string, connected: () => Promise<void>): Promise<void> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill('#code', code);
  await popup.click('#pair');
  await connected();
  await popup.close();
}

export type Launched = Awaited<ReturnType<typeof launchWithExtension>>;

/**
 * The harness as Playwright fixtures: `erp` (the served fake ERP; `erpLoggedIn` picks which page it serves), `baox`
 * (the stand-in app) and `extension` (Chromium with the extension built for `baox`, paired and connected).
 */
export const test = base.extend<{ erpLoggedIn: boolean; erp: ErpSites; baox: FakeBaox; extension: Launched }>({
  erpLoggedIn: [true, { option: true }],
  erp: async ({ erpLoggedIn }, use) => {
    const sites = await serveErpSites({ loggedIn: erpLoggedIn });
    await use(sites);
    await sites.close();
  },
  baox: async ({}, use) => {
    const app = await fakeBaox();
    await use(app);
    await app.close();
  },
  extension: async ({ baox }, use) => {
    const unpacked = unpackedExtension(baox.origin);
    const launched = await launchWithExtension(unpacked.dir);
    await pair(launched.context, launched.extensionId, 'HARNESS2', () => baox.connected);
    await use(launched);
    await launched.context.close();
    unpacked.remove();
  },
});
