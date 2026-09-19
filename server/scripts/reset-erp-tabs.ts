// Leave the dedicated Chromium the way a fresh 去报销 wants it: no 发票助手 window, no 费用报销单-新增 tab.
// Closes an unsaved blank form only; it clicks nothing on the never-click list and writes nothing.
import { autoAttach, connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { closeInvoiceAssistant, type WritePage } from '../src/erp/executor/steps';

const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('close assistant:', JSON.stringify(await closeInvoiceAssistant(page)));
  await sleep(1500);
  console.log('close tabs:', JSON.stringify(await evalIn(session, `(() => {
    const vis = ${VIS};
    // A tab that is still loading is captioned 「费用报销单 - 新增」 with spaces; an exact match left those open,
    // and a run that then reused one got a 发票助手 window whose iframe never loaded (V-45's spent page instance).
    const tabs = [...document.querySelectorAll('li.k-item')].filter(vis)
      .filter((n) => /^费用报销单\s*-\s*新增$/.test(String(n.textContent || '').trim()));
    let closed = 0;
    for (const tab of tabs) {
      const closer = [...tab.querySelectorAll('span.mainTabCloseButton')].filter(vis);
      if (closer.length === 1) { closer[0].click(); closed += 1; }
    }
    return { closed, found: tabs.length };
  })()`)));
  await sleep(3000);
  console.log('left open:', JSON.stringify(await evalIn(session, `(() => {
    const vis = ${VIS};
    return {
      tabs: [...document.querySelectorAll('li.k-item')].filter(vis).map((n) => String(n.textContent || '').trim().slice(0, 20)).slice(0, 8),
      dialogs: [...document.querySelectorAll('.k-window')].filter(vis).map((n) => String(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
    };
  })()`)));
} finally { session.close(); }
