// What does ERP offer for putting a 税额 (tax amount) on a 费用明细 row, given that typing one does not survive?
//
// Measured live 2026-09-20 (V-67), with no counterexample: ERP CLEARS 税额 the moment 费用金额 commits, and a
// 税额 typed while 费用金额 is non-empty is accepted by the editor and discarded at the commit. Two hypotheses
// died on the way here — it is not Kendo's two-node numeric textbox (the money cells hold no input at all when
// the row is in edit), and it is not a 税率 column (the grid HAS no 税率(%) column; the probe that assumed one
// got «这个网格里没有「税率(%)」列» four times out of four, so every earlier reading of an empty 税率 was a
// reading of nothing).
//
// What is left is what the grid itself offers. V-65 recorded, as an aside from a misread, that the detail grid's
// HEADER table carries the words 「设置税额」 — a toolbar command, not a column. And the row has a 收票单号
// column that is empty on every row this probe has ever written, while the fake ERP has modelled
// `if (column === '税额') linkReceipt(tr)` all along. So the tax may belong to the 收票 linkage, to that command,
// or to both.
//
// This script only LOOKS. It clicks nothing, types nothing, saves nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-taxcmd.ts
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const DUMP = `(() => {
  const vis = (n) => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const txt = (n) => String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
  const rect = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };

  // Anything on screen whose own caption mentions 税 or 收票, taken OUTERMOST-first so a button is reported
  // once rather than once per span inside it. Captions are capped: a panel that happens to contain the word
  // should not paste the whole panel into the log.
  const hits = [...document.querySelectorAll('body *')].filter(vis).filter((n) => {
    const t = txt(n);
    return t.length > 0 && t.length < 24 && /税|收票/.test(t);
  });
  const outer = hits.filter((n) => !hits.some((m) => m !== n && m.contains(n)));

  return {
    captions: outer.map((n) => ({
      text: txt(n), tag: n.tagName, id: n.id || null,
      cls: String(n.className || '').slice(0, 70),
      role: n.getAttribute('role'), disabled: n.getAttribute('disabled') ?? n.classList.contains('k-state-disabled'),
      rect: rect(n),
    })),
    // Every visible toolbar in the form, with its commands, so 「设置税额」 can be placed in the thing it belongs
    // to instead of floating free.
    toolbars: [...document.querySelectorAll('[class*=toolbar],[class*=Toolbar],.k-header')].filter(vis).map((bar) => ({
      cls: String(bar.className || '').slice(0, 70), rect: rect(bar),
      commands: [...bar.querySelectorAll('a,button,span[id],div[id]')].filter(vis)
        .map((n) => ({ text: txt(n).slice(0, 20), id: n.id || null, tag: n.tagName }))
        .filter((c) => c.text.length > 0 && c.text.length < 20),
    })).filter((bar) => bar.commands.length > 0),
  };
})()`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const seen = await evalIn<any>(session, DUMP);
  console.log('captions:');
  for (const c of seen.captions) console.log(' ', JSON.stringify(c));
  console.log('toolbars:');
  for (const b of seen.toolbars) console.log(' ', JSON.stringify(b));
} finally { session.close(); }
