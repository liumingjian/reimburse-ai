// issue #30 第三条：按一次「保存」，看 ERP 在这一步校不校验金额合计。
// 用户 2026-09-06 现场授权，只按一次，不重试、不点任何弹窗里的确认/继续。
import { evalIn, clickAt } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, readGrid, formTabs } from './src/erpform.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;

const OVERLAY = `(() => { const vis = ${VIS};
  return [...document.querySelectorAll('.k-window,.kd-message,.kdtoast,[role=dialog],[class*=notify],[class*=tips]')]
    .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,600)).filter(Boolean); })()`;

const grids = async (s, tag) => {
  console.log('== 网格 @' + tag);
  for (const [i, name] of [[0, '明细'], [1, '收票']]) {
    const g = await readGrid(s, i).catch((e) => ({ err: String(e) }));
    if (g.err) { console.log('  ', name, g.err); continue; }
    for (const r of g.rows || []) {
      const kept = Object.entries(r.values).filter(([, v]) => v && v !== '0.00' && v !== '0');
      console.log('  ', name, r.kind, JSON.stringify(Object.fromEntries(kept)));
    }
  }
};

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  console.log('页签(保存前)', JSON.stringify(await formTabs(s)));
  await grids(s, '保存前');
  console.log('保存前弹层', JSON.stringify(await evalIn(s, OVERLAY)));

  // 工具条上那个「保存」。必须挑视口内的（表单正文在内层容器滚，滚出去 rect.y 会变负）。
  const btn = await evalIn(s, `(() => { const vis = ${VIS};
    const out = [];
    for (const n of document.querySelectorAll('span,a,button,div')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      if ((n.textContent||'').trim() !== '保存') continue;
      const b = n.getBoundingClientRect();
      if (b.top < 0) continue;
      out.push({ x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2), top: Math.round(b.top) });
    }
    return out; })()`);
  console.log('「保存」候选', JSON.stringify(btn));
  if (!btn.length) { console.log('视口内找不到「保存」'); process.exit(1); }
  if (btn.length > 1) { console.log('不止一个，停下人工看'); process.exit(2); }

  await clickAt(s, btn[0].x, btn[0].y);
  for (let i = 1; i <= 8; i++) {
    await sleep(2000);
    const ov = await evalIn(s, OVERLAY).catch(() => []);
    if (ov && ov.length) console.log('弹层 @' + (i*2) + 's', JSON.stringify(ov).slice(0, 900));
  }
  console.log('页签(保存后)', JSON.stringify(await formTabs(s)));
  await grids(s, '保存后');
} finally { s.close(); }
