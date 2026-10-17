// S1–S7 of docs/design/erp-headless-v1.md §验证计划, each a function that observes and returns a verdict. The ERP
// steps are the executor's own (`steps.ts`, `reader.ts`, `tabs.ts`, `catalog.ts`); what is new here is only the
// measuring around them. Read-only except S4's import into an unsaved form (discarded afterwards) and S5's 暂存,
// which runs only with --save.
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect as tcpConnect } from 'node:net';
import type { Interface } from 'node:readline/promises';
import { evalIn, type CdpSession } from '@baox/erp-executor/cdp';
import { EXPENSE_ITEM_FORM, isSafeKey, queryRows } from '@baox/erp-executor/catalog';
import { compareDraft, findDrafts, lookupDraft, pressDraft as pressDraftGateway, viewDraft, waitDrafted } from '@baox/erp-executor/draft';
import { writeHeader, type Grid } from '@baox/erp-executor/erpform';
import { readPane } from '@baox/erp-executor/invoice-grid';
import { sleep, waitFor } from '@baox/erp-executor/pace';
import { COMPATIBILITY_SNIPPET } from '@baox/erp-executor/probe';
import { checkRerun } from '@baox/erp-executor/occupancy';
import { INVOICE_NO, markedPurpose } from '@baox/erp-executor/protocol';

