import { isEgoControlError } from './ego.mjs';
import {
  browserTransport,
  evaluateBrowserPage,
  listBrowserTabs,
  safeUrl,
} from './browser-read.mjs';

export const ERP_ORIGIN = process.env.BAOX_ERP_ORIGIN || 'http://erp.antute.com.cn';
export const ERP_ENTRY = `${ERP_ORIGIN}/k3cloud/html5/index.aspx`;

/** Compare origins structurally; a same-prefix hostname is a different site. */
export const sameOrigin = (value, expected) => {
  try { return new URL(value).origin === new URL(expected).origin; } catch { return false; }
};

// 只读探测：只读取页面上已经存在的信息，不导航、不点击、不调用任何业务接口、不写入任何字段。
//
// 实测得到的事实（K3Cloud 8.2.0，见 ADR-0002 补记与台账 V-27、V-42）：
//   1. 登录页和主控制台是**同一个 URL**（`html5/index.aspx`），所以不能按 URL 判断；
//   2. 已登录的主控制台里有 4 个隐藏的 input[type=password]（改密弹窗），
//      所以"存在密码框"永远不能当作未登录信号 —— 但"**可见**的密码框
//      加一个可见的登录按钮"可以，登录页正是这一档（2026-09-05 实测）；
//   3. Getk3cloudloginInfo() 在命名用户登录下返回 null，没有现成的身份全局变量；
//   4. localStorage 的 k3cloudloginInfo 在**登出之后依然留着**账号 ——
//      2026-09-05 在登录页上仍读出 account，这是它不能单独算数的直接证据。
//
// 因此身份只认三个信号，缺一不可：
//   会话信号 —— 主控制台的用户名元素 span.kd-mainconsole-usernametext 有非空文本；
//   账号和账套信号 —— localStorage 的 k3cloudloginInfo.user / .acc（比显示名稳定）。
const USER_SELECTOR = 'span.kd-mainconsole-usernametext';

const READ_ONLY_SNIPPET = `(() => {
  const el = document.querySelector(${JSON.stringify(USER_SELECTOR)});
  const displayName = el ? el.textContent.trim() : null;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('k3cloudloginInfo') || 'null'); } catch {}
  const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const passwords = [...document.querySelectorAll('input[type=password]')];
  return {
    // 只回报去掉 query 的地址：K3Cloud 的 _cnneptstate_ 参数是会话态，
    // 属于短时效 URL，按契约不进日志、不进输出。
    url: location.origin + location.pathname,
    ready: document.readyState,
    title: document.title,
    displayName: displayName || null,
    account: stored && stored.user ? String(stored.user) : null,
    tenant: stored && stored.acc ? String(stored.acc) : null,
    // 主控制台按 DOM 判定，不按 URL —— URL 两边一模一样。
    onMainConsole: !!document.querySelector('.kd-mainconsole, [class*=mainconsole]'),
    // 登录页的签名：可见的密码框 + 可见的登录按钮。两者都要，
    // 因为改密弹窗也有密码框，只是它藏着。
    loginFormVisible: passwords.some(visible)
      && [...document.querySelectorAll('button, input[type=submit]')]
        .some((n) => visible(n) && /登\\s*录|sign\\s*in|log\\s*in/i.test(n.textContent || n.value || '')),
  };
})()`;

/**
 * 从一次页面观测里判定身份。纯函数，把判断和取数分开：
 * 取数要浏览器，判断不要 —— 而需要被钉住的是判断。
 *
 * 返回 null 表示"这一页说明不了什么"，交给调用方看别的页面或继续等。
 */
export function identityFromObservation(info, { transport = 'default' } = {}) {
  if (!info || info.ready !== 'complete') return null;
  const cdp = transport === 'chromium-cdp' || transport?.kind === 'chromium-cdp';
  const location = transport === 'ego'
    ? 'ego task space' : cdp ? '报销专用 Chromium 浏览器' : '系统默认浏览器';
  const hasText = (value) => typeof value === 'string' ? value.trim().length > 0
    : value !== null && value !== undefined;

  // 这里只回答"这一页上是谁在登录着"。它是不是**该报销的那个人**，
  // 由个人绑定去判（binding.mjs）—— 会话信号和身份判据是两件事，
  // 混在一起判过一次，代价是一个永远说不清自己错在哪的探测结果。
  if (hasText(info.displayName) && hasText(info.account) && hasText(info.tenant)) {
    return { status: 'matched',
      identity: { displayName: info.displayName, account: info.account, tenant: info.tenant } };
  }

  if (hasText(info.displayName)) {
    const missing = [
      !hasText(info.account) ? '登录账号' : null,
      !hasText(info.tenant) ? '账套' : null,
    ].filter(Boolean);
    return { status: 'unknown',
      hint: `页面读到了显示名，但缺少${missing.join('和')}；`
        + `身份不能确定读出就不接管，请人工看一眼这个${location}页面` };
  }

  // 读不出用户名。分两档，因为处置完全不同：
  // 看得见登录表单 —— 会话没了或还没登录，用户去登录就行；
  // 两样都读不出 —— 页面变了或出了别的问题，那要人来看，不是重试能解决的。
  return info.loginFormVisible
    ? { status: 'not_logged_in',
        hint: `${location}里的 ERP 停在登录页（${ERP_ENTRY}）。`
          + '请你本人在这个页面里登录，回到主控制台之后再探测；baox 不代填账号密码。'
          + '注意登录页上也读得出上次登录的账号，那不算已登录。' }
    : { status: 'unknown',
        hint: `页面已加载完成，既读不出 ${USER_SELECTOR}，也看不见登录表单；`
          + `身份不能确定读出就不接管，请人工看一眼这个${location}页面` };
}

