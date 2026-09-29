// Leave the unsaved 费用报销单 behind, so 对账 (reconcile) sees no form and can offer 重新去报销.
//
// An unsaved 费用报销单 does not outlive its tab (see `task-snapshot/erp.ts`): navigating away discards a draft that was
// never saved, which is the same normal act as closing the browser. Saves nothing, imports nothing, deletes
// nothing, and presses no toolbar command — the only interaction is a navigation and, if the ERP asks whether to
// leave, accepting that prompt.
//   pnpm --filter @baox/server exec tsx scripts/probe-clear-form.ts
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { sleep } from '@baox/erp-executor/pace';

// What the page is showing: the ERP's own header caption, and whether a 费用明细 grid is present at all.
const STATE = `(() => {
  const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160);
  const headers = [...document.querySelectorAll('th')].map((n) => n.innerText.trim()).filter(Boolean);
  return JSON.stringify({ url: location.href.slice(0, 110), title: document.title,
    hasDetailGrid: headers.some((h) => h.includes('费用金额')), text });
})()`;

const port = cdpPortOf(process.env);
const pages = (await targets(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const page = pages[0];
if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 ERP 页面');

const session = await connect(page.webSocketDebuggerUrl);
try {
  await session.send('Page.enable');
  // The ERP may ask whether to leave an unsaved form. Accepting is the intent; a dialog left unanswered blocks
  // the navigation forever.
  session.on?.('Page.javascriptDialogOpening', (params) => {
    console.log('dialog:', JSON.stringify(params).slice(0, 200));
    void session.send('Page.handleJavaScriptDialog', { accept: true });
  });

  console.log('before:', await evalIn<string>(session, STATE));
  // The ERP's own console, not `/main.aspx` — that path 404s on this build, and a 404 page is not a state the
  // login probe can read.
  const home = new URL(page.url ?? '').origin + '/k3cloud/html5/dform.aspx?formId=BOS_HtmlConsole&formType=mobileform&pageId=MainPageId';
  await session.send('Page.navigate', { url: home });
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const now = await evalIn<string>(session, STATE).catch(() => '');
    if (now && !JSON.parse(now).hasDetailGrid) { console.log('after:', now); break; }
    if (i === 19) console.log('after (still showing a detail grid):', now);
  }
} finally {
  session.close();
}
