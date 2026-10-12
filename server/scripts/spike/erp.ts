// What the spike does to the ERP page that the executor does not do yet: sign in with the hosted credentials and say
// what stood in the way (a second factor, 该帐号已登录在线, a 账套 choice), sign out again, call the read-only WebAPI
// stubs, and — for S5 with --save only — find and press 暂存.
//
// Read-only by construction except where named. The WebAPI calls are `ExecuteBillQuery` (through the executor's own
// `queryRows`), `QueryBusinessInfo` and `View`, plus `AuthService.Logout` on the way out. No Save, Draft, Submit,
// Audit or Delete stub is ever called; the one write a spike makes, 暂存, is a toolbar click guarded below.
import { evalIn, type CdpSession } from '@baox/erp-executor/cdp';
import { HIT_JS, clickReach, type Reach } from '@baox/erp-executor/hit';
import { DISMISSALS, dismissalPoint } from '@baox/erp-executor/notices';
import { identityFromObservation, READ_ONLY_SNIPPET, type Observation } from '@baox/erp-executor/probe';
import { sleep, waitFor } from '@baox/erp-executor/pace';
import { signInSnippet } from '@baox/erp-executor/recording/sign-in';
import { dialogsSnippet } from '@baox/erp-executor/tabs';
import type { PageTrace, TraceSnapshot } from './trace';

export const FORM = 'ER_ExpReimbursement';
const stub = (name: string) => `Kingdee.BOS.WebApi.ServicesStub.${name}.common.kdsvc`;

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;

// ---------------------------------------------------------------------------------------------------------------
// Observation

/** The executor's own login probe, judged by the executor's own rule. `verdict` is what a real job would conclude. */
export async function observe(session: CdpSession, origin: string) {
  const observed = await evalIn<Observation>(session, READ_ONLY_SNIPPET, { timeout: 15_000 }).catch(() => null);
  const verdict = identityFromObservation(observed, { transport: 'chromium-cdp', origin });
  return { observed, verdict: verdict?.status ?? (observed ? 'loading' : 'unreadable'), hint: verdict && 'hint' in verdict ? verdict.hint : null };
}

/** Which of the executor's known notices (notices.ts) is on screen right now. Looks only; clicks nothing. */
export async function knownNotices(session: CdpSession): Promise<string[]> {
  const seen: string[] = [];
  for (const { caption } of DISMISSALS) {
    const point = await evalIn<{ ok: boolean; count?: number }>(session, dismissalPoint(caption)).catch(() => null);
    if (point?.ok || (point?.count ?? 0) > 0) seen.push(caption);
  }
  return seen;
}

/** The text of every visible ERP dialog (tabs.ts `dialogsSnippet`). The caller redacts before printing. */
export const dialogs = (session: CdpSession) => evalIn<string[]>(session, dialogsSnippet).catch(() => [] as string[]);

// ---------------------------------------------------------------------------------------------------------------
// Sign-in

/**
 * Facts about the login page, never values. `secondFactor` names visible controls that look like a captcha, an SMS
 * code or a dynamic password; `alreadyOnline` is the 该帐号已登录在线 prompt with its single 确定/确认 button, which
 * is how this ERP announces that logging in will knock another session off (ADR-0033 accepts that).
 */
