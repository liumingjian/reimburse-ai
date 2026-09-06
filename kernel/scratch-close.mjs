import { evalIn } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const gate = await authorizedPage({});
if (!gate.ok) process.exit(2);
const s = await openSession(gate.wsUrl);
try {
  const r = await evalIn(s, `(() => { const vis = ${VIS}; let n = 0;
    for (const w of document.querySelectorAll('.k-window')) {
      if (!vis(w)) continue;
      for (const a of w.querySelectorAll('.k-i-close,.k-window-action,[title=关闭]')) {
        if (vis(a)) { a.click(); n++; break; } } }
    return n; })()`);
  console.log('关掉的模态窗数量:', r);
  await new Promise((x) => setTimeout(x, 1500));
  console.log('残留:', JSON.stringify(await evalIn(s, `(() => { const vis = ${VIS};
    return [...document.querySelectorAll('.k-window')].filter(vis).map(n=>(n.innerText||'').slice(0,60)); })()`)));
} finally { s.close(); }