// The field S11 puts through the executor's shipped occupancy check (ADR-0034), until one passes live.
const OCCUPANCY_CANDIDATE = 'FRecInv.FIVNUMBER';
import { protocolReadings, readForm, readHeaderField } from '@baox/erp-executor/reader';
import { importInvoices, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from '@baox/erp-executor/steps';
import { closeFormTab, tabActions } from '@baox/erp-executor/tabs';
import { launchHeadless, loadInTab, memAvailableMb, type Headless, type MemoryPeak } from './browser';
import { caption, deleteDraft, dialogs, FORM, formFields, knownNotices, login, logout, observe, pressDraft, responseStatus, shape, viewBill, type LoginOutcome } from './erp';
import type { Observations, Report, Verdict } from './report';

// Where the invoice assistant lives. The executor only ever matches `piaozone` in a frame URL (steps.ts); these are
// the two entry pages the recordings and the extension's e2e harness have seen it load.
export const PIAOZONE_URLS = ['https://www.piaozone.com/m4-web/fpzs/index', 'https://www.piaozone.com/pwy-assistant/index.html'];
const MEMORY_LIMIT_MB = 500;

export type Ctx = {
  report: Report;
  origin: string; entry: string; erpBuild: string;
  account: string; password: string; tenant: string | null;
  chromium: string | null; invoice: string | null; invoiceNos: string[];
  save: boolean; bill: string | null; concurrency: number; interactive: boolean;
  /** --prefetch: warm the HTTP cache with the console's scripts before each login (spike/erp.ts PREFETCH). */
  prefetch: boolean;
  /** The headless session S1 starts and S2–S6 share. */
  main: Headless | null; mainLogin: LoginOutcome | null;
  /** S4's form is open (unsaved) and must be discarded; S4 passed; S4's recognised invoice numbers, in memory only. */
  formOpen: boolean; s4Passed: boolean; s4InvoiceNos: string[];
  draftBillNo: string | null;
  /** S9: list the 暂存 drafts created at or after this ERP-local time. S10: the draft to delete must be this recent. */
  draftsSince: string;
  /** S10: the 内码 of the one test draft to delete (--delete-draft), or null. */
  deleteDraft: string | null;
  mainMemory: MemoryPeak | null; mainCrashes: string[];
  /** Every browser started, and which of them are signed in, so teardown misses none. */
  sessions: Set<Headless>; signedIn: Set<Headless>;
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const originOf = (url: unknown) => { try { return new URL(String(url)).origin; } catch { return null; } };
const dataRows = (grid: Grid) => (grid.ok ? grid.rows.filter((row) => row.kind === 'data') : []);

// ---------------------------------------------------------------------------------------------------------------
// S1

async function reach(url: string) {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  let t = Date.now();
  const dns = await lookup(u.hostname, { all: true }).then((a) => ({ ok: a.length > 0, addresses: a.length, ms: Date.now() - t }))
    .catch((e: Error) => ({ ok: false, addresses: 0, ms: Date.now() - t, error: e.message }));
  t = Date.now();
  const tcp = await new Promise<{ ok: boolean; ms: number; error?: string }>((done) => {
    const socket = tcpConnect({ host: u.hostname, port });
    const end = (ok: boolean, error?: string) => { socket.destroy(); done(error ? { ok, ms: Date.now() - t, error } : { ok, ms: Date.now() - t }); };
    socket.setTimeout(8000, () => end(false, 'timeout'));
    socket.once('connect', () => end(true));
    socket.once('error', (e) => end(false, e.message));
  });
  t = Date.now();
  const http = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    .then((r) => ({ ok: r.status > 0 && r.status < 500, status: r.status, ms: Date.now() - t, redirectsTo: originOf(r.headers.get('location')) }))
    .catch((e: Error) => ({ ok: false, status: 0, ms: Date.now() - t, redirectsTo: null, error: String(e.cause ?? e.message) }));
  return { url: `${u.origin}${u.pathname}`, dns, tcp, http, ok: dns.ok && tcp.ok && http.ok };
}

/** S1: both origins answer from this host, and both pages load in headless Chromium. Starts the main session. */
export async function s1(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const net = [await reach(ctx.entry), ...(await Promise.all(PIAOZONE_URLS.map(reach)))];
  obs['network'] = net;
  const down = net.filter((n) => !n.ok).map((n) => n.url);
  const main = await ensureMain(ctx, obs);
  const loginPage = await waitFor(() => observe(main.session, ctx.origin), (o) => o.verdict === 'not_logged_in' || o.verdict === 'matched', 60_000, 1000);
  await ctx.report.shot(main.session, 'erp-login-page');
  obs['erpPage'] = { verdict: loginPage.verdict, ready: loginPage.observed?.ready ?? null, titleLength: loginPage.observed?.title?.length ?? 0 };
  const piaozone = await loadInTab(main.port, PIAOZONE_URLS[0]!, { shot: (s) => ctx.report.shot(s, 'piaozone') }).catch((e: Error) => ({ loaded: false, error: e.message }));
  obs['piaozonePage'] = piaozone;
  const erpLoaded = loginPage.verdict === 'not_logged_in' || loginPage.verdict === 'matched';
  if (down.length || !erpLoaded || !piaozone.loaded) {
    return { status: 'FAIL', reason: [down.length ? `连不通：${down.join('、')}` : '', !erpLoaded ? `ERP 登录页没有在无头浏览器里加载出来（${loginPage.verdict}）` : '', !piaozone.loaded ? '发票助手页面没有在无头浏览器里加载出来' : ''].filter(Boolean).join('；') };
  }
  return { status: 'PASS', reason: `ERP 与 piaozone 均可连通；无头浏览器启动 ${secs(main.launchMs)}，两边页面都加载完成` };
}

/** The main headless session, started on first need. */
export async function ensureMain(ctx: Ctx, obs?: Observations): Promise<Headless> {
  if (ctx.main) return ctx.main;
  if (process.getuid?.() === 0) ctx.report.note('以 root 运行：Chromium 在 root 下不加 --no-sandbox 会拒绝启动；请换普通用户运行');
  const main = await launchHeadless({ label: 'main', openUrl: ctx.entry, origin: ctx.origin, chromium: ctx.chromium });
  ctx.sessions.add(main);
  ctx.main = main;
  if (obs) obs['launch'] = { ms: main.launchMs, cdpPort: main.port, pidKnown: main.pid !== null };
  return main;
}

/** The main session, signed in. S4–S6 call this so that `--only S4` still has a session to work in. */
export async function signedInMain(ctx: Ctx): Promise<Headless> {
  const main = await ensureMain(ctx);
  if (ctx.mainLogin?.ok) return main;
  const outcome = await signIn(ctx, main);
  if (!outcome.ok) throw new Error(`没有登录上 ERP：${outcome.why}`);
  return main;
}

async function signIn(ctx: Ctx, h: Headless) {
  const outcome = await login(h.session, { origin: ctx.origin, account: ctx.account, password: ctx.password, trace: h.trace, prefetch: ctx.prefetch, shot: (name) => ctx.report.shot(h.session, `${h.label}-${name}`) });
  ctx.report.secret(outcome.displayName);
  if (outcome.ok) ctx.signedIn.add(h);
  if (h === ctx.main) ctx.mainLogin = outcome;
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------
// S2

/** S2: password login in a fresh profile, with no second factor, a known 账套, and a usable console. */
export async function s2(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const main = await ensureMain(ctx, obs);
  const outcome = await signIn(ctx, main);
  obs['login'] = {
    ok: outcome.ok, why: outcome.why, ms: outcome.ms, formMs: outcome.formMs, consoleMs: outcome.consoleMs,
    loginPageSecondFactorLike: outcome.loginPage?.secondFactor ?? [], newSecondFactor: outcome.newSecondFactor,
    alreadyOnline: outcome.alreadyOnline, errors: outcome.errors, verdict: outcome.verdict,
    dataCentre: outcome.loginPage?.dataCentre ?? null,
    initialised: outcome.initialised, reloads: outcome.reloads, submits: outcome.submits, prefetch: outcome.prefetch, languageMissing: outcome.languageMissing,
    noEffect: outcome.noEffect, timeline: outcome.timeline, diagnostics: outcome.diagnostics, pageState: outcome.pageState,
    identity: { displayName: !!outcome.displayName, account: !!outcome.account, tenant: !!outcome.tenant, accountMatches: outcome.account === ctx.account },
  };
  await ctx.report.shot(main.session, 'console');
  if (!outcome.ok) {
    return { status: 'FAIL', reason: outcome.newSecondFactor.length ? `出现验证码或短信校验：${outcome.newSecondFactor.join('、')}` : outcome.why };
  }
  const tenantMatches = ctx.tenant ? outcome.tenant === ctx.tenant : null;
  const dc = outcome.loginPage?.dataCentre;
  const dcNote = dc?.visible ? `登录页有数据中心选择（${dc.options} 项），按默认项登录` : '登录页没有可见的数据中心选择';
  obs['dataCentre'] = { note: dcNote, tenantRead: !!outcome.tenant, tenantMatchesEnv: tenantMatches };

  const compat = await evalIn<{ erpBuild: string | null }>(main.session, COMPATIBILITY_SNIPPET).catch(() => null);
  obs['erpBuild'] = { read: compat?.erpBuild ?? null, expected: ctx.erpBuild, matches: compat?.erpBuild === ctx.erpBuild };
  const started = Date.now();
  const query = await queryRows(main.session, { formId: EXPENSE_ITEM_FORM, fieldKeys: 'FNumber', limit: 1 });
  obs['webapi'] = query.ok ? { ok: true, rows: query.rows.length, ms: Date.now() - started } : { ok: false, reason: query.reason };

  if (!outcome.tenant) return { status: 'FAIL', reason: '登录成功但读不出账套' };
  if (tenantMatches === false) return { status: 'FAIL', reason: `${dcNote}，落在了另一个账套（与 BAOX_ERP_TEST_TENANT 不符）：凭据需要多存一个账套字段，并在登录页选择` };
  if (!query.ok) return { status: 'FAIL', reason: `主控台读得出身份，但只读 WebAPI 查询失败：${query.reason}` };
  const kicked = outcome.alreadyOnline.seen ? '；登录时出现「该帐号已登录在线」并已确认' : '';
  return { status: 'PASS', reason: `${secs(outcome.ms)} 进入主控台，无验证码或短信校验；${dcNote}${tenantMatches ? '，账套与 BAOX_ERP_TEST_TENANT 一致' : ''}${kicked}` };
}

// ---------------------------------------------------------------------------------------------------------------
// S4 (and S7's concurrent jobs)

/**
 * One invoice through the executor's own steps, into an unsaved 新增 form: open the form, open the assistant with
 * 不生成费用明细, upload, recognise, tick, 发票导入单据, and read the 收票网格 back. The caller discards the form.
 */
async function importOne(ctx: Ctx, h: Headless, obs: Observations, keepNumbers: boolean) {
  const page: WritePage = { session: h.session };
  const shot = (name: string) => ctx.report.shot(h.session, `${h.label}-${name}`);
  let t = Date.now();
  await openNewReimbursement(page, { timeoutMs: 60_000 });
  if (h === ctx.main) ctx.formOpen = true;
  obs['openFormMs'] = Date.now() - t;
  await shot('new-form');
  t = Date.now();
  const assistant = await openInvoiceAssistant(page, { timeoutMs: 90_000 });
  const modeConfirmed = String(assistant.hitBefore ?? '').endsWith('tbNotFillEntry') && assistant.menuOpenAfter === false;
  obs['assistant'] = {
    ms: Date.now() - t, mode: assistant.mode, modeConfirmed, hitBefore: assistant.hitBefore, hitAfter: assistant.hitAfter,
    frameOrigins: [...new Set((page.children?.list() ?? []).map((info) => originOf(info['url'])).filter(Boolean))],
  };
  await shot('assistant');
  t = Date.now();
  const upload = await uploadInvoices(page, [ctx.invoice!]);
  obs['upload'] = { ms: Date.now() - t, selectedRows: upload.selectedRows, panes: upload.panes };
  const frame = await page.children?.waitFor((url) => url.includes('piaozone'), { timeout: 5000, interval: 300 });
  if (frame && keepNumbers) {
    // The recognised 发票号码 stay in this process for S6; only their count is reported.
    const pane = await readPane(frame).catch(() => null);
    ctx.s4InvoiceNos = (pane?.rows ?? []).map((row) => row.key ?? '').filter(Boolean);
    obs['invoiceNumbersRead'] = ctx.s4InvoiceNos.length;
  }
  await shot('recognised');
  t = Date.now();
  const imported = await importInvoices(page, { expectedRows: 1 });
  obs['import'] = { ms: Date.now() - t, reportClosed: imported.reportClosed, stillOpen: imported.stillOpen.length };
  const grid = await readForm(h.session);
  const rows = dataRows(grid.receiptsGrid);
  obs['receipts'] = { readable: grid.receiptsGrid.ok, rows: rows.length, columns: grid.receiptsGrid.ok ? grid.receiptsGrid.columns.map((c) => c.label) : [], formMode: grid.formMode.value };
  await shot('imported');
  return { modeConfirmed, receiptRows: rows.length };
}

/** S4: upload, recognise and import one test invoice in headless, into an unsaved form that is then discarded. */
export async function s4(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const main = await signedInMain(ctx);
  obs['boundary'] = '发票导入单据会让 ERP 生成或覆盖这张发票的收票单（ADR-0025/0026）；费用报销单本身不保存，检查结束后不保存关闭';
  ctx.report.say('S4 会在一张不保存的新增单里导入测试发票。ERP 会为这张发票生成或覆盖收票单（ADR-0026），费用报销单本身不保存，结束后关闭并选「否」。');
  const result = await importOne(ctx, main, obs, true);
  if (!result.modeConfirmed) return { status: 'FAIL', reason: '「不生成费用明细」点击后没有核实到落点（见 assistant.hitBefore / hitAfter）' };
  if (result.receiptRows !== 1) return { status: 'FAIL', reason: `导入后收票网格回读到 ${result.receiptRows} 行，期望 1 行` };
  ctx.s4Passed = true;
  return { status: 'PASS', reason: '1 张测试发票上传、识别、导入成功，收票网格回读 1 行；表单尚未保存' };
}

/** Close every 费用报销单 tab on the page, answering 是否保存 with 否 and never 是 (tabs.ts `closeFormTab`). */
export async function discardForms(ctx: Ctx, h: Headless): Promise<string[]> {
  const actions = tabActions(h.session);
  const notes: string[] = [];
  for (const tab of (await actions.tabs().catch(() => [])).filter((t) => t.isForm)) {
    const outcome = await closeFormTab(actions, tab.id);
    notes.push(`${h.label}: 关闭「${tab.text}」：${outcome.closed ? '已关闭' : '没有关掉'}（${outcome.note}）`);
  }
  if (h === ctx.main) ctx.formOpen = false;
  return notes;
}

// ---------------------------------------------------------------------------------------------------------------
// S5

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '').replace(/,/g, '');
const asNumber = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** Every scalar a model row holds, normalised, two levels into its references (a 基础资料 field is {Id, Number, Name}). */
function modelValues(row: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 3 || row === null || row === undefined) return out;
  if (typeof row === 'string') out.add(norm(row));
  else if (typeof row === 'number') { out.add(String(row)); out.add(row.toFixed(2)); }
  else if (Array.isArray(row)) for (const v of row) modelValues(v, out, depth + 1);
  else if (typeof row === 'object') for (const v of Object.values(row as Record<string, unknown>)) modelValues(v, out, depth + 1);
  return out;
}

/** Can a page cell's text be found among the model row's values? Numbers compare to the cent, dates by prefix. */
function found(cell: string, values: Set<string>): boolean {
  const n = norm(cell);
  if (values.has(n)) return true;
  const x = asNumber(n);
  for (const v of values) {
    if (x !== null) { const y = asNumber(v); if (y !== null && Math.abs(x - y) < 0.005) return true; }
    if (n.length >= 8 && v.startsWith(n)) return true;
  }
  return false;
}

/** Row i of the page against row i of the model, column by column: counts only, never the values. */
function compareGrid(grid: Grid, model: unknown[] | null) {
  const rows = dataRows(grid);
  const filled = rows.filter((row) => Object.values(row.values).some((v) => String(v ?? '').trim() !== ''));
  const columns: Record<string, { cells: number; found: number }> = {};
  filled.forEach((row, i) => {
    const values = modelValues(model?.[i]);
    for (const [label, value] of Object.entries(row.values)) {
      if (!String(value ?? '').trim() || label === '序号' || !label) continue;
      const c = (columns[label] ??= { cells: 0, found: 0 });
      c.cells += 1;
      if (found(value, values)) c.found += 1;
    }
  });
  const unmatched = Object.entries(columns).filter(([, c]) => c.found < c.cells).map(([label]) => label);
  return { pageRows: rows.length, pageFilledRows: filled.length, modelRows: model?.length ?? null, columns, unmatched };
}

const modelKey = (data: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const hit = Object.keys(data).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit) return data[hit];
  }
  return undefined;
};