const LOGIN_FACTS = `(() => {
  const vis = ${VIS};
  const hitOf = ${HIT_JS};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const leaves = [...document.querySelectorAll('body *')].filter((n) => n.children.length === 0 && vis(n));
  const words = /验证码|短信|动态密码|动态码|二次验证|双因素|手机验证|滑块|拖动|captcha|verif|otp|sms/i;
  const secondFactor = [
    ...[...document.querySelectorAll('input')].filter(vis)
      .filter((n) => words.test([n.id, n.name, n.placeholder].join(' '))).map((n) => 'input#' + (n.id || n.name || '?')),
    ...[...document.querySelectorAll('img, canvas')].filter(vis)
      .filter((n) => /captcha|verify|validate|yzm|checkcode/i.test([n.id, n.className, n.getAttribute('src') || ''].join(' ')))
      .map((n) => n.tagName.toLowerCase() + '#' + (n.id || '?')),
    ...leaves.filter((n) => words.test(txt(n)) && txt(n).length <= 40).map((n) => 'text「' + txt(n).slice(0, 30) + '」'),
  ];
  // A prompt is a visible message with a single 确定/确认 in the box around it. Climb from the message to the nearest
  // ancestor that holds a confirm button, and offer only that box's one.
  const prompt = (re) => {
    const hits = leaves.filter((n) => re.test(txt(n)));
    if (!hits.length) return null;
    let box = hits[0];
    const confirms = (root) => [...root.querySelectorAll('button, a, input[type=button], span, div[role=button]')]
      .filter((n) => vis(n) && /^(确定|确认)$/.test(String(n.value || txt(n))));
    for (let i = 0; i < 8 && box.parentElement && confirms(box).length === 0; i += 1) box = box.parentElement;
    const found = confirms(box);
    const outer = found.filter((n) => !found.some((m) => m !== n && m.contains(n)));
    return { text: txt(hits[0]).slice(0, 80), buttons: outer.length, reach: outer.length === 1 ? hitOf(outer[0]) : null };
  };
  const alreadyOnline = prompt(/已登录在线|已在其他|已经登录|在线用户/);
  // 「金蝶提示：语言未加载。」: the login page submitted before its language resources arrived.
  const languageMissing = prompt(/语言未加载/);
  const busy = [...document.querySelectorAll('[class*="loading" i], [class*="spinner" i], [class*="mask" i], [id*="loading" i]')].filter(vis).length;
  const passwords = [...document.querySelectorAll('input[type=password]')].filter(vis);
  const errors = leaves.map(txt).filter((t) => t.length <= 80 && /密码错误|用户名或密码|不存在|已锁定|锁定|登录失败|错误|过期|禁用/.test(t)).slice(0, 3);
  const dc = document.getElementById('datacenter_ct');
  const dcOptions = dc ? [...dc.querySelectorAll('li, option')].length : 0;
  return {
    ready: document.readyState,
    loginFormVisible: passwords.length > 0,
    secondFactor: [...new Set(secondFactor)].slice(0, 8),
    alreadyOnline,
    languageMissing,
    busy,
    errors,
    dataCentre: { present: !!dc, visible: !!dc && vis(dc), textLength: dc ? txt(dc).length : 0, options: dcOptions },
  };
})()`;

type Prompt = { text: string; buttons: number; reach: Reach | null };
type LoginFacts = {
  ready: string; loginFormVisible: boolean; secondFactor: string[]; errors: string[];
  alreadyOnline: Prompt | null; languageMissing: Prompt | null;
  /** Visible loading-, spinner- or mask-like elements. */
  busy: number;
  dataCentre: { present: boolean; visible: boolean; textLength: number; options: number };
};

/** Whether the login page had finished setting itself up before it was submitted, and what it took. */
type Initialised = { label: string; ok: boolean; ms: number; dataCentreOptions: number; pending: number; languageMissing: boolean };

/** One line per change of what the login looks like: when the page moved on, and when it stopped moving. */
type Moment = { tMs: number; verdict: string; form: boolean; busy: number; pending: number; oldestPending: string | null; dialogs: string[] };

export type LoginOutcome = {
  ok: boolean; why: string; ms: number; submitted: boolean;
  formMs: number | null; consoleMs: number | null;
  loginPage: LoginFacts | null;
  /** Each wait for the page to set itself up: the first, after a reload, before a resubmit. */
  initialised: Initialised[];
  reloads: number; submits: number;
  /** --prefetch: the console's scripts fetched into the HTTP cache before submitting, and what that took. */
  prefetch: Prefetch | null;
  /** Second-factor-looking controls that appeared only AFTER submitting: those, not the login page's own links, gate a login. */
  newSecondFactor: string[];
  alreadyOnline: { seen: boolean; text: string | null; confirmed: boolean; buttons: number };
  languageMissing: { seen: number; confirmed: number };
  errors: string[];
  verdict: string; onMainConsole: boolean; displayName: string | null; account: string | null; tenant: string | null;
  timeline: Moment[];
  /** Submits after which the page started no request at all within NO_EFFECT_MS, and were therefore repeated. */
  noEffect: number;
  /** Wire and console records (trace.ts), taken when a wait ran out; and where the page stood at the end of a failure. */
  diagnostics: Record<string, TraceSnapshot>;
  pageState: PageState | null;
};

