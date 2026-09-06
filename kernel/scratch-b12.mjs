// issue #30 第三条：把事由写成英文再保存，看金额校验到底存不存在。
// FCAUSA 的 -EDITOR 是个隐藏 TEXTAREA（rect 0,0），可见的是外层 Kendo 容器，
// 所以要从容器里挑真正可见的那块来点。
import { evalIn, clickAt, typeText, pressKey, selectAll } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, readGrid, formTabs, showSection } from './src/erpform.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;
const OVERLAY = `(() => { const vis = ${VIS};
  return [...document.querySelectorAll('.k-window,.kd-message,.kdtoast,[role=dialog],[class*=notify],[class*=tips]')]
    .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,600)).filter(Boolean); })()`;

const probe = `(() => { const vis = ${VIS};
  // 页面上同时挂着两套 form 实例，id 重名。必须挑**可见**的那一套，
  // 直接 querySelector 会拿到隐藏的旧表单。
  const all = [...document.querySelectorAll('[id$=-FCAUSA-EDITOR]')];
  for (const c of all) c.scrollIntoView({ block: 'center' });
  let ed = all.find(vis) || null;
  if (!ed) {
    // -EDITOR 本身可能是零尺寸容器，退一步找可见的 FCAUSA 容器里的输入控件。
    for (const c of document.querySelectorAll('[id$=-FCAUSA]')) {
      if (!vis(c)) continue;
      const inp = [...c.querySelectorAll('input,textarea')].find(vis) || [...c.querySelectorAll('input,textarea')][0];
      if (inp) { ed = inp; break; }
    }
  }
  if (!ed) return { ok: false, reason: 'no visible FCAUSA editor', total: all.length };
  const box = ed.getBoundingClientRect();
  // 往上找第一个真正可见、且不太大的祖先当点击目标。
  let target = vis(ed) ? ed : null;
  for (let p = ed.parentElement, i = 0; p && i < 5 && !target; p = p.parentElement, i++) {
    if (vis(p)) target = p;
  }
  const tb = target ? target.getBoundingClientRect() : null;
  const a = document.activeElement;
  return { ok: !!target, edVisible: vis(ed), edRect: [box.x, box.y, box.width, box.height],
    value: ed.value, targetTag: target && target.tagName, targetCls: target && String(target.className||'').slice(0,50),
    x: tb ? Math.round(tb.x + Math.min(tb.width/2, 80)) : null,
    y: tb ? Math.round(tb.y + tb.height/2) : null,
    focused: a === ed || (target && target.contains(a) && a !== target) }; })()`;

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const closed = await evalIn(s, `(() => { const vis = ${VIS};
    for (const w of document.querySelectorAll('.k-window')) {
      if (!vis(w)) continue;
      for (const a of w.querySelectorAll('.k-i-close,.k-window-action,[title=关闭]')) {
        if (vis(a)) { a.click(); return true; } } } return false; })()`);
  console.log('关弹窗:', closed);
  await sleep(1200);
  await showSection(s, '基本信息');
  await sleep(1200);

  let p = await evalIn(s, probe);
  console.log('事由控件', JSON.stringify(p));
  if (!p.ok || p.x === null) { console.log('定位不到可点的事由控件'); process.exit(1); }

  await clickAt(s, p.x, p.y);
  await sleep(600);
  p = await evalIn(s, probe);
  console.log('点击后', JSON.stringify({ focused: p.focused, value: p.value }));
  if (!p.focused) { console.log('焦点没进控件，不盲写'); process.exit(2); }

  await selectAll(s);
  await typeText(s, 'Customer Support');
  await pressKey(s, 'Tab');
  await sleep(1200);
  p = await evalIn(s, probe);
  console.log('写入后回读', JSON.stringify({ value: p.value }));

  const btn = await evalIn(s, `(() => { const vis = ${VIS}; const out = [];
    for (const n of document.querySelectorAll('span,a,button,div')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      if ((n.textContent||'').trim() !== '保存') continue;
      const b = n.getBoundingClientRect();
      if (b.top < 0) continue;
      out.push({ x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) });
    } return out; })()`);
  if (btn.length !== 1) { console.log('保存按钮不唯一', JSON.stringify(btn)); process.exit(2); }
  console.log('按保存', JSON.stringify(btn[0]));
  await clickAt(s, btn[0].x, btn[0].y);

  let last = '';
  for (let i = 1; i <= 12; i++) {
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
