// Read-only probe: what covers ERP's main-menu landing point, and why the hit test refuses to click it.
// The live stop it exists for: two runs (2026-09-19, 2026-09-20) both aborted at 'navigate' with
// «ERP 主菜单的落点（x=96 y=61）上盖着DIV，点下去会点到它，所以没有点». The guard is right to refuse; this
// names the cover so the refusal can be turned into something a headless run can clear.
//   pnpm --filter @baox/server exec tsx scripts/probe-cover.ts
// Read-only: what sits on ERP's main-menu landing point. Clicks nothing, writes nothing.
import { connect, enableFocusEmulation, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  console.log('focus:', JSON.stringify(await enableFocusEmulation(session)));
  const out = await evalIn(session, `(() => {
    const at = (x, y) => {
      const chain = [];
      let el = document.elementFromPoint(x, y);
      for (let i = 0; el && i < 6; i++, el = el.parentElement) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        chain.push({ tag: el.tagName, id: el.id || null, cls: (el.className && String(el.className).slice(0, 80)) || null,
          z: cs.zIndex, pos: cs.position, vis: cs.visibility, disp: cs.display, op: cs.opacity,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          text: (el.textContent || '').trim().slice(0, 40) });
      }
      return chain;
    };
    const tops = [...document.querySelectorAll('body > div')].map((d) => {
      const cs = getComputedStyle(d); const r = d.getBoundingClientRect();
      return { id: d.id || null, cls: String(d.className || '').slice(0, 60), z: cs.zIndex, pos: cs.position,
        disp: cs.display, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        text: (d.textContent || '').trim().slice(0, 50) };
    }).filter((d) => d.disp !== 'none' && d.rect[2] > 0);
    const dialogs = [...document.querySelectorAll('div.k-widget.k-window')].map((w) => {
      const r = w.getBoundingClientRect();
      const title = (w.querySelector('.k-window-title')?.textContent || '').trim();
      const body = (w.querySelector('.k-window-content')?.textContent || w.textContent || '').trim().slice(0, 120);
      const buttons = [...w.querySelectorAll('button, a, span, div')]
        .filter((b) => { const t = (b.textContent || '').trim(); const br = b.getBoundingClientRect();
          return t.length > 0 && t.length <= 6 && br.width > 20 && br.height > 12 && br.width < 200
            && !b.querySelector('button, a'); })
        .map((b) => { const br = b.getBoundingClientRect();
          return { tag: b.tagName, cls: String(b.className || '').slice(0, 50), text: (b.textContent || '').trim(),
            rect: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)] }; });
      return { title, body, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], buttons };
    });
    return { url: location.href, size: [innerWidth, innerHeight], visibility: document.visibilityState,
      at96_61: at(96, 61).slice(0, 2), bodyDivs: tops.map((d) => ({ cls: d.cls, z: d.z, rect: d.rect })), dialogs };
  })()`);
  console.log(JSON.stringify(out, null, 1));
} finally { session.close(); }