/** S5: 暂存 (with --save only), then View; head and entries must agree with the page read-back. */
export async function s5(ctx: Ctx, obs: Observations): Promise<Verdict> {
  if (!ctx.save) {
    if (!ctx.bill) return { status: 'SKIP', reason: '没有 --save，不暂存（这是唯一会在 ERP 留下单据的一步）' };
    // Read-only consolation: prove View answers on an existing bill, shapes only.
    const main = await signedInMain(ctx);
    const view = await viewBill(main.session, ctx.bill);
    const data = view.data ?? {};
    obs['viewOfBill'] = {
      httpStatus: view.httpStatus, ms: view.ms, ok: !!view.data, status: view.status,
      headFields: Object.values(data).filter((v) => !Array.isArray(v)).length,
      entries: Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])),
    };
    return { status: 'SKIP', reason: `没有 --save，不暂存；只读验证了 --bill 的 View：${view.data ? '能读到整张单' : '没有读到'}` };
  }
  if (!ctx.s4Passed || !ctx.formOpen) return { status: 'SKIP', reason: '需要 S4 先通过：暂存的是 S4 导入了测试发票、尚未保存的那张单' };
  const main = await signedInMain(ctx);
  ctx.report.say('S5 将点「暂存」，在 ERP 里留下一张测试草稿。只点暂存，不点保存、提交、审核、删除。');
  await ctx.report.shot(main.session, 'before-draft');
  const pressed = await pressDraft(main.session);
  obs['press'] = { ok: pressed.ok, controlId: pressed.id, how: pressed.how, toolbar: pressed.items };
  if (!pressed.ok) return { status: 'FAIL', reason: `没有点「暂存」：${pressed.why}` };
  const started = Date.now();
  const bill = await waitFor(() => readHeaderField(main.session, 'FBILLNO'), (r) => r.ok && r.value.trim() !== '', 60_000, 1000);
  obs['draftMs'] = Date.now() - started;
  obs['dialogsAfterDraft'] = await dialogs(main.session);
  await ctx.report.shot(main.session, 'after-draft');
  if (!bill.ok || !bill.value.trim()) return { status: 'FAIL', reason: `点「暂存」后 60 秒读不到单据编号（${bill.ok ? '编号为空' : bill.reason}）` };
  const billNo = bill.value.trim();
  ctx.draftBillNo = billNo;
  obs['draftBillNo'] = billNo;
  console.log(`\n[spike] S5 测试草稿的单据编号：${billNo}\n[spike] 请在 ERP 里找到这张暂存单并手工删除它。脚本不会删除任何单据。\n`);

  const page = await readForm(main.session);
  const pageCause = await readHeaderField(main.session, 'FCAUSA');
  const view = await viewBill(main.session, billNo);
  obs['view'] = { httpStatus: view.httpStatus, ms: view.ms, ok: !!view.data, status: view.status };
  if (!view.data) return { status: 'FAIL', reason: `暂存成功（单据编号已打印在上面），但 View 没有读回这张单：${view.status?.errors.join('；') ?? view.httpStatus}` };
  const data = view.data;
  const status = modelKey(data, 'DocumentStatus', 'FDocumentStatus');
  const modelCause = modelKey(data, 'Causa', 'FCausa');
  const head = {
    billNoMatches: norm(modelKey(data, 'BillNo', 'FBillNo')) === norm(billNo),
    pageBillNoMatches: page.billNo.value === billNo,
    documentStatus: typeof status === 'string' ? status : shape(status),
    causaMatches: pageCause.ok ? norm(caption(modelCause)) === norm(pageCause.value) : null,
    headFields: Object.values(data).filter((v) => !Array.isArray(v)).length,
  };
  const receipts = compareGrid(page.receiptsGrid, (modelKey(data, 'RecInvInfo') as unknown[] | undefined) ?? null);
  const detail = compareGrid(page.detailGrid, (modelKey(data, 'ER_ExpenseReimbEntry') as unknown[] | undefined) ?? null);
  obs['compare'] = { head, receipts, detail, entries: Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])) };

  const problems = [
    !head.billNoMatches ? 'View 的单据编号与页面不一致' : '',
    head.causaMatches === false ? '事由与页面不一致' : '',
    receipts.modelRows !== receipts.pageFilledRows ? `收票分录：页面 ${receipts.pageFilledRows} 行，View ${receipts.modelRows ?? '没有'} 行` : '',
    detail.pageFilledRows > 0 && detail.modelRows !== detail.pageFilledRows ? `费用明细：页面 ${detail.pageFilledRows} 行，View ${detail.modelRows ?? '没有'} 行` : '',
    receipts.unmatched.length ? `收票网格这些列的值在 View 里找不到：${receipts.unmatched.join('、')}` : '',
    detail.unmatched.length ? `费用明细这些列的值在 View 里找不到：${detail.unmatched.join('、')}` : '',
  ].filter(Boolean);
  if (problems.length) return { status: 'FAIL', reason: `${problems.join('；')}（列名对不上也可能只是显示列，见 report.json 的 compare）` };
  return { status: 'PASS', reason: `暂存后 ${secs(Number(obs['draftMs']))} 拿到单据编号，单据状态 ${head.documentStatus}；表头与 ${receipts.pageFilledRows} 行收票分录和页面回读一致。请手工删除这张测试草稿` };
}