type Prefetch = { ok: boolean; versioned: boolean; files: Array<{ file: string; status: number; kb: number; ms: number; error?: string }> };

// After ValidateLoginInfo the login page loads the console's scripts through RequireJS with waitSeconds:30
// (kdformjsloader.min.js), and dform.aspx loads k3cloud.min.js the same way. kendo.all.min.js (2.8 MB) and
// k3cloud.min.js (3.4 MB) are served uncompressed and over a slow link take longer than that; RequireJS gives up
// and the login silently stops, on the login page or on a console spinner (2026-10-12: 9 of 9 runs at 40-75 KB/s).
// Fetching the same URLs first, with the same ?ver= the loader appends, puts them in the HTTP cache so the loader's
// own request is answered at once. Without window.KDResVer the loader appends a timestamp, nothing can be cached,
// and this says so.
const CONSOLE_SCRIPTS = ['thirdpart/kendo/kendo.all.min.js', 'k3cloud.min.js', 'kdvgrid.min.js'];
const PREFETCH = `(async () => {
  const res = window.KDResVer ? String(window.KDResVer) : '';
  const root = (window.KD && typeof KD.getUrlRoot === 'function' && typeof KD.getSubPath === 'function')
    ? KD.getUrlRoot() + '/' + KD.getSubPath() + '/script' : location.origin + '/k3cloud/html5/script';
  const files = [];
  for (const file of ${JSON.stringify(CONSOLE_SCRIPTS)}) {
    const started = Date.now();
    try {
      const r = await fetch(root + '/' + file + (res ? '?ver=' + encodeURIComponent(res.substring(5)) : ''), { cache: 'force-cache', credentials: 'include' });
      const body = await r.arrayBuffer();
      files.push({ file, status: r.status, kb: Math.round(body.byteLength / 1024), ms: Date.now() - started });
    } catch (e) { files.push({ file, status: 0, kb: 0, ms: Date.now() - started, error: String(e).slice(0, 80) }); }
  }
  return { ok: !!res && files.every((f) => f.status === 200), versioned: !!res, files };
})()`;

type PageState = { path: string; ready: string; titleLength: number; text: string; busy: string[]; frames: string[] };

const factsOf = (session: CdpSession) => evalIn<LoginFacts>(session, LOGIN_FACTS, { timeout: 10_000 }).catch(() => null);
/** Where the page stands: its path, its visible text, which spinner-like elements are up, and which frames it holds. */
const PAGE_STATE = `(() => {
  const vis = ${VIS};
  const bare = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return String(u).slice(0, 80); } };
  return {
    path: location.pathname, ready: document.readyState, titleLength: document.title.length,
    text: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
    busy: [...document.querySelectorAll('[class*="loading" i], [class*="spinner" i], [class*="mask" i], [id*="loading" i]')].filter(vis)
      .map((n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + '.' + String(n.className).trim().split(/\\s+/).slice(0, 3).join('.')).slice(0, 8),
    frames: [...document.querySelectorAll('iframe, frame')].map((f) => bare(f.src || 'about:blank') + (vis(f) ? '' : ' (hidden)')).slice(0, 10),
  };
})()`;

const FORM_MS = 60_000;
/** Over the Mac's link kendo.all.min.js alone takes about 48 s (2026-10-12 runs). */
const READY_MS = 120_000;
const QUIET_MS = 1500;
/** After submitting: long enough to tell a slow ERP from a hung one (runs 1 and 3 sat on a spinner for the old 120 s). */
const CONSOLE_MS = 300_000;
const RESUBMITS = 2;
/** A submit after which the page starts no request at all for this long did nothing (runs 2–4 of 2026-10-12 10:53). */
const NO_EFFECT_MS = 20_000;
/** A request still open this long when the wait runs out is named in the failure as the one that hung. */
const HUNG_MS = 20_000;