/**
 * 探测 ERP 的**会话**：当前选定浏览器传输里现在登录着的是谁。
 *   matched | not_logged_in | loading | no_tab | unknown
 *
 * matched 只说明"有人登录着并且读得出他是谁"，不说明这个人就是该报销的人。
 * 业务侧一律走 binding.mjs 的 gateIdentity()，它在这之上再过一道个人绑定。
 */
export async function probeIdentity({ origin = ERP_ORIGIN, waitMs = 30000,
  transport = browserTransport(), listTabs = listBrowserTabs,
  evaluate = evaluateBrowserPage, platform = process.platform, run } = {}) {
  const deadline = Date.now() + waitMs;
  let last = null;
  const transportKind = typeof transport === 'string'
    ? transport : transport?.kind ?? transport?.transport;
  const cdp = transportKind === 'chromium-cdp';
  const reportedTransport = cdp ? 'chromium-cdp' : transportKind;

  do {
    const browserOptions = { origin, transport, platform };
    if (run) browserOptions.run = run;
    const pages = (await listTabs(browserOptions)).filter((t) => sameOrigin(t.url, origin));
    if (pages.length === 0) {
      const where = transportKind === 'ego'
        ? 'ego task space' : cdp ? '报销专用 Chromium 浏览器' : '系统默认浏览器';
      return { status: 'no_tab', origin, transport: reportedTransport,
        hint: `请在${where}中打开 ${ERP_ENTRY} 并登录` };
    }
    if (!cdp && transportKind === 'default' && pages.length > 1) {
      return { status: 'unknown', origin, transport: reportedTransport, pageCount: pages.length,
        hint: `系统默认浏览器里发现 ${pages.length} 个 ERP 页面；请保留唯一的目标 ERP 页面后再试，`
          + '我不会替你选择其中一个' };
    }
    const errors = [];
    let sawLoading = false;
    let fallback = null;
    for (const page of pages) {
      let info;
      try {
        const evaluateOptions = { origin, timeoutMs: 10000, platform };
        if (run) evaluateOptions.run = run;
        info = await evaluate(page, READ_ONLY_SNIPPET, evaluateOptions);
      } catch (err) {
        if (isEgoControlError(err) || /^DEFAULT_BROWSER_(?:UNSUPPORTED|NOT_RUNNING|AUTOMATION_PERMISSION_REQUIRED|JAVASCRIPT_PERMISSION_REQUIRED|ORIGIN_REQUIRED|PAGE_REQUIRED)/.test(err?.code ?? '')) {
          throw err;
        }
        errors.push(`${safeUrl(page.url)}: ${err.message}`);
        continue;
      }
      last = { observed: info, errors };
      // ERP 首屏很慢，没加载完不算未登录，等就是了。
      if (info.ready !== 'complete') { sawLoading = true; continue; }

      const verdict = identityFromObservation(info, { transport: cdp ? 'chromium-cdp' : page.transport });
      // 认得出身份的页面说了算；只有所有页面都说不出身份时，才轮到登录页/异常这两档。
      if (verdict.status === 'matched') {
        const targetId = page.tabId ?? page.pageId ?? `${page.windowId}:${page.index}`;
        return { ...verdict, ...last, transport: reportedTransport, origin,
          ...(page.taskSpace === undefined ? {} : { taskSpace: page.taskSpace }),
          targetId, tabId: page.tabId ?? null, page };
      }
      // 多个标签页时，"停在登录页"比"什么都读不出"更有指导性，优先留它。
      if (!fallback || verdict.status === 'not_logged_in') fallback = { ...verdict, origin, ...last };
    }

    if (!sawLoading) {
      if (fallback) return fallback;
      // 每个页面都求值失败。读不出来就是读不出来，不靠重试把它拖成"加载中"。
      const where = transportKind === 'ego'
        ? 'ego task space' : cdp ? '报销专用 Chromium 浏览器' : '系统默认浏览器';
      return { status: 'unknown', origin, observed: null, errors,
        hint: `${where}里的 ERP 页面全都读不出来；请人工看一眼这个窗口` };
    }
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);

  return { status: 'loading', origin, ...last, hint: `ERP 页面 ${waitMs}ms 内没有加载完成` };
}
