// Signing in to ERP with the employee's ERP 凭据, and out again, for the headless path (ADR-0033): nobody sees that
// browser, so baox fills the login form itself.
//
// What is handled is what the S2 and S8 runs met on the Mac mini (docs/design/erp-headless-v1.md, server/scripts/spike/
// erp.ts holds the measured version with its diagnostics):
//   - the login page reports `readyState complete` long before Kendo lays the form out, and a form submitted before
//     its data-centre list and language resources arrived answers 「语言未加载」 or does nothing at all;
//   - over a slow link the console's own scripts take longer than RequireJS's 30 s, so they are fetched into the HTTP
//     cache first (the same URLs, the same `?ver=`);
//   - 「该帐号已登录在线」 asks before knocking the account's other session off, which the owner accepted.
// A login the ERP refuses is never submitted again, so baox cannot lock the ERP account; a second factor stops too.
// The secret goes into the page it authenticates and nowhere else: not into a result, a message or a log.

import { evalIn, type CdpSession } from './cdp';
import { HIT_JS, clickReach, type Reach } from './hit';
import { sleep, waitFor } from './pace';
import { erpEntryOf, identityFromObservation, READ_ONLY_SNIPPET, type Observation } from './probe';
import { signInSnippet } from './recording/sign-in';

export type ErpCredentials = { account: string; password: string };

type Prompt = { text: string; reach: Reach | null };

/** One look at the page: who the executor's own probe sees, and what the login form shows. Facts, never values. */
export type LoginLook = {
  /** The probe's verdict on this page (`probe.ts`). */
  verdict: string;
  onMainConsole: boolean;
  form: boolean;
  /** The data-centre list has entries, or the page has none. */
  dataCentreReady: boolean;
  languageMissing: Prompt | null;
  alreadyOnline: Prompt | null;
  /** Visible controls that look like a captcha, an SMS code or a dynamic password. */
  secondFactor: string[];
  /** Visible short texts that read as a refusal (密码错误, 已锁定 …). */
  errors: string[];
  /** Requests the page has completed so far: unchanged since a submit means the click reached nothing. */
  requests: number;
};

export type SignInOutcome =
  | { ok: true; submitted: boolean; ms: number }
  | { ok: false; code: SignInFailure; message: string; ms: number };

export type SignInFailure =
  | 'erp_sign_in_no_form' | 'erp_sign_in_unfillable' | 'erp_sign_in_refused' | 'erp_sign_in_second_factor'
  | 'erp_sign_in_language' | 'erp_sign_in_timeout';

