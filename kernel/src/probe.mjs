import { targets, evaluate } from './chrome.mjs';

export const ERP_ORIGIN = process.env.BAOX_ERP_ORIGIN || 'http://erp.antute.com.cn';
export const ERP_ENTRY = `${ERP_ORIGIN}/k3cloud/html5/index.aspx`;

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
// 因此身份只认两个信号，缺一不可：
//   会话信号 —— 主控制台的用户名元素 span.kd-mainconsole-usernametext 有非空文本；
//   账号信号 —— localStorage 的 k3cloudloginInfo.user（登录账号，比显示名稳定）。
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

const norm = (s) => (s == null ? null : String(s).trim().toLowerCase());

/**
 * 从一次页面观测里判定身份。纯函数，把判断和取数分开：
 * 取数要浏览器，判断不要 —— 而需要被钉住的是判断。
 *
 * 返回 null 表示"这一页说明不了什么"，交给调用方看别的页面或继续等。
 */
export function identityFromObservation(info, expected = null) {
  if (!info || info.ready !== 'complete') return null;

  if (info.displayName) {
    const identity = { displayName: info.displayName, account: info.account, tenant: info.tenant };
    if (!expected) return { status: 'matched', identity };
    const want = norm(expected);
    const hit = want === norm(info.displayName) || want === norm(info.account);
    return hit
      ? { status: 'matched', expected, identity }
      : { status: 'mismatched', expected, identity,
          hint: `ERP 当前登录的是 ${info.displayName}（账号 ${info.account}），不是 ${expected}；请退出登录换成本人再探测` };
  }

  // 读不出用户名。分两档，因为处置完全不同：
  // 看得见登录表单 —— 会话没了或还没登录，用户去登录就行；
  // 两样都读不出 —— 页面变了或出了别的问题，那要人来看，不是重试能解决的。
  return info.loginFormVisible
    ? { status: 'not_logged_in',
        hint: `专用 Chrome 里的 ERP 停在登录页（${ERP_ENTRY}）。`
          + '请你本人在这个窗口里登录，回到主控制台之后再探测；baox 不代填账号密码。'
          + '注意登录页上也读得出上次登录的账号，那不算已登录。' }
    : { status: 'unknown',
        hint: `页面已加载完成，既读不出 ${USER_SELECTOR}，也看不见登录表单；`
          + '身份不能确定读出就不接管，请人工看一眼这个 Chrome 窗口' };
}

/**
 * 探测 ERP 登录身份。只有 matched 允许继续；其余一律硬阻塞。
 *   matched | mismatched | not_logged_in | loading | no_tab | unknown
 *
 * expected 可以给显示名（刘明建）或登录账号（luo.liu）中的任意一个，
 * 两者任一匹配即算一致；给了 expected 却两个都对不上就是 mismatched。
 */
export async function probeIdentity({ expected = null, origin = ERP_ORIGIN, waitMs = 30000 } = {}) {
  const deadline = Date.now() + waitMs;
  let last = null;

  do {
    const pages = (await targets()).filter((t) => (t.url || '').startsWith(origin));
    if (pages.length === 0) {
      return { status: 'no_tab', origin, hint: `请在 baox 专用 Chrome 中打开 ${ERP_ENTRY} 并登录` };
    }
    const errors = [];
    let sawLoading = false;
    let fallback = null;
    for (const page of pages) {
      let info;
      try {
        info = await evaluate(page.webSocketDebuggerUrl, READ_ONLY_SNIPPET, { timeout: 10000 });
      } catch (err) {
        errors.push(`${page.url}: ${err.message}`);
        continue;
      }
      last = { observed: info, errors };
      // ERP 首屏很慢，没加载完不算未登录，等就是了。
      if (info.ready !== 'complete') { sawLoading = true; continue; }

      const verdict = identityFromObservation(info, expected);
      // 认得出身份的页面说了算；只有所有页面都说不出身份时，才轮到登录页/异常这两档。
      if (verdict.status === 'matched' || verdict.status === 'mismatched') {
        return { ...verdict, ...last, targetId: page.id };
      }
      // 多个标签页时，"停在登录页"比"什么都读不出"更有指导性，优先留它。
      if (!fallback || verdict.status === 'not_logged_in') fallback = { ...verdict, origin, ...last };
    }

    if (!sawLoading) {
      if (fallback) return fallback;
      // 每个页面都求值失败。读不出来就是读不出来，不靠重试把它拖成"加载中"。
      return { status: 'unknown', origin, observed: null, errors,
        hint: '专用 Chrome 里的 ERP 页面全都读不出来（CDP 求值失败）；请人工看一眼这个窗口' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);

  return { status: 'loading', origin, ...last, hint: `ERP 页面 ${waitMs}ms 内没有加载完成` };
}
