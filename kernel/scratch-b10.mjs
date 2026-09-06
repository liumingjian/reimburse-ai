// issue #30 第三条（续）：必录校验挡在前面，填上「事由」再保存一次，
// 才能分清 ERP 到底有没有「明细合计 == 收票合计」这道校验。
import { evalIn, clickAt } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, readGrid, formTabs, writeHeader, headerField, showSection } from './src/erpform.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const OVERLAY = `(() => { const vis = ${VIS};
  return [...document.querySelectorAll('.k-window,.kd-message,.kdtoast,[role=dialog],[class*=notify],[class*=tips]')]
    .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,600)).filter(Boolean); })()`;

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  // 先关掉「字段必录提示」窗口，它是模态的，开着什么都点不动。
  const closed = await evalIn(s, `(() => { const vis = ${VIS};
    for (const w of document.querySelectorAll('.k-window')) {
      if (!vis(w)) continue;
      for (const a of w.querySelectorAll('.k-i-close,.k-window-action,[title=关闭]')) {
        if (vis(a)) { a.click(); return true; }
      }
    } return false; })()`);
  console.log('关必录提示窗:', closed);
  await sleep(1500);
  console.log('残留弹层', JSON.stringify(await evalIn(s, OVERLAY)).slice(0, 300));

  // 事由在「基本信息」里；表单正文在内层容器滚，停在收票段时它根本不在视口，找不到。
  await showSection(s, '基本信息');
  await sleep(1000);
  const r = await writeHeader(s, 'FCAUSA', 'baox 自动化验证 请勿提交');
  console.log('写事由:', JSON.stringify(r).slice(0, 300));
  console.log('回读事由:', JSON.stringify(await headerField(s, 'FCAUSA')).slice(0, 200));

  const btn = await evalIn(s, `(() => { const vis = ${VIS}; const out = [];
    for (const n of document.querySelectorAll('span,a,button,div')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      if ((n.textContent||'').trim() !== '保存') continue;
      const b = n.getBoundingClientRect();
      if (b.top < 0) continue;
      out.push({ x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) });
    } return out; })()`);
  console.log('「保存」候选', JSON.stringify(btn));
  if (btn.length !== 1) { console.log('保存按钮不唯一或找不到，停'); process.exit(2); }
  await clickAt(s, btn[0].x, btn[0].y);

  let last = '';
  for (let i = 1; i <= 10; i++) {
    await sleep(2000);
    const ov = await evalIn(s, OVERLAY).catch(() => []);
    const j = JSON.stringify(ov);
    if (j !== last) { console.log('弹层 @' + (i*2) + 's', j.slice(0, 800)); last = j; }
  }
  console.log('页签', JSON.stringify(await formTabs(s)));
  for (const [i, name] of [[0, '明细'], [1, '收票']]) {
    const g = await readGrid(s, i).catch((e) => ({ err: String(e) }));
    if (g.err) { console.log(name, g.err); continue; }
    for (const row of g.rows || []) {
      const kept = Object.entries(row.values).filter(([, v]) => v && v !== '0.00' && v !== '0');
      console.log('  ', name, row.kind, JSON.stringify(Object.fromEntries(kept)));
    }
  }
} finally { s.close(); }
