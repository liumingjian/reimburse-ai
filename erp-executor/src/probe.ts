// Origin: 50931a3:kernel/src/probe.mjs. The read-only login probe: it reads what is already on the page and never
// navigates, clicks or calls a business service. Per ADR-0016 the probed identity is recorded, never compared.
//
// Facts measured on K3Cloud 8.2.0 (ADR-0002 addendum, ledger V-27 and V-42):
//   1. The login page and the main console share one URL, so the URL proves nothing;
//   2. The logged-in console holds four hidden password inputs, so "a password input exists" is no logout signal,
//      but a *visible* password input plus a visible login button is the login page;
//   3. `k3cloudloginInfo` in localStorage survives logout, so it cannot count on its own.
// An identity therefore needs all three: the console user name, and the stored account and 账套 (account set).

import { evaluateChromiumPage, listChromiumPages } from './chromium';
import { ExecutorError, safeUrl, type ChromiumPage } from './page';

export const DEFAULT_ERP_ORIGIN = 'http://erp.antute.com.cn';
export const erpEntryOf = (origin: string) => `${origin}/k3cloud/html5/index.aspx`;

/** Compare origins structurally; a same-prefix hostname is a different site. */
export const sameOrigin = (value: unknown, expected: unknown) => {
  try { return new URL(String(value)).origin === new URL(String(expected)).origin; } catch { return false; }
};

const USER_SELECTOR = 'span.kd-mainconsole-usernametext';

export const READ_ONLY_SNIPPET = `(() => {
  const el = document.querySelector(${JSON.stringify(USER_SELECTOR)});
  const displayName = el ? el.textContent.trim() : null;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('k3cloudloginInfo') || 'null'); } catch {}
  const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const passwords = [...document.querySelectorAll('input[type=password]')];
  return {
    url: location.origin + location.pathname,
    ready: document.readyState,
    title: document.title,
    displayName: displayName || null,
    account: stored && stored.user ? String(stored.user) : null,
    tenant: stored && stored.acc ? String(stored.acc) : null,
    onMainConsole: !!document.querySelector('.kd-mainconsole, [class*=mainconsole]'),
    loginFormVisible: passwords.some(visible)
      && [...document.querySelectorAll('button, input[type=submit]')]
        .some((n) => visible(n) && /登\\s*录|sign\\s*in|log\\s*in/i.test(n.textContent || n.value || '')),
  };
})()`;

export type Observation = {
  url?: string; ready: string; title?: string; displayName: string | null; account: string | null; tenant: string | null;
  onMainConsole?: boolean; loginFormVisible?: boolean;
};

export type ProbeVerdict =
  | { status: 'matched'; identity: { displayName: string; account: string; tenant: string } }
  | { status: 'not_logged_in' | 'unknown'; hint: string };

const hasText = (value: unknown) => (typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined);

/** Judge one page observation. Pure: fetching needs a browser, judging does not. Null means "says nothing yet". */
export function identityFromObservation(info: Observation | null | undefined, { transport = 'default', origin = DEFAULT_ERP_ORIGIN }: { transport?: string | { kind?: string }; origin?: string } = {}): ProbeVerdict | null {
  if (!info || info.ready !== 'complete') return null;
  const cdp = transport === 'chromium-cdp' || (typeof transport === 'object' && transport?.kind === 'chromium-cdp');
  // Where the page is, in words true for every CDP run: the 本地执行器's Chromium, and the dedicated Chromium of
  // development and e2e. Each opens a tab of its own for the job.
  const page = cdp ? '为这次报销打开的报销系统标签页' : '系统默认浏览器里的报销系统页面';

  if (hasText(info.displayName) && hasText(info.account) && hasText(info.tenant)) {
    return { status: 'matched', identity: { displayName: info.displayName!, account: info.account!, tenant: info.tenant! } };
  }
  if (hasText(info.displayName)) {
    const missing = [!hasText(info.account) ? '登录账号' : null, !hasText(info.tenant) ? '账套' : null].filter(Boolean);
    return { status: 'unknown', hint: `页面读到了显示名，但缺少${missing.join('和')}；身份不能确定读出就不接管，请人工看一眼${page}` };
  }
  // No user name: a visible login form means "go and log in"; nothing readable at all needs a person to look.
  return info.loginFormVisible
    ? { status: 'not_logged_in', hint: `${page}停在登录页（${erpEntryOf(origin)}）。请你本人在这个页面里登录，回到主控制台之后再探测；baox 不代填账号密码。注意登录页上也读得出上次登录的账号，那不算已登录。` }
    : { status: 'unknown', hint: `页面已加载完成，既读不出 ${USER_SELECTOR}，也看不见登录表单；身份不能确定读出就不接管，请人工看一眼${page}` };
}