// ---------------------------------------------------------------------------------------------------------------
// S6

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** S6: can ExecuteBillQuery tell whether an invoice is held by a bill of this account? */
export async function s6(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const main = await signedInMain(ctx);
  const meta = await formFields(main.session);
  obs['metadata'] = { httpStatus: meta.httpStatus, status: meta.status, entities: meta.entities.map((e) => `${e.key}「${e.name}」 fields=${e.fields.length}`) };
  const candidates = meta.entities.flatMap((e) => e.fields.filter((f) => /发票号码|发票号|票据号码/.test(f.name)).map((f) => ({ entity: e.key, entityName: e.name, key: f.key, name: f.name })));
  obs['candidates'] = candidates.map((c) => `${c.entity}.${c.key}「${c.name}」`);
  const receiptEntity = meta.entities.find((e) => /收票/.test(e.name) || /RecInv/i.test(e.key));
  if (receiptEntity) obs['receiptEntityFields'] = receiptEntity.fields.map((f) => `${f.key}「${f.name}」`);
  const inReceipts = candidates.filter((c) => c.entity === receiptEntity?.key);
  const pick = inReceipts.length === 1 ? inReceipts[0]! : candidates.length === 1 ? candidates[0]! : null;
  if (!pick || !FIELD_KEY.test(pick.key)) {
    return { status: 'FAIL', reason: `field keys unknown：元数据里${candidates.length ? `有 ${candidates.length} 个发票号码候选字段，认不出用哪个` : '没有标题含「发票号码」的字段'}，没有猜。候选见 report.json 的 candidates / receiptEntityFields` };
  }
  obs['fieldKey'] = `${pick.entity}.${pick.key}「${pick.name}」`;

  type Probe = { source: string; no: string; expect: string | null };
  const probes: Probe[] = [
    ...ctx.invoiceNos.map((no) => ({ source: '--invoice-no', no, expect: null })),
    ...ctx.s4InvoiceNos.map((no) => ({ source: 'S4', no, expect: ctx.draftBillNo })),
  ];
  if (ctx.bill && isSafeKey(ctx.bill)) {
    // Positive control: the invoices of a bill the owner named must come back as held by that bill.
    const own = await queryRows(main.session, { formId: FORM, fieldKeys: pick.key, filter: `FBillNo = '${ctx.bill}'`, limit: 50 });
    obs['billControl'] = own.ok ? { ok: true, invoiceRows: own.rows.length } : { ok: false, reason: own.reason };
    if (own.ok) for (const row of own.rows) if (row[0]) probes.push({ source: '--bill', no: String(row[0]), expect: ctx.bill });
  }
  const usable = probes.filter((p) => isSafeKey(p.no));
  if (!usable.length) return { status: 'SKIP', reason: '没有可查的发票号码：给 --invoice-no，或带 --invoice 跑 S4，或给 --bill <一张有发票的已保存单据>' };

  const results: Observations[] = [];
  let controls = 0;
  let controlHits = 0;
  for (const [i, p] of usable.entries()) {
    const started = Date.now();
    const res = await queryRows(main.session, { formId: FORM, fieldKeys: 'FBillNo,FDocumentStatus', filter: `${pick.key} = '${p.no}'`, limit: 20 });
    if (!res.ok) { results.push({ invoice: i + 1, source: p.source, ok: false, reason: res.reason }); continue; }
    const holders = res.rows.map((row) => ({ billNo: String(row[0] ?? ''), status: String(row[1] ?? '') }));
    const statuses: Record<string, number> = {};
    for (const h of holders) statuses[h.status || '?'] = (statuses[h.status || '?'] ?? 0) + 1;
    const hit = p.expect ? holders.some((h) => h.billNo === p.expect) : null;
    if (p.expect) { controls += 1; if (hit) controlHits += 1; }
    results.push({ invoice: i + 1, source: p.source, ok: true, ms: Date.now() - started, heldBy: holders.length, statuses, expectedHolderFound: hit });
  }
  obs['lookups'] = results;
  obs['note'] = 'ExecuteBillQuery 按当前账号的权限返回；DocumentStatus：Z 暂存 / A 创建 / B 审核中 / C 已审核 / D 重新审核';
  const refused = results.filter((r) => r['ok'] === false);
  if (refused.length) return { status: 'FAIL', reason: `按 ${pick.key} 查询被 ERP 拒绝：${String(refused[0]!['reason'])}` };
  if (!controls) return { status: 'SKIP', reason: `按 ${pick.key} 能查（${results.length} 张发票），但没有已知占用的对照来证明查得准：用 --bill 或 --save 再跑` };
  if (controlHits < controls) return { status: 'FAIL', reason: `按 ${pick.key} 查询，${controls} 个已知占用只命中 ${controlHits} 个` };
  return { status: 'PASS', reason: `按 ${pick.entity}.${pick.key} 用 ExecuteBillQuery 能查到发票被哪张单据占用（${controls} 个已知占用全部命中）` };
}

// ---------------------------------------------------------------------------------------------------------------
// S9

const statusOf = (v: unknown) => (typeof v === 'string' ? v : shape(v));
const SINCE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

/**
 * S9, read-only: the 暂存 drafts created since `--drafts-since`, found with ExecuteBillQuery and read back with View by
 * 内码. A draft may carry no 单据编号 (S5 on 2026-10-12: the form turned into 修改 but FBillNo stayed empty), so the
 * 内码 is what finds it again. Prints 内码, whether a 单据编号 exists, and the creation time — what the owner needs to
 * delete it — and the 事由's length only.
 */