/** What `signInWith` does to the page. `signIn` wires these to CDP; a test scripts them. */
export type SignInPorts = {
  look(): Promise<LoginLook | null>;
  submit(): Promise<boolean>;
  confirm(reach: Reach, label: string): Promise<void>;
  reload(): Promise<void>;
  prefetch(): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type SignInTiming = {
  /** For the login form to appear. */
  formMs: number;
  /** Without a form for this long, the entry page is loaded again (default: a third of `formMs`). */
  formReloadMs?: number;
  /** For the login page to set itself up; once more after a reload. Over the Mac's link kendo alone took ~48 s. */
  readyMs: number;
  /** How long no new request must complete before the page counts as set up. */
  quietMs: number;
  /** After submitting, for the console. Long enough to tell a slow ERP from a hung one. */
  consoleMs: number;
  /** A submit after which no request completes for this long did nothing, and is repeated. */
  noEffectMs: number;
  /** A refusal, second factor or unconfirmable prompt that stays this long is the login's answer. */
  stuckMs: number;
  pollMs: number;
};

// formMs / formReloadMs: live 2026-10-20 an entry page loaded again showed its form after 2.3 s once and 29.5 s once,
// and a load cut short at 20 s showed none; so the entry page is loaded again every 40 s, three loads in all.
export const SIGN_IN_TIMING: SignInTiming = {
  formMs: 120_000, formReloadMs: 40_000, readyMs: 120_000, quietMs: 1500, consoleMs: 300_000, noEffectMs: 20_000, stuckMs: 10_000, pollMs: 1000,
};

/** Resubmits after 「语言未加载」 or a click that did nothing. A refusal is never resubmitted. */
const RESUBMITS = 2;

/** The login as a sequence of looks and acts, independent of how the page is reached. */
export async function signInWith(ports: SignInPorts, timing: SignInTiming = SIGN_IN_TIMING): Promise<SignInOutcome> {
  const now = ports.now ?? Date.now;
  const pause = ports.sleep ?? sleep;
  const started = now();
  const fail = (code: SignInFailure, message: string): SignInOutcome => ({ ok: false, code, message, ms: now() - started });
  const signedIn = (look: LoginLook | null) => look?.verdict === 'matched' && look.onMainConsole;

  // Already in: a persistent profile whose last session was never signed out.
  const first = await ports.look();
  if (signedIn(first)) return { ok: true, submitted: false, ms: now() - started };

  // 1. The form itself, not readyState. Live 2026-10-20 2 of 21 entry pages never showed it (a body left empty for
  //    90 s; a load that timed out) and loading the entry page again brought it in 2-30 s, so that is done every
  //    `formReloadMs` within `formMs`.
  const formDeadline = now() + timing.formMs;
  const reloadEvery = timing.formReloadMs ?? timing.formMs / 3;
  let look = first;
  while (!look?.form && !signedIn(look)) {
    look = await poll(ports, (l) => l?.form === true || signedIn(l), Math.min(reloadEvery, formDeadline - now()), timing.pollMs, now, pause);
    if (look?.form || signedIn(look) || now() >= formDeadline) break;
    await ports.reload();
  }
  if (signedIn(look)) return { ok: true, submitted: false, ms: now() - started };
  if (!look?.form) return fail('erp_sign_in_no_form', `${Math.round(timing.formMs / 1000)} 秒内没有出现报销系统登录表单。`);

  // 2. Set up: list filled, no 语言未加载, nothing new arriving. One reload if it never is; then submit regardless.
  const settle = async () => {
    const deadline = now() + timing.readyMs;
    let quietSince: number | null = null;
    let seen = -1;
    while (now() < deadline) {
      const l = await ports.look();
      const ready = !!l?.form && l.dataCentreReady && !l.languageMissing;
      if (ready && l!.requests === seen) {
        quietSince ??= now();
        if (now() - quietSince >= timing.quietMs) return true;
      } else quietSince = null;
      seen = l?.requests ?? -1;
      await pause(Math.min(500, timing.pollMs));
    }
    return false;
  };
  if (!(await settle())) {
    await ports.reload();
    await poll(ports, (l) => l?.form === true, timing.formMs, timing.pollMs, now, pause);
    await settle();
  }
  await ports.prefetch();

  // 3. Submit, and watch.
  const before = new Set((await ports.look())?.secondFactor ?? []);
  let submits = 0;
  let sentAt = 0;
  let requestsAtSubmit = -1;
  const submit = async () => {
    requestsAtSubmit = (await ports.look())?.requests ?? -1;
    if (!(await ports.submit())) return false;
    submits += 1;
    sentAt = now();
    return true;
  };
  if (!(await submit())) return fail('erp_sign_in_unfillable', '报销系统登录页上找不到账号框、密码框或「登录」按钮，没有登录。');

  let deadline = now() + timing.consoleMs;
  let stuckSince: number | null = null;
  let confirmedOnline = false;
  while (now() < deadline) {
    await pause(timing.pollMs);
    look = await ports.look();
    if (signedIn(look)) return { ok: true, submitted: true, ms: now() - started };
    if (!look) continue;
    if (look.languageMissing?.reach?.onTarget && submits <= RESUBMITS) {
      await ports.confirm(look.languageMissing.reach, '「语言未加载」的确定');
      await settle();
      if (!(await submit())) return fail('erp_sign_in_unfillable', '确认「语言未加载」之后，登录表单填不进去了。');
      deadline = now() + timing.consoleMs;
      stuckSince = null;
      continue;
    }
    if (look.alreadyOnline?.reach?.onTarget && !confirmedOnline) {
      // ADR-0033: logging in knocks this ERP account's other session off; the employee was told before 去报销.
      await ports.confirm(look.alreadyOnline.reach, '「该帐号已登录在线」的确认');
      confirmedOnline = true;
      continue;
    }
    if (look.form && !look.languageMissing && !look.alreadyOnline && look.errors.length === 0
      && look.requests === requestsAtSubmit && now() - sentAt > timing.noEffectMs && submits <= RESUBMITS) {
      if (!(await submit())) return fail('erp_sign_in_unfillable', '再次提交时登录表单填不进去了。');
      deadline = now() + timing.consoleMs;
      continue;
    }
    // Only while the form is still up: text on a console that is still loading is not the login's answer.
    const fresh = look.secondFactor.filter((s) => !before.has(s));
    if (look.form && (fresh.length || look.errors.length || look.languageMissing)) {
      stuckSince ??= now();
      if (now() - stuckSince >= timing.stuckMs) {
        if (fresh.length) return fail('erp_sign_in_second_factor', `报销系统登录要求第二道校验（${fresh.join('、')}），baox 无法代为完成。`);
        if (look.errors.length) return fail('erp_sign_in_refused', `报销系统拒绝了这组账号密码：${look.errors.join('；')}。baox 不会再用它重试。`);
        return fail('erp_sign_in_language', `报销系统一直提示「${look.languageMissing!.text}」，已提交 ${submits} 次。`);
      }
    } else stuckSince = null;
  }
  return fail('erp_sign_in_timeout', `提交登录后 ${Math.round(timing.consoleMs / 1000)} 秒没有进入报销系统主页。`);
}

async function poll(ports: SignInPorts, ok: (look: LoginLook | null) => boolean, ms: number, pollMs: number, now: () => number, pause: (ms: number) => Promise<void>) {
  const deadline = now() + ms;
  let look = await ports.look();
  while (!ok(look) && now() < deadline) {
    await pause(pollMs);
    look = await ports.look();
  }
  return look;
}

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;

// The login page's facts (measured in the spike's LOGIN_FACTS). The resource-timing buffer is enlarged first: at its
// default 250 entries it stops counting, and a count that stops would read as a click that did nothing.
const LOGIN_LOOK = `(() => {
  const vis = ${VIS};
  const hitOf = ${HIT_JS};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  try { performance.setResourceTimingBufferSize(100000); } catch (e) {}
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
  const prompt = (re) => {
    const hits = leaves.filter((n) => re.test(txt(n)));
    if (!hits.length) return null;
    let box = hits[0];
    const confirms = (root) => [...root.querySelectorAll('button, a, input[type=button], span, div[role=button]')]
      .filter((n) => vis(n) && /^(确定|确认)$/.test(String(n.value || txt(n))));
    for (let i = 0; i < 8 && box.parentElement && confirms(box).length === 0; i += 1) box = box.parentElement;
    const found = confirms(box);
    const outer = found.filter((n) => !found.some((m) => m !== n && m.contains(n)));
    return { text: txt(hits[0]).slice(0, 80), reach: outer.length === 1 ? hitOf(outer[0]) : null };
  };
  const dc = document.getElementById('datacenter_ct');
  return {
    form: [...document.querySelectorAll('input[type=password]')].some(vis),
    dataCentreReady: !dc || dc.querySelectorAll('li, option').length > 0 || txt(dc).length > 0,
    languageMissing: prompt(/语言未加载/),
    alreadyOnline: prompt(/已登录在线|已在其他|已经登录|在线用户/),
    secondFactor: [...new Set(secondFactor)].slice(0, 8),
    errors: leaves.map(txt).filter((t) => t.length <= 80 && /密码错误|用户名或密码|不存在|已锁定|锁定|登录失败|错误|过期|禁用/.test(t)).slice(0, 3),
    requests: performance.getEntriesByType('resource').length,
  };
})()`;

// After ValidateLoginInfo the page loads the console's scripts through RequireJS with waitSeconds:30; kendo.all.min.js
// (2.8 MB) and k3cloud.min.js (3.4 MB) come uncompressed. Fetched first with the loader's own `?ver=`, they are in the
// HTTP cache when the loader asks. Without window.KDResVer the loader appends a timestamp and nothing can be cached.
const CONSOLE_SCRIPTS = ['thirdpart/kendo/kendo.all.min.js', 'k3cloud.min.js', 'kdvgrid.min.js'];
const PREFETCH = `(async () => {
  const res = window.KDResVer ? String(window.KDResVer) : '';
  if (!res) return false;
  const root = (window.KD && typeof KD.getUrlRoot === 'function' && typeof KD.getSubPath === 'function')
    ? KD.getUrlRoot() + '/' + KD.getSubPath() + '/script' : location.origin + '/k3cloud/html5/script';
  for (const file of ${JSON.stringify(CONSOLE_SCRIPTS)}) {
    try { await (await fetch(root + '/' + file + '?ver=' + encodeURIComponent(res.substring(5)), { cache: 'force-cache', credentials: 'include' })).arrayBuffer(); } catch (e) {}
  }
  return true;
})()`;

async function lookAt(session: CdpSession, origin: string): Promise<LoginLook | null> {
  const observed = await evalIn<Observation>(session, READ_ONLY_SNIPPET, { timeout: 15_000 }).catch(() => null);
  const facts = await evalIn<Omit<LoginLook, 'verdict' | 'onMainConsole'>>(session, LOGIN_LOOK, { timeout: 10_000 }).catch(() => null);
  if (!facts) return null;
  const verdict = identityFromObservation(observed, { transport: 'chromium-cdp', origin });
  return { ...facts, verdict: verdict?.status ?? 'loading', onMainConsole: observed?.onMainConsole === true };
}

/** Sign in on `session`'s page, which shows the ERP entry. */
export function signIn(session: CdpSession, { origin, credentials, timing }: { origin: string; credentials: ErpCredentials; timing?: SignInTiming }): Promise<SignInOutcome> {
  return signInWith({
    look: () => lookAt(session, origin),
    submit: async () => (await evalIn<{ ok: boolean }>(session, signInSnippet(credentials.account, credentials.password)).catch(() => null))?.ok === true,
    confirm: async (reach, label) => { await clickReach(session, reach, label); },
    // The entry page loaded again, not a Page.reload: live 2026-10-20 a reload left a timed-out load where it was, and
    // navigating brought the form.
    reload: async () => { await session.send('Page.navigate', { url: erpEntryOf(origin) }).catch(() => null); await sleep(2000); },
    prefetch: async () => { await evalIn(session, PREFETCH, { timeout: 240_000 }).catch(() => null); },
  }, timing);
}

const LOGOUT = `(async () => {
  const sid = (document.cookie.match(/(?:^|;\\s*)kdservice-sessionid=([^;]+)/) || [])[1] || '';
  const r = await fetch('/k3cloud/Kingdee.BOS.WebApi.ServicesStub.AuthService.Logout.common.kdsvc', {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'kdservice-sessionid': decodeURIComponent(sid) } : {}),
    body: JSON.stringify({ parameters: [] }),
  });
  return r.status;
})()`;

/**
 * Sign out with Kingdee's WebAPI `AuthService.Logout`. With `verify`, prove it too: only a reload that lands on the
 * login form counts. Without it — a browser about to be closed, whose page may still hold an unsaved form that a
 * reload would ask about — the logout's own HTTP answer is all there is. Never throws; the caller closes the browser
 * whatever this says.
 */
export async function signOut(session: CdpSession, { origin, verify = true, waitMs = 30_000 }: { origin: string; verify?: boolean; waitMs?: number }): Promise<{ httpStatus: number | null; verified: boolean }> {
  const httpStatus = await evalIn<number>(session, LOGOUT, { timeout: 30_000 }).catch(() => null);
  if (!verify) return { httpStatus, verified: false };
  await session.send('Page.reload', { ignoreCache: false }).catch(() => null);
  const after = await waitFor(() => lookAt(session, origin), (l) => l?.verdict === 'not_logged_in' || l?.verdict === 'matched', waitMs, 1000).catch(() => null);
  return { httpStatus, verified: after?.verdict === 'not_logged_in' };
}