/**
 * Wait until the login page has set itself up: the form is up, the data-centre list has entries, no 语言未加载 prompt
 * is showing, and no request at all has been open for QUIET_MS. Run 4 submitted a form whose data-centre list was still
 * empty and got 「语言未加载」 back; later runs submitted while kendo.all.min.js was still arriving and their click did
 * nothing. A request that never ends holds this wait to READY_MS, and the not-initialised record names it.
 */
async function untilInitialised(session: CdpSession, trace: PageTrace | undefined) {
  const started = Date.now();
  let quietSince: number | null = null;
  let facts: LoginFacts | null = null;
  let pending = 0;
  while (Date.now() - started < READY_MS) {
    facts = await factsOf(session);
    pending = trace ? trace.pending().filter((r) => r.type !== 'EventSource').length : 0;
    const dc = facts?.dataCentre;
    const dcReady = !dc?.present || dc.options > 0 || dc.textLength > 0;
    if (facts?.loginFormVisible && dcReady && !facts.languageMissing && pending === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= QUIET_MS) break;
    } else quietSince = null;
    await sleep(500);
  }
  const ok = quietSince !== null && Date.now() - quietSince >= QUIET_MS;
  return { ok, ms: Date.now() - started, dataCentreOptions: facts?.dataCentre.options ?? 0, pending, languageMissing: !!facts?.languageMissing, facts };
}

/**
 * Sign in with the hosted credentials: wait for the form and for the page to set itself up (reloading once if it
 * never does), fill it with the harness's `signInSnippet`, then watch until the console is up or something stands in
 * the way. 「语言未加载」 is confirmed and the form resubmitted. With a `trace`, every wait that runs out leaves the
 * page's open and failed requests and console errors in `diagnostics`. The secret goes into the page and nowhere else.
 */
