// 只读：「重复报销」到底被哪张单占着 —— 把行内预警图标 hover 出来读 tooltip。
import { evalIn, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const kids = await autoAttach(s);
  const sub = await kids.waitFor((u) => u.includes('piaozone'), { timeout: 8000 });
  if (!sub) { console.log('助手没开着'); process.exit(1); }

  // 行里所有可能是图标的小元素
  const icons = await evalIn(sub, `(() => { const vis = ${VIS}; const out = [];
    for (const n of document.querySelectorAll('i,svg,img,span')) {
      if (!vis(n)) continue;
      const b = n.getBoundingClientRect();
      if (b.width > 26 || b.height > 26 || b.width < 6) continue;
      if ((n.textContent||'').trim().length > 2) continue;
      out.push({ tag: n.tagName.toLowerCase(), cls: String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className||'').slice(0,50),
        x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) });
    } return out; })()`);
  console.log('候选图标', JSON.stringify(icons).slice(0, 900));

  const TIP = `(() => { const vis = ${VIS};
    return [...document.querySelectorAll('.ant-tooltip,.ant-popover,[role=tooltip],[class*=tooltip],[class*=popover]')]
      .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean); })()`;

  for (const ic of icons) {
    await sub.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ic.x, y: ic.y, buttons: 0 });
    await sleep(900);
    const tip = await evalIn(sub, TIP);
    if (tip && tip.length) console.log('hover', JSON.stringify(ic), '->', JSON.stringify(tip).slice(0, 400));
  }
  console.log('--- hover 结束 ---');
} finally { s.close(); }