export async function s9(ctx: Ctx, obs: Observations): Promise<Verdict> {
  if (!SINCE.test(ctx.draftsSince)) return { status: 'FAIL', reason: `--drafts-since 不是「YYYY-MM-DD[ HH:mm[:ss]]」：${ctx.draftsSince}` };
  const main = await signedInMain(ctx);
  const filter = `FDocumentStatus = 'Z' AND FCreateDate >= '${ctx.draftsSince}'`;
  let fields = 'FID,FBillNo,FCreateDate,FCausa';
  let res = await queryRows(main.session, { formId: FORM, fieldKeys: fields, filter, limit: 20 });
  if (!res.ok) {
    obs['firstQuery'] = { fields, reason: res.reason };
    fields = 'FID,FBillNo,FCreateDate';
    res = await queryRows(main.session, { formId: FORM, fieldKeys: fields, filter, limit: 20 });
  }
  obs['query'] = { fields, filter, ok: res.ok, ...(res.ok ? { rows: res.rows.length } : { reason: res.reason }) };
  if (!res.ok) return { status: 'FAIL', reason: `ExecuteBillQuery 查暂存单被拒绝：${res.reason}` };
  const drafts = [];
  for (const row of res.rows.slice(0, 5)) {
    const id = String(row[0] ?? '');
    const view = id ? await viewBill(main.session, id, { byId: true }) : null;
    const data = view?.data ?? null;
    drafts.push({
      fid: id, billNo: String(row[1] ?? '').trim() || null, createdAt: String(row[2] ?? ''), causaLength: row[3] === undefined ? null : String(row[3] ?? '').length,
      viewById: view ? { httpStatus: view.httpStatus, ms: view.ms, ok: !!data, errors: view.status?.errors ?? [] } : null,
      model: data ? {
        documentStatus: statusOf(modelKey(data, 'DocumentStatus', 'FDocumentStatus')),
        billNo: shape(modelKey(data, 'BillNo', 'FBillNo')),
        entries: Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])),
      } : null,
    });
  }
  obs['drafts'] = drafts;
  for (const d of drafts) console.log(`[spike] S9 暂存单：内码 ${d.fid}，单据编号 ${d.billNo ?? '（空）'}，创建于 ${d.createdAt}，View 按内码${d.viewById?.ok ? '读到了' : '没有读到'}`);
  if (!drafts.length) return { status: 'FAIL', reason: `${ctx.draftsSince} 之后没有查到暂存单（这个账号权限内）` };
  const unread = drafts.filter((d) => !d.viewById?.ok).length;
  return {
    status: unread ? 'FAIL' : 'PASS',
    reason: `${ctx.draftsSince} 之后有 ${res.rows.length} 张暂存单，${drafts.filter((d) => !d.billNo).length} 张没有单据编号；View 按内码读到 ${drafts.length - unread}/${drafts.length} 张`,
  };
}

/**
 * S10, the owner's go-ahead per run: delete ONE test draft, named by its 内码 (--delete-draft). Only a 暂存 draft with
 * no 单据编号 created since --drafts-since qualifies; anything else is refused before the delete. Then the same query
 * must find nothing.
 */
export async function s10(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const fid = ctx.deleteDraft;
  if (!fid || !/^\d+$/.test(fid)) return { status: 'FAIL', reason: `--delete-draft 要一个数字内码：${fid ?? '（没给）'}` };
  if (!SINCE.test(ctx.draftsSince)) return { status: 'FAIL', reason: `--drafts-since 不是「YYYY-MM-DD[ HH:mm[:ss]]」：${ctx.draftsSince}` };
  const main = await signedInMain(ctx);
  const find = () => queryRows(main.session, { formId: FORM, fieldKeys: 'FID,FBillNo,FDocumentStatus,FCreateDate', filter: `FID = ${fid}`, limit: 2 });
  const before = await find();
  if (!before.ok) return { status: 'FAIL', reason: `按内码查询被拒绝，没有删除：${before.reason}` };
  const row = before.rows[0];
  obs['before'] = row ? { fid: String(row[0]), billNo: String(row[1] ?? '').trim() || null, status: String(row[2] ?? ''), createdAt: String(row[3] ?? '') } : null;
  if (!row) return { status: 'FAIL', reason: `内码 ${fid} 查不到（已删除，或不在这个账号权限内），没有删除` };
  const billNo = String(row[1] ?? '').trim();
  const status = String(row[2] ?? '');
  const createdAt = String(row[3] ?? '').replace('T', ' ');
  if (status !== 'Z') return { status: 'FAIL', reason: `内码 ${fid} 的单据状态是 ${status}，不是暂存，没有删除` };
  if (billNo) return { status: 'FAIL', reason: `内码 ${fid} 有单据编号 ${billNo}，不是测试暂存单，没有删除` };
  if (createdAt < ctx.draftsSince) return { status: 'FAIL', reason: `内码 ${fid} 创建于 ${createdAt}，早于 ${ctx.draftsSince}，没有删除` };

  const deleted = await deleteDraft(main.session, fid);
  const answer = responseStatus(deleted.parsed);
  obs['delete'] = { httpStatus: deleted.httpStatus, ms: deleted.ms, ok: answer?.ok ?? null, errors: answer?.errors ?? [] };
  const after = await find();
  obs['after'] = after.ok ? { rows: after.rows.length } : { reason: after.reason };
  console.log(`[spike] S10 内码 ${fid}（暂存，无单据编号，创建于 ${createdAt}）：删除${answer?.ok ? '成功' : '没有成功'}，之后查询${after.ok ? `${after.rows.length} 行` : '失败'}`);
  if (!answer?.ok) return { status: 'FAIL', reason: `报销系统拒绝删除：${answer?.errors.join('；') || deleted.raw || '没有回答'}` };
  if (!after.ok || after.rows.length) return { status: 'FAIL', reason: '删除回答成功，但之后按内码还查得到（或查不了）' };
  return { status: 'PASS', reason: `内码 ${fid}（暂存，无单据编号，创建于 ${createdAt}）已删除，按内码再查为空` };
}

/**
 * Which query finds the bill holding an invoice (ADR-0034's precondition), asked while S11's own draft holds S4's test
 * invoice: the positive control S6 never had. S6 (2026-10-13) found 发票号码 only on 电子发票 (FEInvoiceEntity), which
 * V-60 read empty on a bill whose 收票信息 had 4 rows; 收票信息 itself has only 收票单, 从源单携带 and 发票序列号. So each
 * candidate is asked for FID and scored on whether it finds this draft. Read-only. Reports field names and hits, never
 * values.
 */