export async function login(session: CdpSession, { origin, account, password, shot, trace, prefetch = false }: { origin: string; account: string; password: string; shot?: (name: string) => Promise<unknown>; trace?: PageTrace; prefetch?: boolean }): Promise<LoginOutcome> {
  const started = Date.now();
  const out: LoginOutcome = {
    ok: false, why: '', ms: 0, submitted: false, formMs: null, consoleMs: null, loginPage: null, initialised: [], reloads: 0, submits: 0, prefetch: null,
    newSecondFactor: [], alreadyOnline: { seen: false, text: null, confirmed: false, buttons: 0 }, languageMissing: { seen: 0, confirmed: 0 },
    errors: [], verdict: 'unknown', onMainConsole: false, displayName: null, account: null, tenant: null, timeline: [], noEffect: 0, diagnostics: {}, pageState: null,
  };
  const diagnose = async (name: string) => { if (trace) out.diagnostics[name] = await trace.snapshot(); };
  const finish = async (ok: boolean, why: string) => {
    if (!ok) {
      await diagnose('end');
      out.pageState = await evalIn<PageState>(session, PAGE_STATE).catch(() => null);
    }
    out.ok = ok; out.why = why; out.ms = Date.now() - started;
    return out;
  };
  const settle = async (label: string) => {
    const r = await untilInitialised(session, trace);
    const { facts: _facts, ...record } = r;
    out.initialised.push({ label, ...record });
    if (!r.ok) { await diagnose(`not-initialised-${label}`); await shot?.(`not-initialised-${label}`); }
    return r;
  };
  let sentAt = 0;
  let requestsAtSubmit = 0;
  const submit = async () => {
    for (let i = 0; i < 30; i += 1) {
      requestsAtSubmit = trace?.started() ?? 0;
      const r = await evalIn<{ ok: boolean; why?: string }>(session, signInSnippet(account, password)).catch(() => ({ ok: false, why: 'no answer' }));
      if (r.ok) { out.submitted = true; out.submits += 1; sentAt = Date.now(); return true; }
      await sleep(1000);
    }
    return false;
  };

  // 1. The form. readyState reaches complete well before Kendo lays the form out (probe-login.ts), so poll the form itself.
  const page = await waitFor(() => factsOf(session), (f) => f?.loginFormVisible === true, FORM_MS, 1000);
  out.loginPage = page;
  if (!page?.loginFormVisible) return finish(false, `${FORM_MS / 1000} 秒内没有出现登录表单`);
  out.formMs = Date.now() - started;
  await shot?.('login-form');

  // 2. The page set up. One reload if it never is: a page that loaded badly once may load well the second time, and
  //    whether it does is itself an answer for the executor.
  let ready = await settle('first');
  if (!ready.ok) {
    out.reloads += 1;
    await session.send('Page.reload', { ignoreCache: false }).catch(() => null);
    await sleep(2000);
    await waitFor(() => factsOf(session), (f) => f?.loginFormVisible === true, FORM_MS, 1000);
    ready = await settle('reload');
  }
  if (ready.facts) out.loginPage = ready.facts;
  // Not set up even then: submit anyway, because what the ERP answers to that is the evidence this spike is after.

  if (prefetch) out.prefetch = await evalIn<Prefetch>(session, PREFETCH, { timeout: 240_000 }).catch((e: Error) => ({ ok: false, versioned: false, files: [{ file: '*', status: 0, kb: 0, ms: 0, error: e.message }] }));

  // 3. Submit.
  if (!(await submit())) return finish(false, '登录表单填不进去（signInSnippet 没有找到账号框、密码框或登录按钮）');
  const submittedAt = Date.now();

  // 4. Watch. Each poll reads the executor's verdict first, then what might be in its way.
  const before = new Set(page.secondFactor);
  let deadline = Date.now() + CONSOLE_MS;
  let stuckSince: number | null = null;
  let lastKey = '';
  let midway = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const now = await observe(session, origin);
    if (now.verdict === 'matched' && now.observed?.onMainConsole) {
      out.verdict = 'matched';
      out.onMainConsole = true;
      out.displayName = now.observed.displayName;
      out.account = now.observed.account;
      out.tenant = now.observed.tenant;
      out.consoleMs = Date.now() - started;
      return finish(true, '已进入主控台');
    }
    out.verdict = now.verdict;
    const facts = await factsOf(session);
    const open = trace?.pending() ?? [];
    const moment: Moment = {
      tMs: Date.now() - started, verdict: now.verdict, form: !!facts?.loginFormVisible, busy: facts?.busy ?? -1,
      pending: open.length, oldestPending: open[0] ? `${open[0].method} ${open[0].url}` : null, dialogs: await dialogs(session),
    };
    const key = JSON.stringify({ ...moment, tMs: 0, pending: Math.min(moment.pending, 5) });
    if (key !== lastKey && out.timeline.length < 200) { out.timeline.push(moment); lastKey = key; }
    if (!midway && Date.now() - submittedAt > 60_000) { midway = true; await diagnose('submit+60s'); await shot?.('login-60s'); }
    if (!facts) continue;
    // The click reached nothing that listens: the page has sent no request since. Press 登录 again.
    if (trace && facts.loginFormVisible && !facts.languageMissing && !facts.alreadyOnline && trace.started() === requestsAtSubmit
      && Date.now() - sentAt > NO_EFFECT_MS && out.submits <= RESUBMITS) {
      out.noEffect += 1;
      await diagnose(`no-effect-${out.submits}`);
      await shot?.(`no-effect-${out.submits}`);
      if (!(await submit())) return finish(false, '再次提交时表单填不进去');
      deadline = Date.now() + CONSOLE_MS;
      continue;
    }
    if (facts.languageMissing) {
      out.languageMissing.seen += 1;
      if (facts.languageMissing.reach?.onTarget && out.submits <= RESUBMITS) {
        await shot?.('language-missing');
        await diagnose(`language-missing-${out.submits}`);
        await clickReach(session, facts.languageMissing.reach, '「语言未加载」的确定');
        out.languageMissing.confirmed += 1;
        await settle(`resubmit-${out.submits}`);
        if (!(await submit())) return finish(false, '「语言未加载」之后表单填不进去');
        deadline = Date.now() + CONSOLE_MS;
        stuckSince = null;
        continue;
      }
    }
    if (facts.alreadyOnline) {
      out.alreadyOnline.seen = true;
      out.alreadyOnline.text = facts.alreadyOnline.text;
      out.alreadyOnline.buttons = facts.alreadyOnline.buttons;
      if (!out.alreadyOnline.confirmed && facts.alreadyOnline.reach?.onTarget) {
        await shot?.('already-online');
        await clickReach(session, facts.alreadyOnline.reach, '「该帐号已登录在线」的确认');
        out.alreadyOnline.confirmed = true;
        continue;
      }
    }
    const fresh = facts.secondFactor.filter((s) => !before.has(s));
    if (fresh.length) out.newSecondFactor = fresh;
    if (facts.errors.length) out.errors = facts.errors;
    // A second factor, a refusal or a 语言未加载 that cannot be confirmed any more does not clear by itself; give the
    // page ten seconds to move on, then report it. Only while the login form is still up: text on a console that is
    // still loading is not the login's answer.
    const language = facts.languageMissing ? `「${facts.languageMissing.text}」` : null;
    if (facts.loginFormVisible && (fresh.length || facts.errors.length || language)) {
      stuckSince ??= Date.now();
      if (Date.now() - stuckSince > 10_000) {
        await shot?.('login-blocked');
        return finish(false, fresh.length ? `提交后出现了第二道校验：${fresh.join('、')}`
          : language ? `ERP 提示语言未加载，已提交 ${out.submits} 次：${language}` : `ERP 拒绝了登录：${facts.errors.join('；')}`);
      }
    } else stuckSince = null;
  }
  await shot?.('login-timeout');
  const seen = out.newSecondFactor.length ? `；提交后新出现：${out.newSecondFactor.join('、')}` : '';
  const hung = trace?.pending(HUNG_MS)[0];
  const open = hung ? `；最久未返回的请求：${hung.method} ${hung.url}（${Math.round(hung.ageMs / 1000)} 秒）` : '';
  return finish(false, `提交后 ${CONSOLE_MS / 1000} 秒没有进入主控台（执行器判定：${out.verdict}${seen}${open}）`);
}

