// Throwaway live measurement for D2: WHICH item of the 选择发票 split menu does a click actually reach?
//
// The menu holds three adjacent items — tbMergeFillEntry 合并生成费用明细, tbMappingFillEntry 不合并生成费用明细,
// tbNotFillEntry 不生成费用明细 — and only the last leaves the 费用明细 grid alone. This probe opens the menu,
// hit-tests every item's own centre with `document.elementFromPoint`, prints the element id found there, then
// clicks 不生成费用明细 through the product step and prints what the same point answers afterwards.
//
// It opens one 费用报销单-新增 and the 发票助手, uploads nothing and imports nothing: no invoice is consumed
// (ADR-0025 puts that boundary at 发票导入单据). `--tabs-only` prints the tab strip and exits, touching nothing.
import { clickAt, connect, enableFocusEmulation, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { sleep } from '../src/erp/executor/pace';
import { closeInvoiceAssistant, openInvoiceAssistant, openNewReimbursement, type WritePage } from '../src/erp/executor/steps';
import { tabsSnippet, type Tab } from '../src/erp/executor/tabs';

const MENU = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const ids = ['tbMergeFillEntry', 'tbMappingFillEntry', 'tbNotFillEntry'];
  return ids.flatMap((id) => [...document.querySelectorAll('a[id$="' + id + '"]')].map((n) => {
    const b = n.getBoundingClientRect();
    const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    const hit = document.elementFromPoint(x, y);
    const anchor = hit && hit.closest ? hit.closest('a[id]') : null;
    return {
      wanted: id, id: n.id, visible: vis(n), text: String(n.textContent || '').trim(),
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      point: { x, y }, hitTag: hit ? hit.tagName : null, hitId: anchor ? anchor.id : null,
      hitText: hit ? String(hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : null,
    };
  }));
})()`;

const VIEW = `({ visibility: document.visibilityState, focus: document.hasFocus(), w: innerWidth, h: innerHeight })`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  console.log('before focus emulation:', JSON.stringify(await evalIn(session, VIEW)));
  console.log('enableFocusEmulation:', JSON.stringify(await enableFocusEmulation(session)));
  console.log('after focus emulation:', JSON.stringify(await evalIn(session, VIEW)));
  console.log('tabs:', JSON.stringify((await evalIn<Tab[]>(session, tabsSnippet)).map((t) => t.text)));
  if (process.argv.includes('--tabs-only')) process.exit(0);

  const page: WritePage = { session };
  console.log('openNewReimbursement:', JSON.stringify(await openNewReimbursement(page, { timeoutMs: 45_000 })));
  // The menu, as the executor sees it, before any click goes anywhere near it.
  await evalIn(session, `(() => { const a = [...document.querySelectorAll('div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow')][0]; if (a) a.scrollIntoView({ block: 'center' }); return true; })()`);
  const arrow = await evalIn<{ x: number; y: number } | null>(session, `(() => {
    const a = [...document.querySelectorAll('div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow')][0];
    if (!a) return null; const b = a.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  console.log('split arrow point:', JSON.stringify(arrow));
  if (arrow) await clickAt(session, arrow.x, arrow.y);
  await sleep(1500);
  console.log('menu items (closed -> open):', JSON.stringify(await evalIn(session, MENU), null, 1));

  const opened = await openInvoiceAssistant(page, { timeoutMs: 90_000 });
  console.log('openInvoiceAssistant:', JSON.stringify(opened));
  console.log('menu after the click:', JSON.stringify(await evalIn(session, MENU), null, 1));
  console.log('closeInvoiceAssistant:', JSON.stringify(await closeInvoiceAssistant(page)));
} finally {
  session.close();
}