type Page = ChromiumPage | (Record<string, unknown> & { url: string });

export type ProbeResult = {
  status: 'matched' | 'not_logged_in' | 'loading' | 'no_tab' | 'unknown';
  origin: string; transport?: string | undefined; hint?: string; identity?: { displayName: string; account: string; tenant: string };
  observed?: Observation | null; errors?: string[]; targetId?: string; tabId?: string | null; page?: Page; pageCount?: number;
};

/**
 * Probe the ERP session: who is logged in right now. `matched` only says someone is logged in and readable;
 * it says nothing about whether that person should file this reimbursement (ADR-0016: recorded, not compared).
 */
export async function probeIdentity({
  origin = DEFAULT_ERP_ORIGIN, waitMs = 30_000, transport = { kind: 'chromium-cdp' } as string | { kind?: string; transport?: string },
  listTabs = (() => listChromiumPages()) as (options: { origin: string; transport: unknown }) => Promise<Page[]>,
  evaluate = ((page: Page, expression: string) => evaluateChromiumPage(page as ChromiumPage, expression, { timeoutMs: 10_000 })) as (page: Page, expression: string, options: { origin: string; timeoutMs: number }) => Promise<Observation>,
  pollMs = 1000,
}: {
  origin?: string; waitMs?: number; transport?: string | { kind?: string; transport?: string };
  listTabs?: (options: { origin: string; transport: unknown }) => Promise<Page[]>;
  evaluate?: (page: Page, expression: string, options: { origin: string; timeoutMs: number }) => Promise<Observation>;
  pollMs?: number;
} = {}): Promise<ProbeResult> {
  const deadline = Date.now() + waitMs;
  let last: { observed: Observation; errors: string[] } | null = null;
  let unsettled: ProbeResult | null = null;
  const transportKind = typeof transport === 'string' ? transport : transport?.kind ?? transport?.transport;
  const cdp = transportKind === 'chromium-cdp';
  const reportedTransport = cdp ? 'chromium-cdp' : transportKind;
  const where = cdp ? '为这次报销打开的标签页' : '系统默认浏览器';

  do {
    const pages = (await listTabs({ origin, transport })).filter((t) => sameOrigin(t.url, origin));
    if (pages.length === 0) {
      return { status: 'no_tab', origin, ...(reportedTransport ? { transport: reportedTransport } : {}), hint: `请在${where}中打开 ${erpEntryOf(origin)} 并登录` };
    }
    if (!cdp && transportKind === 'default' && pages.length > 1) {
      return { status: 'unknown', origin, transport: reportedTransport, pageCount: pages.length,
        hint: `系统默认浏览器里发现 ${pages.length} 个 ERP 页面；请保留唯一的目标 ERP 页面后再试，我不会替你选择其中一个` };
    }
    const errors: string[] = [];
    let sawLoading = false;
    let fallback: ProbeResult | null = null;
    for (const page of pages) {
      let info: Observation;
      try {
        info = await evaluate(page, READ_ONLY_SNIPPET, { origin, timeoutMs: 10_000 });
      } catch (error: any) {
        // Permission and control errors must stop the caller; they are not "not logged in".
        if (/^DEFAULT_BROWSER_(?:UNSUPPORTED|NOT_RUNNING|AUTOMATION_PERMISSION_REQUIRED|JAVASCRIPT_PERMISSION_REQUIRED|ORIGIN_REQUIRED|PAGE_REQUIRED)/.test(error?.code ?? '')
          || error instanceof ExecutorError) throw error;
        errors.push(`${safeUrl(page.url)}: ${error?.message ?? String(error)}`);
        continue;
      }
      last = { observed: info, errors };
      // The ERP first screen is slow; not loaded is not logged out.
      if (info.ready !== 'complete') { sawLoading = true; continue; }
      const verdict = identityFromObservation(info, { transport: cdp ? 'chromium-cdp' : String((page as { transport?: string }).transport ?? 'default'), origin })!;
      if (verdict.status === 'matched') {
        const p = page as Record<string, any>;
        const targetId = p.cdpTargetId ?? p.tabId ?? p.pageId ?? `${p.windowId}:${p.index}`;
        return { ...verdict, ...last, transport: reportedTransport, origin, targetId: String(targetId), tabId: p.tabId ?? null, page };
      }
      if (!fallback || verdict.status === 'not_logged_in') fallback = { ...verdict, origin, ...last, page };
    }
    // `unknown` on a loaded page is often a moment, not a state: Kingdee reports `complete` before it paints the
    // login form or the console (live 2026-10-12, S8). It is looked at again within the wait, and only stands when
    // the wait runs out on it.
    unsettled = fallback?.status === 'unknown' ? fallback : null;
    if (!sawLoading && !unsettled) {
      if (fallback) return fallback;
      return { status: 'unknown', origin, observed: null, errors, hint: `${where}里的 ERP 页面全都读不出来；请人工看一眼这个窗口` };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);

  if (unsettled) return unsettled;
  return { status: 'loading', origin, ...last, hint: `ERP 页面 ${waitMs}ms 内没有加载完成` };
}

/**
 * The compatibility fingerprint source: the ERP build and the form id on the current page.
 * Verified against the live ERP (金蝶云星空 K3Cloud) on 2026-09-19, which corrected three guesses:
 *   - the build is not stated by any element on the form page. The `8.2.0.20250701` in exploration.md is the
 *     release the LOGIN page prints, and this snippet runs long after login. What the console does publish is the
 *     `?ver=` cache-busting suffix on its static assets, hung on `window.KDResVer`, reading `8.2.830.9`. That is the
 *     better tripwire anyway: it moves when the front-end resources move, which is when these selectors break;
 *   - the form id attribute is `data-kdformid`, not `data-formid`;
 *   - the console shell carries a form id of its own (`BOS_HtmlConsole`), so the whole document holds several.
 *     Only the tab panels are asked, where one open 费用报销单 means exactly one id; the shell's own id sits on an
 *     ancestor of the panels and stays out.
 *
 * It asks EVERY active panel, not `querySelector`'s first one. On 2026-09-19 a run died with
 * `compatibility_mismatch … 期望 8.2.830.9 / ER_ExpReimbursement，实际 8.2.830.9 / 0 个表单`: the build matched and
 * the form id read as zero, because the first `.k-content.k-state-active` in the document was the CONSOLE's panel —
 * Kendo had not yet moved the class onto the freshly opened form's tab — and the console's panel holds no form id.
 * Re-probing the same untouched page minutes later returned `formIds: ["ER_ExpReimbursement"]`. `activePanels` is
 * reported so a caller that gets no form id can say whether it was looking at a panel at all, and the caller polls:
 * a fingerprint read the instant a tab opens is a race, not a verdict.
 */
export const COMPATIBILITY_SNIPPET = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const erpBuild = (/\\d+(?:\\.\\d+)+/.exec(String(window.KDResVer || '')) || [null])[0];
  const panels = [...document.querySelectorAll('.k-content.k-state-active')].filter(vis);
  const scopes = panels.length ? panels : [document];
  const forms = scopes.flatMap((scope) => [...scope.querySelectorAll('[data-kdformid]')].filter(vis)
    .map((n) => n.getAttribute('data-kdformid')));
  return { erpBuild, formIds: [...new Set(forms)], activePanels: panels.length };
})()`;
