import { evalIn } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, sectionAnchors } from './src/erpform.mjs';
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const gate = await authorizedPage({});
if (!gate.ok) process.exit(2);
const s = await openSession(gate.wsUrl);
try {
  console.log('区域锚点', JSON.stringify(await sectionAnchors(s)).slice(0,500));
  const out = await evalIn(s, `(() => { const vis = ${VIS};
    const nodes = [...document.querySelectorAll('[id*=FCAUSA]')].map(n => {
      const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
      return { id: n.id.replace(/^[0-9a-f-]{36}-/,''), tag: n.tagName,
        r: [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)],
        disp: st.display, visb: st.visibility, vis: vis(n) };
    });
    const ed = document.querySelector('[id$=-FCAUSA-EDITOR]');
    const chain = [];
    if (ed) for (let p = ed.parentElement, i=0; p && i<10; p=p.parentElement, i++) {
      const b = p.getBoundingClientRect(); const st = getComputedStyle(p);
      chain.push({ tag: p.tagName, cls: String(p.className||'').slice(0,40),
        r: [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)], disp: st.display, vis: vis(p) });
    }
    return { nodes, chain }; })()`);
  console.log(JSON.stringify(out, null, 1).slice(0, 2000));
} finally { s.close(); }
