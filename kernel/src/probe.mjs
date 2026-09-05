import { targets, evaluate } from './chrome.mjs';

export const ERP_ORIGIN = process.env.BAOX_ERP_ORIGIN || 'http://erp.antute.com.cn';
export const ERP_ENTRY = `${ERP_ORIGIN}/k3cloud/html5/index.aspx`;

// 只读探测：只读取页面上已经存在的信息，不导航、不点击、不调用任何业务接口、不写入任何字段。
//
// 实测得到的三条事实（K3Cloud 8.2.0，见 ADR-0002 补记与台账 V-27）：
//   1. 登录页 URL 里没有 login，所以不能按 URL 判断；
//   2. 已登录的主控制台里有 4 个隐藏的 input[type=password]（改密弹窗），
//      所以密码框永远不能当作未登录信号；
//   3. Getk3cloudloginInfo() 在命名用户登录下返回 null，没有现成的身份全局变量。
//
// 因此身份只认两个信号，缺一不可：
//   会话信号 —— 主控制台的用户名元素 span.kd-mainconsole-usernametext 有非空文本；
//   账号信号 —— localStorage 的 k3cloudloginInfo.user（登录账号，比显示名稳定）。
// localStorage 单独不算数：它记的是"最近一次登录用的账号"，退出登录后依然留着。
const USER_SELECTOR = 'span.kd-mainconsole-usernametext';

const READ_ONLY_SNIPPET = `(() => {
  const el = document.querySelector(${JSON.stringify(USER_SELECTOR)});
  const displayName = el ? el.textContent.trim() : null;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('k3cloudloginInfo') || 'null'); } catch {}
  return {
    // 只回报去掉 query 的地址：K3Cloud 的 _cnneptstate_ 参数是会话态，
    // 属于短时效 URL，按契约不进日志、不进输出。
    url: location.origin + location.pathname,
    ready: document.readyState,
    title: document.title,
    displayName: displayName || null,
    account: stored && stored.user ? String(stored.user) : null,
    tenant: stored && stored.acc ? String(stored.acc) : null,
    isMainConsole: /BOS_HtmlConsole|index\\.aspx/i.test(location.href),
  };
})()`;

const norm = (s) => (s == null ? null : String(s).trim().toLowerCase());

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
      if (!info.displayName) continue;

      const identity = { displayName: info.displayName, account: info.account, tenant: info.tenant };
      if (!expected) return { status: 'matched', identity, ...last, targetId: page.id };

      const want = norm(expected);
      const hit = want === norm(info.displayName) || want === norm(info.account);
      return hit
        ? { status: 'matched', expected, identity, ...last, targetId: page.id }
        : { status: 'mismatched', expected, identity, ...last,
            hint: `ERP 当前登录的是 ${info.displayName}（账号 ${info.account}），不是 ${expected}；请退出登录换成本人再探测` };
    }

    if (!sawLoading) {
      const onConsole = last?.observed?.isMainConsole;
      return onConsole
        ? { status: 'unknown', origin, ...last,
            hint: `页面已加载完成但读不出 ${USER_SELECTOR}；身份不能确定读出就不接管` }
        : { status: 'not_logged_in', origin, ...last,
            hint: '专用 Chrome 里没有处于已登录的 ERP 主页，请由你本人完成登录后回到主页再探测' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);

  return { status: 'loading', origin, ...last, hint: `ERP 页面 ${waitMs}ms 内没有加载完成` };
}
