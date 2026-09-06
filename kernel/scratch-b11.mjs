import { evalIn } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, showSection } from './src/erpform.mjs';
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const gate = await authorizedPage({});
if (!gate.ok) process.exit(2);
const s = await openSession(gate.wsUrl);
try {
  await showSection(s, '基本信息');
  const out = await evalIn(s, `(() => { const vis = ${VIS};
    const ids = [...document.querySelectorAll('[id]')].map(n=>n.id).filter(id=>/事由|DESC|REASON|REMARK/i.test(id));
    let label = null;
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      if (!/^事由/.test((n.textContent||'').trim())) continue;
      const b = n.getBoundingClientRect();
      const near = [];
      for (const m of document.querySelectorAll('input,textarea')) {
        const mb = m.getBoundingClientRect();
        if (!vis(m)) continue;
        if (mb.bottom < b.top - 6 || mb.top > b.bottom + 6) continue;
        if (mb.x < b.right - 4 || mb.x > b.right + 400) continue;
        near.push({ id: m.id, cls: String(m.className||'').slice(0,40), vis: vis(m),
          x: Math.round(mb.x+mb.width/2), y: Math.round(mb.y+mb.height/2) });
      }
      label = { txt: (n.textContent||'').trim(), vis: vis(n),
        x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2), near };
      break;
    }
    const editors = [...document.querySelectorAll('[id$=-EDITOR]')].filter(vis).map(n=>n.id.replace(/^[0-9a-f-]{36}-/,''));
    return { ids: ids.slice(0,20), editors: editors.slice(0,40), label }; })()`);
  console.log(JSON.stringify(out, null, 1).slice(0, 1500));
} finally { s.close(); }
