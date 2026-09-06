// 第四轮的结论：点完「发票导入单据」之后的事全在 piaozone 的 iframe 里，
// 之前只轮询 ERP 收票网格，等于在错的地方看。这一版每一步都把 iframe 自己
// 的可见文本和可点元素 dump 出来，**点完导入之后继续 dump 30 秒**。
import { evalIn, clickAt, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, showSection, readGrid } from './src/erpform.mjs';
import { resolve } from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = resolve(process.cwd(), 'resources/交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf');

// 可见叶子节点的文本，按出现顺序。
const TEXT = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  const l = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    const tx = (n.textContent||'').trim(); if (!tx || tx.length>60) continue;
    l.push(tx);
  }
  return l.join(' | ');
})()`;

// 可点的东西 + 它们在**这个 iframe 自己的视口**里的坐标。
// 之前导入那一下是硬编码 (721,499)，没有任何证据说明它落在按钮上。
const CLICKABLES = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  const out = [];
  for (const n of document.querySelectorAll('button,a,[role=button],.ant-btn,li,.ant-modal-footer *')) {
    if (!vis(n)) continue;
    const tx = (n.textContent||'').trim();
    if (!tx || tx.length > 24) continue;
    const b = n.getBoundingClientRect();
    out.push({ t: tx, tag: n.tagName.toLowerCase(), cls: String(n.className||'').slice(0,40),
      x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) });
  }
  // 同名同位的去重
  const seen = new Set();
  return out.filter(o => { const k = o.t+'@'+o.x+','+o.y; if (seen.has(k)) return false; seen.add(k); return true; });
})()`;

// iframe 里有没有弹出层。之前完全没看过这一层。
const MODALS = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  return [...document.querySelectorAll('.ant-modal,.ant-modal-confirm,[role=dialog],.ant-message,.ant-notification')]
    .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').slice(0,300));
})()`;

const BOXES = `[...document.querySelectorAll('input.ant-checkbox-input')].map(n => {
  const b = n.getBoundingClientRect();
  return { checked: n.checked, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2),
    row: (n.closest('tr') ? n.closest('tr').textContent.trim().slice(0,14) : '(表头)') };
})`;

const dump = async (sub, tag) => {
  const [t, c, m] = await Promise.all([evalIn(sub, TEXT), evalIn(sub, CLICKABLES), evalIn(sub, MODALS)]);
  console.log('--- iframe @' + tag + ' ---');
  console.log('  文本:', String(t).slice(0, 700));
  console.log('  可点:', JSON.stringify(c).slice(0, 900));
  if (m && m.length) console.log('  弹层:', JSON.stringify(m).slice(0, 900));
};

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const kids = await autoAttach(s);
  const isPZ = (u) => u.includes('piaozone');
  let sub = await kids.waitFor(isPZ, { timeout: 5000 });
  if (!sub) {
    await showSection(s, '收票信息');
    const pick = await evalIn(s, `(() => {
      const vis = (n) => { const b = n.getBoundingClientRect(); return b.width>0 && b.height>0; };
      for (const n of document.querySelectorAll('span,a,button')) {
        if (n.children.length !== 0 || !vis(n)) continue;
        if ((n.textContent||'').trim() !== '选择发票') continue;
        const b = n.getBoundingClientRect();
        return [Math.round(b.x+b.width/2), Math.round(b.y+b.height/2)];
      } return null; })()`);
    if (!pick) { console.log('找不到「选择发票」'); process.exit(1); }
    await clickAt(s, pick[0], pick[1]);
    sub = await kids.waitFor(isPZ, { timeout: 45000 });
  }
  if (!sub) { console.log('助手没起来'); process.exit(1); }
  await sleep(2500);
  await dump(sub, '刚打开');

  if (!/上传发票影像/.test(await evalIn(sub, TEXT))) { await clickAt(sub, 201, 133); await sleep(4000); }
  if (!/51\.63/.test(await evalIn(sub, TEXT))) {
    await sub.send('DOM.enable');
    const { root } = await sub.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await sub.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeId) { console.log('没找到 file input'); process.exit(1); }
    await sub.send('DOM.setFileInputFiles', { nodeId, files: [FILE] });
    for (let i = 0; i < 10; i++) {
      await sleep(5000);
      const t = await evalIn(sub, TEXT);
      if (/51\.63/.test(t) && !/上传处理中/.test(t)) break;
    }
  }
  if (!/51\.63/.test(await evalIn(sub, TEXT))) { console.log('没等到识别结果'); process.exit(1); }
  console.log('识别到票面 51.63');

  let boxes = await evalIn(sub, BOXES);
  let row = boxes.find((b) => /苏州市吉利优行/.test(b.row));
  if (!row) { console.log('找不到这张票的勾选框', JSON.stringify(boxes)); process.exit(1); }
  if (!row.checked) {
    await clickAt(sub, row.x, row.y);
    await sleep(2000);
    boxes = await evalIn(sub, BOXES);
    row = boxes.find((b) => /苏州市吉利优行/.test(b.row));
  }
  console.log('勾选后 checked =', row && row.checked);
  if (!row || !row.checked) { console.log('没勾上就不导入'); process.exit(2); }
  await dump(sub, '已勾选、导入之前');

  // 按名字找导入按钮，不再用硬编码坐标。
  const btns = await evalIn(sub, CLICKABLES);
  const imp = btns.find((b) => /发票导入单据/.test(b.t)) || btns.find((b) => /导入/.test(b.t));
  if (!imp) { console.log('iframe 里找不到导入按钮，只有：', JSON.stringify(btns.map(b=>b.t))); process.exit(1); }
  console.log('导入按钮:', JSON.stringify(imp));

  const before = (await readGrid(s, 1)).rows.filter((r) => r.kind !== 'footer').length;
  console.log('导入前 ERP 收票数据行', before);

  await clickAt(sub, imp.x, imp.y);
  // 关键改动：点完之后**先看 iframe**，别急着去问 ERP。
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const t = (i * 3 + 3) + 's';
    let alive = true;
    try { await dump(sub, t); } catch (e) { alive = false; console.log('--- iframe @' + t + ' 已断开:', String(e).slice(0,120)); }
    const g = await readGrid(s, 1).catch(() => null);
    const rows = g && g.rows ? g.rows.filter((r) => r.kind !== 'footer') : [];
    console.log('  ERP 收票行', rows.length, rows.length ? JSON.stringify(rows.map(r=>r.values)).slice(0, 300) : '');
    if (!alive && rows.length > before) break;
  }
} finally { s.close(); }
