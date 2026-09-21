// Follow a dropdown's own `aria-owns` to the list it actually rendered.
//
// Measured live 2026-09-20: the 发票类型 editor is a `span.k-dropdown[role=listbox]` that reports
// aria-expanded="true" while `selectOption`'s `ul[class*=k-list] li` selector found nothing visible — so the
// list it owns is not the one that selector reaches.
//   pnpm --filter @baox/server exec tsx scripts/probe-owns.ts
import { clickAt, connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { cellTarget } from '@baox/erp-executor/erpform';
import { sleep } from '@baox/erp-executor/pace';

const COLUMN = '发票类型';
const ROW = 0;

const OWNED = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const box = [...document.querySelectorAll('[role=listbox][aria-owns]')].filter(vis)
    .find((n) => n.getAttribute('aria-expanded') === 'true') ?? document.querySelector('[role=listbox][aria-owns]');
  if (!box) return JSON.stringify({ box: null });
  const owns = box.getAttribute('aria-owns');
  const owned = owns ? document.getElementById(owns) : null;
  const items = owned ? [...owned.querySelectorAll('li')].map((li) => ({
    text: String(li.textContent).trim(), vis: vis(li),
    rect: (() => { const b = li.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })(),
  })) : null;
  return JSON.stringify({ expanded: box.getAttribute('aria-expanded'), owns, ownedFound: !!owned,
    ownedTag: owned ? owned.tagName : null,
    // What the product's own selector would find right now, so a miss can be placed on the selector rather than
    // on the list not being there.
    productSelector: [...document.querySelectorAll('ul[class*=k-list] li, li[role=option]')]
      .filter(vis).map((n) => String(n.textContent).trim().slice(0, 10)),
    ownedCls: owned ? String(owned.className).slice(0, 60) : null,
    ownedVis: owned ? vis(owned) : null,
    parentCls: owned && owned.parentElement ? String(owned.parentElement.className).slice(0, 60) : null,
    parentVis: owned && owned.parentElement ? vis(owned.parentElement) : null,
    items });
})()`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp?.webSocketDebuggerUrl) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl);
try {
  for (const attempt of [1, 2, 3, 4]) {
    const spot = await cellTarget(session, { which: 0, row: ROW, column: COLUMN });
    if (!spot.ok) break;
    await clickAt(session, spot.x, spot.y);
    await sleep(1500);
    const cell = await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false });
    console.log(`click ${attempt}: editing=${cell.ok ? cell.editing : '?'} focus=${cell.ok ? cell.focusTag : '?'}`);
    console.log('  owned:', await evalIn<string>(session, OWNED));
  }
} finally {
  session.close();
}
