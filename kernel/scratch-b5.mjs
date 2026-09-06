// 只读：助手还开着的话，把「已选发票列表」整行读出来，看那 1 张错在哪。
import { evalIn, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const kids = await autoAttach(s);
  const sub = await kids.waitFor((u) => u.includes('piaozone'), { timeout: 8000 });
  if (!sub) { console.log('助手没开着'); process.exit(1); }
  const rows = await evalIn(sub, `(() => { const vis = ${VIS};
    return [...document.querySelectorAll('tr')].filter(vis)
      .map(tr => [...tr.children].map(td => (td.innerText||'').replace(/\\s+/g,' ').trim()))
      .filter(r => r.join('').length); })()`);
  console.log('表格行:');
  rows.forEach((r) => console.log('  ', JSON.stringify(r)));
  const txt = await evalIn(sub, `(() => { const vis = ${VIS}; const l = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const t = (n.textContent||'').trim(); if (!t || t.length > 80) continue; l.push(t);
    } return l.join(' | '); })()`);
  console.log('全文:', String(txt).slice(0, 1500));
} finally { s.close(); }