// ---------------------------------------------------------------------------------------------------------------
// WebAPI, from inside the logged-in page

// K3Cloud's own front-end sends `kdservice-sessionid` alongside the cookie (probe-webapi.ts). The id is read in-page,
// put straight into the header, and never returned to this process.
const callSnippet = (service: string, params: unknown[]) => `(async () => {
  const started = Date.now();
  const sid = (document.cookie.match(/(?:^|;\\s*)kdservice-sessionid=([^;]+)/) || [])[1] || '';
  const r = await fetch(${JSON.stringify('/k3cloud/')} + ${JSON.stringify(service)}, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'kdservice-sessionid': decodeURIComponent(sid) } : {}),
    body: JSON.stringify({ parameters: ${JSON.stringify(params)} }),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { httpStatus: r.status, ms: Date.now() - started, parsed, raw: parsed === null ? text.slice(0, 200) : null };
})()`;

// The whole list. A stub that is not here cannot be sent, whatever a caller passes.
const READ_ONLY_STUBS = new Set(['DynamicFormService.QueryBusinessInfo', 'DynamicFormService.View', 'AuthService.Logout']);

export type Call = { httpStatus: number | null; ms: number | null; parsed: any; raw: string | null };

/** One read-only stub call. Never throws; a transport failure comes back as `httpStatus: null`. */
export async function call(session: CdpSession, name: string, params: unknown[]): Promise<Call> {
  if (!READ_ONLY_STUBS.has(name)) throw new Error(`spike 只调用只读服务和登出，不调用 ${name}`);
  try { return await evalIn<Call>(session, callSnippet(stub(name), params), { timeout: 120_000 }); }
  catch (error) { return { httpStatus: null, ms: null, parsed: null, raw: error instanceof Error ? error.message : String(error) }; }
}

/** ERP answers 200 for a refusal too; ResponseStatus is where the reason lives (probe-webapi.ts). */
export const responseStatus = (body: any): { ok: boolean; errors: string[] } | null => {
  const first = Array.isArray(body) ? body[0] : null;
  const nested = Array.isArray(first) ? first[0] : first;
  const rs = body?.Result?.ResponseStatus ?? body?.ResponseStatus ?? nested?.Result?.ResponseStatus ?? nested?.ResponseStatus ?? null;
  if (!rs) return null;
  return { ok: rs.IsSuccess === true, errors: (rs.Errors ?? []).map((e: any) => String(e?.Message ?? e)).slice(0, 3) };
};

