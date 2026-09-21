// Point the dedicated Chromium's first page at an ERP URL, and nothing else.
//
// Harness only. A QA round whose session lapsed can land on 金蝶's "您无权查看此目录或页面" console page, where
// `probe-login.ts` finds no login form to fill; this walks the tab back to a page that has one. Presses no toolbar
// command and opens no bill.
//   pnpm --filter @baox/server exec tsx scripts/probe-nav.ts [url]
import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { sleep } from '../src/erp/executor/pace';

const target = process.argv[2] ?? 'http://erp.antute.com.cn/k3cloud/html5/index.aspx';
const WHERE = `JSON.stringify({ url: location.href.slice(0, 110), title: document.title,
  login: !!document.getElementById('password'),
  text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 100) })`;

const port = cdpPortOf(process.env);
const page = (await targets(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)[0];
if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 ERP 页面');
const session = await connect(page.webSocketDebuggerUrl);
try {
  console.log('before:', await evalIn<string>(session, WHERE));
  await evalIn(session, `location.href = ${JSON.stringify(target)}`);
  // The page reloads under us; give Kendo a few seconds to lay the form out before reading where we landed.
  for (let i = 0; i < 12; i += 1) {
    await sleep(1000);
    const now = await evalIn<string>(session, WHERE).catch(() => '');
    if (now && JSON.parse(now).login) { console.log('after:', now); process.exit(0); }
  }
  console.log('after:', await evalIn<string>(session, WHERE).catch(() => '(unreadable)'));
} finally {
  session.close();
}
