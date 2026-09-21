// Leave the dedicated Chromium the way a fresh 去报销 wants it: no 发票助手 window, and no 费用报销单 form tab
// of any flavour — 新增, 修改 or 查看.
// It clicks nothing on the never-click list and writes nothing: closing a tab is not saving it. 否 declines to
// save; 是 is never clicked, and no 单据 is deleted.
//
// The how — the measured shape of the strip, the 是否保存 bar, and the order the two have to be answered in —
// lives in `src/erp/executor/tabs.ts`, where `tabs.test.ts` drives it. This file is the CLI: connect, clear the
// dialogs, close each form tab, report what was VERIFIED and set an exit code.
//
// 修改 and 查看 tabs are closed under the same discipline. They matter more, not less: a 修改 tab sits on a REAL
// saved 费用报销单, one stray click away from a 保存 this program is never allowed to make. Closing it writes
// nothing, and the bill is left exactly as the employee saved it.
import { clickAt, connect, enableFocusEmulation, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { closeInvoiceAssistant, type WritePage } from '../src/erp/executor/steps';
import { sleep } from '../src/erp/executor/pace';
import { closeFormTab, dialogsSnippet, dismissPoint, tabActions, tabsSnippet, type Point, type Tab } from '../src/erp/executor/tabs';

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
// V-53: an occluded ERP window is `hidden`, and a hidden page receives no `Input.dispatchMouseEvent` at all —
// CDP accepts every click here and delivers none. The executor claims focus when it attaches; this script
// connects on its own, so it has to claim it too, or it reports clicks it made and outcomes it never got.
console.log('focus emulation:', JSON.stringify(await enableFocusEmulation(session)));
try {
  const page: WritePage = { session };
  const actions = tabActions(session);
  const allTabs = () => evalIn<Tab[]>(session, tabsSnippet);
  console.log('close assistant:', JSON.stringify(await closeInvoiceAssistant(page)));
  await sleep(1500);
  // Dialogs first: an open one covers the confirm the tab close is about to raise.
  for (let i = 0; i < 5 && (await evalIn<string[]>(session, dialogsSnippet)).length; i += 1) {
    const dismiss = await evalIn<Point>(session, dismissPoint);
    if (!dismiss) break;
    await clickAt(session, dismiss.x, dismiss.y);
    await sleep(1000);
  }
  console.log('dialogs left:', JSON.stringify(await evalIn<string[]>(session, dialogsSnippet)));
  console.log('tabs before:', JSON.stringify((await allTabs()).map((t) => t.text)));
  const before = (await allTabs()).filter((t) => t.isForm);
  let closed = 0;
  let declined = 0;
  const stuck: string[] = [];
  for (const tab of before) {
    const result = await closeFormTab(actions, tab.id);
    // Per tab, because «one of them asked to save» is not an answer to «which one did».
    console.log('tab:', JSON.stringify({ text: tab.text, ...result }));
    if (result.declinedSave) declined += 1;
    if (result.closed) closed += 1;
    else stuck.push(`${tab.text}（${result.note}）`);
  }
  const after = await allTabs();
  const remaining = after.filter((t) => t.isForm);
  // Report what was verified, never what was clicked.
  console.log('close tabs:', JSON.stringify({ found: before.length, closed, declinedSave: declined, remaining: remaining.map((t) => t.text) }));
  console.log('tabs after:', JSON.stringify(after.map((t) => t.text)));
  // A leftover 新增 keeps its own exit 1: it is the one that breaks the next 去报销.
  const remainingNew = remaining.filter((t) => t.isNew);
  if (remainingNew.length) {
    console.error(`费用报销单-新增 没有关掉：还剩 ${remainingNew.length} 个。${stuck.join('；')}`);
    process.exit(1);
  }
  // A 修改 / 查看 that refuses to close is reported and left alone — never forced, never answered 是.
  if (remaining.length) {
    console.error(`这些单据页签没有关掉，请人工处理：${stuck.join('；') || remaining.map((t) => t.text).join('、')}`);
    process.exit(2);
  }
} finally { session.close(); }
