// Read-only: the ERP main tab strip — the tabs that carry a close button, with their captions, their close
// button's rect and their markup. It reads; it clicks nothing.
//
// It exists because `reset-erp-tabs.ts` once reported a tab closed that was still there, and the first thing that
// question needs is the strip as the page has it, not as a text filter summarised it.
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  console.log(JSON.stringify(await evalIn(session, `(() => {
    const vis = ${VIS};
    const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
    const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
    const tabs = [...document.querySelectorAll('li.k-item')].filter(vis).filter((n) => n.querySelector('span.mainTabCloseButton'));
    return {
      tabs: tabs.map((n) => ({
        id: n.id || null, cls: n.className, text: txt(n).slice(0, 40), own: own(n),
        title: n.getAttribute('title'),
        closerVis: [...n.querySelectorAll('span.mainTabCloseButton')].filter(vis).length,
        rect: (() => { const b = n.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })(),
        inner: n.innerHTML.replace(/\\s+/g, ' ').slice(0, 300),
      })),
      strip: (() => { const s = document.querySelector('li.k-item span.mainTabCloseButton')?.closest('ul'); return s ? { cls: s.className, id: s.id } : null; })(),
    };
  })()`), null, 1));
} finally { session.close(); }