/** Describe a value without disclosing it: type and size only. */
export const shape = (v: unknown): string => {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return `object{${Object.keys(v as object).length}}`;
  if (typeof v === 'string') return v === '' ? 'string(empty)' : `string(${v.length})`;
  return typeof v;
};

/** K3Cloud names a localised caption as [{Key:'zh-CN', Value:'…'}]; collapse it to plain text. */
export const caption = (n: any): string => (Array.isArray(n) ? n.map((x: any) => x?.Value ?? x?.value ?? x).join('/') : String(n?.Value ?? n ?? ''));

/** The metadata's entities and their fields, keys and captions only. */
export type Entity = { key: string; name: string; fields: Array<{ key: string; name: string; type: unknown }> };

export async function formFields(session: CdpSession, formId = FORM): Promise<{ httpStatus: number | null; status: ReturnType<typeof responseStatus>; entities: Entity[] }> {
  const meta = await call(session, 'DynamicFormService.QueryBusinessInfo', [JSON.stringify({ FormId: formId })]);
  const entrys: any[] = meta.parsed?.Result?.NeedReturnData?.Entrys ?? [];
  return {
    httpStatus: meta.httpStatus, status: responseStatus(meta.parsed),
    entities: entrys.map((e) => ({
      key: String(e?.Key ?? e?.Id ?? '?'), name: caption(e?.Name),
      fields: (Array.isArray(e?.Fields) ? e.Fields : []).map((f: any) => ({ key: String(f?.Key ?? f?.FieldName ?? '?'), name: caption(f?.Name), type: f?.FieldType ?? null })),
    })),
  };
}

/** One bill as the model holds it, by 单据编号 or, for a 暂存 draft that has none, by its 内码 (FID). `data` is null when
 * ERP did not return the bill. */