async function occupancyProbe(session: CdpSession, fid: string, invoiceNos: string[], receipts: Array<{ values: Record<string, string> }>, model: Record<string, unknown> | null): Promise<Observations> {
  const receiptNos = receipts.map((row) => String(row.values['收票单'] ?? '').trim()).filter((no) => isSafeKey(no));
  const invoices = invoiceNos.filter((no) => isSafeKey(no));
  const rowKeys = (entry: string) => {
    const rows = model?.[entry];
    const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    if (!first) return null;
    return Object.fromEntries(Object.entries(first).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object).slice(0, 40) : typeof v]));
  };
  const candidates = [
    ...invoices.flatMap((no) => [
      { field: 'FIVSerialNo', by: '发票号码', value: no },
      { field: 'FInvoiceNumber', by: '发票号码', value: no },
      { field: 'FRecInv.FInvoiceNo', by: '发票号码', value: no },
      { field: 'FRecInv.FInvoiceNumber', by: '发票号码', value: no },
      // 2026-10-13 live: the 收票单 a 收票信息 row references carries the number as FIVNUMBER (View of S11's draft).
      { field: 'FRecInv.FIVNUMBER', by: '发票号码', value: no },
    ]),
    ...receiptNos.flatMap((no) => [
      { field: 'FRecInv.FBillNo', by: '收票单号', value: no },
      { field: 'FRecInv.FNumber', by: '收票单号', value: no },
      { field: 'FRecInvBillNo', by: '收票单号', value: no },
    ]),
  ];
  const results = [];
  for (const c of candidates) {
    const res = await queryRows(session, { formId: FORM, fieldKeys: 'FID', filter: `${c.field} = '${c.value}'`, limit: 20 });
    results.push(res.ok
      ? { field: c.field, by: c.by, ok: true, rows: res.rows.length, findsThisDraft: res.rows.some((row) => String(row[0]) === fid) }
      : { field: c.field, by: c.by, ok: false, reason: res.reason.slice(0, 160) });
  }
  return { invoices: invoices.length, receiptNos: receiptNos.length, results, recInvInfoRow: rowKeys('RecInvInfo'), eInvoiceRow: rowKeys('FEInvoiceEntity') ?? rowKeys('EInvoiceEntity') };
}

/**
 * S11 (with --save only): 暂存 through the executor's own gateway on S4's form, the way a 本地执行器 job ends (ADR-0029):
 * 事由 with a fresh ownership marker, 暂存, the tab turning to 修改, the draft found by the marker, read back by its 内码
 * and compared with the page. Then the draft it made is deleted through S10's checks, so the run leaves nothing behind.
 * Reports column names, counts and the model's own field names, never values.
 */
export async function s11(ctx: Ctx, obs: Observations): Promise<Verdict> {
  if (!ctx.save) return { status: 'SKIP', reason: '没有 --save，不暂存' };
  if (!ctx.s4Passed || !ctx.formOpen) return { status: 'SKIP', reason: '需要 S4 先通过：暂存的是 S4 导入了测试发票、尚未保存的那张单' };
  const main = await signedInMain(ctx);
  const mark = `baox-${randomBytes(5).toString('hex')}`;
  const causa = markedPurpose('baox 暂存实测', mark);
  ctx.report.say(`S11 将用执行器的暂存入口暂存一张测试草稿（归属标记 ${mark}），核对后删除它。只点暂存，不点保存、提交、审核。`);
  const header = await writeHeader(main.session, 'FCAUSA', causa);
  obs['header'] = { ok: header.ok };
  if (!header.ok) return { status: 'FAIL', reason: `事由写不进去，没有暂存：${'reason' in header ? header.reason : ''}` };
  const page = protocolReadings(await readForm(main.session));
  const filled = (grid: typeof page.receiptsGrid) => (grid.ok ? grid.rows : []).filter((row) => row.kind === 'data' && Object.values(row.values).some((v) => String(v ?? '').trim()));
  const expected = { causa, receipts: filled(page.receiptsGrid), details: filled(page.detailGrid) };
  obs['page'] = { receipts: expected.receipts.length, details: expected.details.length };
  await ctx.report.shot(main.session, 's11-before-draft');
  const started = Date.now();
  try { await pressDraftGateway(main.session); } catch (error) { return { status: 'FAIL', reason: `没有点「暂存」：${(error as Error).message}` }; }
  const drafted = await waitDrafted(async () => (await readForm(main.session)).formMode.value, { timeoutMs: 60_000, pollMs: 1000 });
  obs['draftedMs'] = Date.now() - started;
  await ctx.report.shot(main.session, 's11-after-draft');
  if (!drafted) return { status: 'FAIL', reason: `点了「暂存」，60 秒内页签没有变成「修改」；可能留下了一张草稿，请用 S9 查（标记 ${mark}）` };
  const found = await findDrafts(main.session, mark);
  obs['found'] = found.ok ? { count: found.drafts.length } : { reason: found.reason };
  if (!found.ok || found.drafts.length !== 1) return { status: 'FAIL', reason: `按归属标记查暂存单：${found.ok ? `${found.drafts.length} 张` : found.reason}（标记 ${mark}，请用 S9 查）` };
  const draft = found.drafts[0]!;
  console.log(`[spike] S11 暂存单：内码 ${draft.id}，单据编号 ${draft.billNo ?? '（空）'}，状态 ${draft.status}`);
  const model = await viewDraft(main.session, draft.id);
  const problems = model ? compareDraft(model, expected) : ['按内码 View 读不回这张单'];
  obs['compare'] = {
    problems,
    modelKeys: model ? Object.keys(model).filter((k) => !Array.isArray(model[k])).slice(0, 120) : [],
    entries: model ? Object.fromEntries(Object.entries(model).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length])) : {},
  };
  const occupancy = await occupancyProbe(main.session, draft.id, ctx.s4InvoiceNos, expected.receipts, model);
  obs['occupancy'] = occupancy;
  const scored = (occupancy['results'] as Array<{ field: string; ok: boolean; findsThisDraft?: boolean }>).map((r) => `${r.field}：${r.ok ? (r.findsThisDraft ? '找到' : '没找到') : '查询被拒'}`);
  console.log(`[spike] S11 发票占用查法（发票 ${String(occupancy['invoices'])} 张、收票单 ${String(occupancy['receiptNos'])} 张）：${scored.join('；') || '没有可试的号码'}`);
  // The executor's own precondition (occupancy.ts checkRerun), as shipped, on the candidate field: this draft holds the
  // test invoice, so it must answer «held»; a number nobody holds, with a mark nobody wrote, must answer «clear».
  const invoices = ctx.s4InvoiceNos.filter((no) => INVOICE_NO.test(no));
  if (invoices.length) {
    const held = await checkRerun(main.session, { invoiceNos: invoices, marks: [mark] }, OCCUPANCY_CANDIDATE);
    const free = await checkRerun(main.session, { invoiceNos: [invoices[0]!.replace(/\d$/, (d) => String((Number(d) + 5) % 10))], marks: [`baox-${randomBytes(5).toString('hex')}`] }, OCCUPANCY_CANDIDATE);
    const heldOk = !held.ok && held.code === 'rerun_invoice_held' && held.holders.length > 0;
    obs['shippedCheck'] = {
      field: OCCUPANCY_CANDIDATE,
      held: held.ok ? 'clear' : held.code === 'rerun_invoice_held' ? { code: held.code, holders: held.holders.length, statuses: held.holders.map((h) => h.status), billNoEmpty: held.holders.every((h) => !h.billNo) } : { code: held.code, reason: 'reason' in held ? held.reason.slice(0, 160) : null },
      free: free.ok ? 'clear' : { code: free.code, reason: 'reason' in free ? free.reason.slice(0, 160) : null },
      verdict: heldOk && free.ok ? 'PASS' : 'FAIL',
    };
    console.log(`[spike] S11 执行器占用检查（${OCCUPANCY_CANDIDATE}）：占着的票 ${heldOk ? '判为被占用' : '没有判为被占用'}；没人占的号码 ${free.ok ? '判为空闲' : '没有判为空闲'}`);
  }
  // 对账 by the marker (line 2 item 5), as shipped (draft.ts lookupDraft): it must find this draft alone and read it back
  // equal; a mark nobody wrote must find nothing.
  const own = await lookupDraft(main.session, { mark, earlier: [`baox-${randomBytes(5).toString('hex')}`], expected });
  const stranger = await lookupDraft(main.session, { mark: `baox-${randomBytes(5).toString('hex')}`, earlier: [], expected: null });
  const ownOk = own.failure === null && own.drafts.length === 1 && own.drafts[0]!.id === draft.id && own.problems?.length === 0;
  const strangerOk = stranger.failure === null && stranger.drafts.length === 0;
  obs['shippedLookup'] = {
    own: { drafts: own.drafts.length, problems: own.problems, failure: own.failure },
    stranger: { drafts: stranger.drafts.length, failure: stranger.failure },
    verdict: ownOk && strangerOk ? 'PASS' : 'FAIL',
  };
  console.log(`[spike] S11 执行器按标记对账：这次的标记 ${ownOk ? '找到唯一一张且一致' : '没有找到唯一一张一致的'}；没人写过的标记 ${strangerOk ? '什么也没找到' : '找到了东西或查询失败'}`);
  // Cleanup: only this run's own draft, and only while it is still a 暂存 draft with no 单据编号.
  let cleaned = '没有删除';
  if (draft.status === 'Z' && !draft.billNo) {
    const deleted = await deleteDraft(main.session, draft.id);
    const after = await findDrafts(main.session, mark);
    cleaned = responseStatus(deleted.parsed)?.ok && after.ok && after.drafts.length === 0 ? '已删除' : '删除没有确认';
  }
  obs['cleanup'] = cleaned;
  console.log(`[spike] S11 测试草稿 ${draft.id}：${cleaned}`);
  if (problems.length) return { status: 'FAIL', reason: `暂存成功并按标记找到（内码 ${draft.id}，${cleaned}），但 View 与页面不一致：${problems.join('；')}` };
  if (!ownOk || !strangerOk) return { status: 'FAIL', reason: `暂存并核对通过（内码 ${draft.id}，${cleaned}），但执行器按标记对账没有得出该有的结果：${JSON.stringify(obs['shippedLookup'])}` };
  return { status: 'PASS', reason: `${secs(Number(obs['draftedMs']))} 变成修改；按归属标记找到唯一一张暂存单，View 与页面一致（收票 ${expected.receipts.length} 行、明细 ${expected.details.length} 行）；执行器按标记对账找到它且一致；测试草稿${cleaned}` };
}

