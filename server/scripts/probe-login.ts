// Sign the dedicated Chromium back into the ERP, and nothing else.
//
// Harness only. In the product the employee logs in themselves and that login IS the ERP authorisation (ADR-0016);
// this exists so an unattended QA round can recover a session that lapsed mid-round. Credentials come from
// ~/.baox-erp-live.env; the password never reaches stdout. Presses no toolbar command and opens no bill.
//   set -a; . ~/.baox-erp-live.env; set +a; pnpm --filter @baox/server exec tsx scripts/probe-login.ts
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { sleep } from '@baox/erp-executor/pace';
import { signInSnippet } from '@baox/erp-executor/recording/sign-in';

const account = process.env['BAOX_ERP_TEST_ACCOUNT']?.trim() ?? '';
const password = process.env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
if (!account || !password) throw new Error('需要 BAOX_ERP_TEST_ACCOUNT 与 BAOX_ERP_TEST_PASSWORD');

const WHERE = `JSON.stringify({ url: location.href.slice(0, 110), title: document.title,
  text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120) })`;

const port = cdpPortOf(process.env);
const page = (await targets(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)[0];
if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 ERP 页面');
const session = await connect(page.webSocketDebuggerUrl);
try {
  console.log('before:', await evalIn<string>(session, WHERE));
  // readyState reaches 'complete' well before Kendo has laid the login form out, so keep trying until it is there.
  let submitted = false;
  for (let i = 0; i < 30 && !submitted; i += 1) {
    const outcome = await evalIn<{ ok: boolean; why?: string }>(session, signInSnippet(account, password)).catch(() => ({ ok: false, why: 'no answer' }));
    if (outcome.ok) submitted = true;
    else { if (i % 10 === 0) console.log('waiting for the login form:', outcome.why); await sleep(1000); }
  }
  console.log(submitted ? `submitted the login form as ${account}.` : 'could not fill the login form.');
  for (let i = 0; i < 40; i += 1) {
    await sleep(1500);
    const now = await evalIn<string>(session, WHERE).catch(() => '');
    if (now && !/index\.aspx/.test(JSON.parse(now).url)) { console.log('after:', now); break; }
    if (i === 39) console.log('after (still on the login page):', now);
  }
} finally {
  session.close();
}