export async function viewBill(session: CdpSession, billNo: string, { byId = false }: { byId?: boolean } = {}) {
  const key = byId ? { Number: '', Id: billNo } : { Number: billNo, Id: '' };
  const view = await call(session, 'DynamicFormService.View', [FORM, JSON.stringify({ CreateOrgId: 0, ...key, IsSortBySeq: 'false' })]);
  const data = view.parsed?.Result?.Result ?? null;
  return { httpStatus: view.httpStatus, ms: view.ms, status: responseStatus(view.parsed), data: data && typeof data === 'object' ? data as Record<string, unknown> : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-out

/**
 * Sign out of the session this spike created. Nothing in the executor or the harness signs out (the product never
 * signed in), so this uses Kingdee's WebAPI `AuthService.Logout` and then PROVES it by reloading: only a reload that
 * lands on the login form counts as signed out. Anything else is reported, and the caller closes the browser anyway.
 */
export async function logout(session: CdpSession, origin: string): Promise<{ httpStatus: number | null; verified: boolean; after: string }> {
  const r = await call(session, 'AuthService.Logout', []);
  await session.send('Page.reload', { ignoreCache: true }).catch(() => null);
  await sleep(2000);
  const after = await waitFor(() => observe(session, origin), (o) => o.verdict === 'not_logged_in' || o.verdict === 'matched', 30_000, 1000);
  return { httpStatus: r.httpStatus, verified: after.verdict === 'not_logged_in', after: after.verdict };
}

// ---------------------------------------------------------------------------------------------------------------
// 暂存 (S5 with --save only)

// Commands that must never be the thing clicked. The 暂存 point is refused if its own id or its caption is any of them.
const FORBIDDEN = /tbSplitSave$|tbSave$|Submit|Approve|Audit|Reject|Delete|Cancel|tbpush|保存|提交|审核|删除|作废/i;

/**
 * The 暂存 command on the open bill's toolbar, measured and hit-tested. Exactly one visible node whose own text is
 * 暂存 and whose nearest id is a BILLMENU_TOOLBAR item, or inside a menu popup the toolbar opened; anything else is
 * no answer. `items` lists the toolbar's visible commands (ids and captions are UI vocabulary, never data).
 */
const DRAFT_POINT = `(() => {
  const vis = ${VIS};
  const hitOf = ${HIT_JS};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const idOf = (n) => { const h = n.closest('[id]'); return h ? h.id : ''; };
  const inMenu = (n) => /BILLMENU_TOOLBAR/.test(idOf(n)) || !!n.closest('.k-menu-group, .k-animation-container, .k-menu-popup');
  const hits = [...document.querySelectorAll('body *')].filter((n) => vis(n) && own(n) === '暂存' && inMenu(n));
  const outer = hits.filter((n) => !hits.some((m) => m !== n && m.contains(n)));
  const items = [...document.querySelectorAll('[id*="BILLMENU_TOOLBAR-"]')].filter(vis)
    .map((n) => n.id.replace(/^.*BILLMENU_TOOLBAR-/, '') + '「' + own(n).slice(0, 8) + '」');
  if (outer.length !== 1) return { ok: false, count: outer.length, items };
  return { ok: true, id: idOf(outer[0]).replace(/^.*BILLMENU_TOOLBAR-/, ''), items, ...hitOf(outer[0]) };
})()`;

/** The 保存 split item's arrow, to HOVER (never press): Kendo menus open their group on mouse-over. */
const SAVE_ARROW = `(() => {
  const vis = ${VIS};
  const hitOf = ${HIT_JS};
  const main = [...document.querySelectorAll('[id$="BILLMENU_TOOLBAR-tbSplitSave"]')].filter(vis);
  if (main.length !== 1) return { ok: false, count: main.length };
  const li = main[0].closest('li.kdmenuitem-splitbutton, li');
  const arrow = li ? [...li.querySelectorAll('.k-i-arrow-s, .k-icon')].filter(vis)[0] : null;
  if (!arrow) return { ok: false, count: 0 };
  return { ok: true, ...hitOf(arrow) };
})()`;

/** Kendo's own API as the fallback: open the 保存 item's group without any pointer event at all. */
const OPEN_SAVE_GROUP = `(() => {
  const main = document.querySelector('[id$="BILLMENU_TOOLBAR-tbSplitSave"]');
  const li = main && main.closest('li');
  const menuEl = li && li.closest('ul.k-menu, .k-menu');
  const menu = menuEl && window.jQuery && window.jQuery(menuEl).data('kendoMenu');
  if (!menu || typeof menu.open !== 'function') return false;
  menu.open(li);
  return true;
})()`;

type DraftPoint = Partial<Reach> & { ok: boolean; count?: number; id?: string; items?: string[] };

/**
 * Press 暂存 on the open bill, and nothing else. The point is accepted only when its caption is exactly 暂存, its id is
 * not on FORBIDDEN, and the hit test says a mouse event there reaches it. When 暂存 sits in the 保存 split item's
 * group, the group is opened by HOVERING its arrow (a mouse move, no button) or by Kendo's API — never by a press,
 * because a press on that item is 保存.
 */
export async function pressDraft(session: CdpSession): Promise<{ ok: boolean; id: string | null; items: string[]; how: string; why?: string }> {
  const find = () => evalIn<DraftPoint>(session, DRAFT_POINT);
  const ready = (p: DraftPoint | null) => p?.ok === true && p.onTarget === true;
  let point = await find();
  let how = 'toolbar';
  if (!ready(point)) {
    const arrow = await evalIn<DraftPoint>(session, SAVE_ARROW);
    if (arrow?.ok && arrow.inView && typeof arrow.x === 'number' && typeof arrow.y === 'number') {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: arrow.x, y: arrow.y, buttons: 0 });
      how = 'hover 保存 arrow';
      point = await waitFor(find, ready, 5000, 300);
    }
  }
  if (!ready(point)) {
    if (await evalIn<boolean>(session, OPEN_SAVE_GROUP).catch(() => false)) {
      how = 'kendoMenu.open';
      point = await waitFor(find, ready, 5000, 300);
    }
  }
  const items = point?.items ?? [];
  if (!ready(point)) return { ok: false, id: null, items, how, why: point?.ok ? '「暂存」被遮住，点不到' : `找不到唯一的「暂存」（匹配 ${point?.count ?? 0} 个）` };
  if (FORBIDDEN.test(point.id ?? '')) return { ok: false, id: point.id ?? null, items, how, why: `「暂存」所在控件的 id 是 ${point.id}，看起来不是暂存，没有点` };
  await clickReach(session, point, '「暂存」');
  return { ok: true, id: point.id ?? null, items, how };
}