// ---------------------------------------------------------------------------------------------------------------
// S12

/**
 * S12 (read-only): the executor's shipped occupancy check (occupancy.ts checkRerun, ADR-0034) on bills this account
 * already has, with no 暂存 needed: it finds a 费用报销单 whose 收票信息 references a 收票单 with an invoice number, asks
 * the check about that number (it must answer «held» by that very bill), and about a number one digit off with a mark
 * nobody wrote (it must answer «clear»). Reports counts and booleans, never a number.
 */
export async function s12(ctx: Ctx, obs: Observations): Promise<Verdict> {
  const main = await signedInMain(ctx);
  const field = OCCUPANCY_CANDIDATE;
  const sample = await queryRows(main.session, { formId: FORM, fieldKeys: `FID,FBillNo,FDocumentStatus,${field}`, filter: `${field} <> ''`, limit: 20 });
  if (!sample.ok) return { status: 'FAIL', reason: `按 ${field} 取样被拒：${sample.reason.slice(0, 160)}` };
  const rows = sample.rows.map((row) => ({ id: String(row[0] ?? ''), billNo: String(row[1] ?? '').trim(), status: String(row[2] ?? ''), no: String(row[3] ?? '').trim() }));
  const usable = rows.filter((row) => INVOICE_NO.test(row.no));
  obs['sample'] = { rows: rows.length, usable: usable.length, statuses: [...new Set(usable.map((row) => row.status))] };
  const known = usable[0];
  if (!known) return { status: 'SKIP', reason: `这个账号权限内没有收票信息带发票号码的费用报销单（取样 ${rows.length} 行），没有对照` };
  const held = await checkRerun(main.session, { invoiceNos: [known.no], marks: [`baox-${randomBytes(5).toString('hex')}`] }, field);
  const findsKnown = !held.ok && held.code === 'rerun_invoice_held' && held.holders.some((h) => (h.billNo ?? '') === known.billNo);
  const otherNo = known.no.replace(/\d$/, (d) => String((Number(d) + 5) % 10));
  const othersHolding = usable.some((row) => row.no === otherNo);
  const free = await checkRerun(main.session, { invoiceNos: [otherNo], marks: [`baox-${randomBytes(5).toString('hex')}`] }, field);
  obs['held'] = held.ok ? 'clear' : held.code === 'rerun_invoice_held' ? { code: held.code, holders: held.holders.length, findsKnown } : { code: held.code, reason: 'reason' in held ? held.reason.slice(0, 160) : null };
  obs['free'] = free.ok ? 'clear' : { code: free.code, ...(free.code === 'rerun_check_failed' ? { reason: free.reason.slice(0, 160) } : {}), othersHolding };
  obs['knownStatus'] = known.status;
  if (!findsKnown) return { status: 'FAIL', reason: `执行器的占用检查（${field}）没有把一张已知单据（状态 ${known.status}）占着的发票判为被它占用` };
  if (!free.ok) return { status: othersHolding ? 'SKIP' : 'FAIL', reason: `没人占的号码没有判为空闲（${free.code}）` };
  return { status: 'PASS', reason: `执行器的占用检查按 ${field} 找回了已知单据（状态 ${known.status}）占着的发票，没人占的号码判为空闲` };
}

// ---------------------------------------------------------------------------------------------------------------
// S3

/** S3: does our login knock the owner off, and does the executor recognise it when the owner knocks us off? */
export async function s3(ctx: Ctx, obs: Observations, ask: Interface): Promise<Verdict> {
  const r = ctx.report;
  await ask.question(`\n[S3] 请在你自己的浏览器里打开 ${ctx.entry}，用同一个 ERP 账号登录，进到主控台后回到这里按回车。`);
  const h = await launchHeadless({ label: 's3', openUrl: ctx.entry, origin: ctx.origin, chromium: ctx.chromium });
  ctx.sessions.add(h);
  const outcome = await signIn(ctx, h);
  obs['scriptLogin'] = { ok: outcome.ok, ms: outcome.ms, alreadyOnline: outcome.alreadyOnline, why: outcome.why };
  if (!outcome.ok) return { status: 'FAIL', reason: `脚本没有登录上：${outcome.why}` };
  await r.shot(h.session, 'script-logged-in');
  const ownerOut = (await ask.question('[S3] 脚本已登录。看看你自己的 ERP 页面（点一下菜单或刷新一次）：它被登出了吗？(y/n) ')).trim().toLowerCase().startsWith('y');
  obs['ownerLoggedOutByScript'] = ownerOut;

  await ask.question('[S3] 现在请在你自己的浏览器里重新登录同一个账号（提示「该帐号已登录在线」就确认），进到主控台后按回车。');
  await sleep(5000);
  const look = async (name: string) => {
    const o = await observe(h.session, ctx.origin);
    const seen = { verdict: o.verdict, loginFormVisible: o.observed?.loginFormVisible ?? null, onMainConsole: o.observed?.onMainConsole ?? null, displayNameShown: !!o.observed?.displayName, dialogs: await dialogs(h.session), knownNotices: await knownNotices(h.session) };
    await r.shot(h.session, name);
    return seen;
  };
  const inPlace = await look('after-owner-relogin');
  const query = await queryRows(h.session, { formId: EXPENSE_ITEM_FORM, fieldKeys: 'FNumber', limit: 1 });
  await sleep(3000);
  const afterQuery = await look('after-webapi');
  await h.session.send('Page.reload', { ignoreCache: true }).catch(() => null);
  await sleep(2000);
  const reloaded = await waitFor(() => observe(h.session, ctx.origin), (o) => o.verdict === 'matched' || o.verdict === 'not_logged_in', 45_000, 1000);
  await r.shot(h.session, 'after-reload');
  obs['scriptSession'] = { inPlace, webapi: query.ok ? { ok: true } : { ok: false, reason: query.reason }, afterQuery, afterReload: reloaded.verdict };

  const queryDead = !query.ok && /会话|登录|session/i.test(query.reason);
  const dead = queryDead || reloaded.verdict === 'not_logged_in';
  if (dead) ctx.signedIn.delete(h);
  const own = `所有者页面被脚本挤掉：${ownerOut ? '是' : '否'}`;
  if (!dead) return { status: 'PASS', reason: `${own}；所有者重新登录后脚本会话仍然可用，ERP 没有反向挤号` };
  const recognisedInPlace = inPlace.verdict !== 'matched' || afterQuery.verdict !== 'matched';
  if (recognisedInPlace) return { status: 'PASS', reason: `${own}；脚本会话被挤掉，执行器现有探测在原页面上判为 ${afterQuery.verdict}` };
  return {
    status: 'FAIL',
    reason: `${own}；脚本会话已被挤掉（WebAPI ${queryDead ? '报会话丢失' : '仍可用'}，重载后 ${reloaded.verdict}），`
      + `但执行器现有探测在不重载的原页面上仍判为 matched，notices.ts 也不认识页面上的提示（${afterQuery.dialogs.length} 个对话框）：这是线 1 B2 要修的`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// S7

/** One concurrent job: sign in, and import into an unsaved form when --invoice is given; memory measured throughout. */
async function concurrentJob(ctx: Ctx, label: string) {
  const out: Observations = { label };
  let h: Headless | null = null;
  try {
    h = await launchHeadless({ label, openUrl: ctx.entry, origin: ctx.origin, chromium: ctx.chromium });
    ctx.sessions.add(h);
    const outcome = await signIn(ctx, h);
    out['login'] = { ok: outcome.ok, ms: outcome.ms, alreadyOnline: outcome.alreadyOnline.seen, why: outcome.why };
    if (outcome.ok && ctx.invoice) {
      const job: Observations = {};
      out['import'] = job;
      await importOne(ctx, h, job, false).catch((e: Error) => { job['error'] = e.message; });
      out['discard'] = await discardForms(ctx, h);
    }
  } catch (error) {
    out['error'] = error instanceof Error ? error.message : String(error);
  }
  if (h) {
    out['memory'] = h.memory();
    out['crashes'] = [...h.crashes];
    out['close'] = await endSession(ctx, h);
  }
  return out;
}

/** S7: peak memory of one job's browser tree, and of two in parallel with --concurrency 2; no crash. */
export async function s7(ctx: Ctx, obs: Observations): Promise<Verdict> {
  if (process.platform !== 'linux') return { status: 'SKIP', reason: '只在 Linux 上按 /proc 量进程树内存' };
  const measured: Array<{ label: string; memory: MemoryPeak | null; crashes: string[] }> = [];
  if (ctx.mainMemory) {
    obs['single'] = { label: 'main (S1–S6)', memory: ctx.mainMemory, crashes: ctx.mainCrashes };
    measured.push({ label: 'main', memory: ctx.mainMemory, crashes: ctx.mainCrashes });
  }
  const jobs = ctx.concurrency >= 2 || !ctx.mainMemory ? Math.max(1, ctx.concurrency) : 0;
  if (jobs) {
    if (jobs > 1) ctx.report.say(`S7 将并行启动 ${jobs} 个无头会话${ctx.invoice ? '，每个都在不保存的新增单里导入测试发票' : '，只登录'}。同一个账号并行登录可能互相挤号，那只影响功能，不影响内存读数。`);
    const before = memAvailableMb();
    const results = await Promise.all(Array.from({ length: jobs }, (_, i) => concurrentJob(ctx, `c${i + 1}`)));
    const after = memAvailableMb();
    obs['concurrent'] = { jobs, memAvailableBeforeMb: before, memAvailableAfterMb: after, results };
    for (const res of results) measured.push({ label: String(res['label']), memory: (res['memory'] as MemoryPeak | null) ?? null, crashes: (res['crashes'] as string[] | undefined) ?? [] });
  }
  const unmeasured = measured.filter((m) => !m.memory || m.memory.samples === 0);
  if (!measured.length || unmeasured.length === measured.length) return { status: 'FAIL', reason: '没有量到任何浏览器进程树（拿不到 Chromium 的进程号）' };
  const over = measured.filter((m) => (m.memory?.peakRssMb ?? 0) > MEMORY_LIMIT_MB);
  const crashed = measured.filter((m) => m.crashes.length);
  const peaks = measured.map((m) => `${m.label} RSS ${m.memory?.peakRssMb ?? '?'} MB / PSS ${m.memory?.peakPssMb ?? '?'} MB`).join('；');
  if (crashed.length) return { status: 'FAIL', reason: `有浏览器崩溃或进程消失：${crashed.map((m) => `${m.label}(${m.crashes.join(',')})`).join('、')}；${peaks}` };
  if (over.length) return { status: 'FAIL', reason: `峰值超过 ${MEMORY_LIMIT_MB} MB：${peaks}（RSS 逐进程相加会重复计算共享页，PSS 更接近实际占用）` };
  return { status: 'PASS', reason: `每个任务峰值都不超过 ${MEMORY_LIMIT_MB} MB，没有崩溃：${peaks}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Teardown

/** Sign out (when signed in), close the browser and delete its profile. Safe to call twice. */
export async function endSession(ctx: Ctx, h: Headless): Promise<string[]> {
  if (!ctx.sessions.has(h)) return [];
  const notes: string[] = [];
  if (ctx.signedIn.has(h)) {
    const out = await logout(h.session, ctx.origin).catch((e: Error) => ({ httpStatus: null, verified: false, after: e.message }));
    notes.push(out.verified
      ? `${h.label}: 已登出 ERP（AuthService.Logout，重载后回到登录页）`
      : `${h.label}: 登出没有得到确认（HTTP ${out.httpStatus ?? '-'}，重载后 ${out.after}）；浏览器随后关闭，ERP 侧会话等它自己过期`);
    ctx.signedIn.delete(h);
  }
  notes.push(...await h.close());
  ctx.sessions.delete(h);
  return notes;
}
