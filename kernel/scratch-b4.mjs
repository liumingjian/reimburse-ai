// V-45 / issue #30：「选择发票」是个带下拉的按钮，下拉里第三项才是「不生成费用明细」。
// 之前一直直接点按钮本身，落到默认模式，实测会改写已有的费用明细行。
// STAGE=probe（默认）只读到菜单为止，不点任何一项，不消耗发票。
// STAGE=full 才继续：选「不生成费用明细」→ 上传 → 导入 → 回读两个网格。
import { evalIn, clickAt, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, showSection, readGrid, formTabs } from './src/erpform.mjs';
import { resolve } from 'node:path';

const STAGE = process.env.STAGE || 'probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 3 段行程的合并发票，正是一票多段的样本。
const FILE = resolve(process.cwd(), process.env.INVOICE
  || 'resources/长途/26349119423005877606.pdf');

const VIS = `(n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
  return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; }`;

// 「选择发票」那个文字节点的右边一小条里都有什么 —— 下拉箭头就在那儿。
const NEIGHBOURS = `(() => {
  const vis = ${VIS};
  let anchor = null;
  for (const n of document.querySelectorAll('span,a,button,div')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    if ((n.textContent||'').trim() === '选择发票') { anchor = n; break; }
  }
  if (!anchor) return { anchor: null };
  const ab = anchor.getBoundingClientRect();
  const out = [];
  for (const n of document.querySelectorAll('*')) {
    if (!vis(n)) continue;
    const b = n.getBoundingClientRect();
    if (b.x < ab.right - 2 || b.x > ab.right + 60) continue;
    if (b.bottom < ab.top || b.top > ab.bottom) continue;
    if (b.width > 60 || b.height > 40) continue;
    out.push({ tag: n.tagName.toLowerCase(), cls: String(n.className||'').slice(0,60),
      txt: (n.textContent||'').trim().slice(0,10), kids: n.children.length,
      x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2),
      w: Math.round(b.width), h: Math.round(b.height) });
  }
  return { anchor: { x: Math.round(ab.x+ab.width/2), y: Math.round(ab.y+ab.height/2),
    right: Math.round(ab.right), top: Math.round(ab.top), bottom: Math.round(ab.bottom) }, near: out };
})()`;

// 菜单项：全文档扫「…生成费用明细」，连祖先 class 一起报，好知道菜单挂在哪。
const MENU = `(() => {
  const vis = ${VIS};
  const out = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    const tx = (n.textContent||'').trim();
    if (!/生成费用明细$/.test(tx) || tx.length > 12) continue;
    const b = n.getBoundingClientRect();
    const anc = [];
    for (let p = n.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
      anc.push(p.tagName.toLowerCase() + '.' + String(p.className||'').split(/\\s+/).slice(0,2).join('.'));
    }
    out.push({ t: tx, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2), anc });
  }
  return out;
})()`;

const grids = async (s, tag) => {
  const d = await readGrid(s, 0).catch(() => null);   // 明细
  const r = await readGrid(s, 1).catch(() => null);   // 收票
  const fmt = (g) => g && g.rows
    ? g.rows.map((x) => (x.kind === 'total' ? '总计' : '') + JSON.stringify(x.values)).join(' ; ').slice(0, 500)
    : '(读不到)';
  console.log('== 网格 @' + tag);
  console.log('  明细:', fmt(d));
  console.log('  收票:', fmt(r));
  return { d, r };
};

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过：', gate.reason || ''); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const tabs = await formTabs(s);
  console.log('页签', JSON.stringify(tabs));
  if (!tabs.some((t) => /费用报销单/.test(t && t.label ? t.label : String(t)))) { console.log('没有打开费用报销单，停'); process.exit(2); }

  // 模态 .k-window 会吞掉 ERP 工具栏的点击，助手开着就先关掉。
  {
    const kids0 = await autoAttach(s);
    const open = await kids0.waitFor((u) => u.includes('piaozone'), { timeout: 3000 });
    if (open) {
      const closed = await evalIn(s, `(() => { const vis = ${VIS};
        for (const n of document.querySelectorAll('.k-window .k-i-close,.k-window .k-window-action')) {
          if (!vis(n)) continue; n.click(); return true; } return false; })()`);
      console.log('助手原本开着，已尝试关闭:', closed);
      await sleep(2000);
    }
  }

  await showSection(s, '收票信息');
  await sleep(800);
  await grids(s, '开工前');

  // probe 已确认：「选择发票」是 Kendo split button，箭头是 a.k-split-button-arrow，
  // 菜单挂在 div.k-animation-container.k-split-wrapper 下的 ul.k-split-container。
  // 页面上不止一个 split button，必须从「选择发票」这个文字节点出发就近认，
  // 否则会取到滚出视口的那一个（y 为负，点了等于没点）。
  const caret = await evalIn(s, `(() => {
    const vis = ${VIS};
    let anchor = null;
    for (const n of document.querySelectorAll('span,a,button,div')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      if ((n.textContent||'').trim() === '选择发票') { anchor = n; break; }
    }
    if (!anchor) return { err: 'no-anchor' };
    const ab = anchor.getBoundingClientRect();
    let best = null;
    for (const n of document.querySelectorAll('a.k-split-button-arrow')) {
      if (!vis(n)) continue;
      const b = n.getBoundingClientRect();
      if (b.top < 0 || b.bottom < ab.top || b.top > ab.bottom) continue;
      if (b.x < ab.right - 4) continue;
      if (!best || b.x < best.b.x) best = { n, b };
    }
    if (!best) return { err: 'no-arrow', anchor: { x: ab.x, y: ab.y, right: ab.right } };
    return { x: Math.round(best.b.x + best.b.width/2), y: Math.round(best.b.y + best.b.height/2) };
  })()`);
  if (!caret || caret.err) { console.log('找不到下拉箭头', JSON.stringify(caret)); process.exit(1); }
  console.log('下拉箭头', JSON.stringify(caret));
  await clickAt(s, caret.x, caret.y);
  await sleep(1500);

  const menu = await evalIn(s, MENU);
  console.log('菜单项', JSON.stringify(menu.map((m) => m.t)));
  if (!menu.length) { console.log('没读到菜单，停'); process.exit(1); }

  if (STAGE !== 'full') {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    console.log('probe 阶段到此为止，没点任何一项');
    process.exit(0);
  }

  const pick = menu.find((m) => m.t === '不生成费用明细');
  if (!pick) { console.log('菜单里没有「不生成费用明细」'); process.exit(1); }
  console.log('点', JSON.stringify(pick));
  await clickAt(s, pick.x, pick.y);

  const kids = await autoAttach(s);
  const sub = await kids.waitFor((u) => u.includes('piaozone'), { timeout: 45000 });
  if (!sub) { console.log('助手没起来'); process.exit(1); }
  await sleep(3000);

  const TEXT = `(() => { const vis = ${VIS}; const l = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const tx = (n.textContent||'').trim(); if (!tx || tx.length>60) continue; l.push(tx);
    } return l.join(' | '); })()`;
  const BOXES = `[...document.querySelectorAll('input.ant-checkbox-input')].map(n => {
    const b = n.getBoundingClientRect();
    return { checked: n.checked, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2),
      row: (n.closest('tr') ? n.closest('tr').textContent.trim().slice(0,16) : '(表头)') }; })`;
  const CLICKABLES = `(() => { const vis = ${VIS}; const out = [];
    for (const n of document.querySelectorAll('button,a,[role=button],.ant-btn')) {
      if (!vis(n)) continue; const tx = (n.textContent||'').trim();
      if (!tx || tx.length > 24) continue; const b = n.getBoundingClientRect();
      out.push({ t: tx, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2) });
    } return out; })()`;
  const MODALS = `(() => { const vis = ${VIS};
    return [...document.querySelectorAll('.ant-modal,[role=dialog],.ant-message,.ant-notification')]
      .filter(vis).map(n => (n.innerText||'').replace(/\\s+/g,' ').slice(0,240)); })()`;

  let t0 = await evalIn(sub, TEXT);
  console.log('助手初始文本:', String(t0).slice(0, 400));
  // 导入按钮不看勾选，会把列表里所有票都导走 —— 开工前必须是空列表。
  const boxes0 = await evalIn(sub, BOXES);
  const stale = boxes0.filter((b) => b.row !== '(表头)');
  if (stale.length) { console.log('助手列表里已有', stale.length, '张残留票，停：', JSON.stringify(stale)); process.exit(2); }
  console.log('助手列表为空，可以上传');

  if (!/上传发票影像/.test(t0)) { await clickAt(sub, 201, 133); await sleep(4000); }
  await sub.send('DOM.enable');
  const { root } = await sub.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await sub.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeId) { console.log('没找到 file input'); process.exit(1); }
  await sub.send('DOM.setFileInputFiles', { nodeId, files: [FILE] });
  let got = [];
  for (let i = 0; i < 14; i++) {
    await sleep(5000);
    const t = await evalIn(sub, TEXT);
    got = (await evalIn(sub, BOXES)).filter((b) => b.row !== '(表头)');
    if (got.length && !/上传处理中/.test(t)) break;
  }
  if (!got.length) { console.log('没等到识别结果:', String(await evalIn(sub, TEXT)).slice(0,400)); process.exit(1); }
  console.log('识别出', got.length, '行:', JSON.stringify(got));

  let boxes = await evalIn(sub, BOXES);
  let row = boxes.find((b) => b.row !== '(表头)');
  if (row && !row.checked) { await clickAt(sub, row.x, row.y); await sleep(2000);
    boxes = await evalIn(sub, BOXES); row = boxes.find((b) => b.row !== '(表头)'); }
  console.log('勾选后 checked =', row && row.checked, JSON.stringify(row));
  if (!row || !row.checked) { console.log('没勾上就不导入'); process.exit(2); }

  const btns = await evalIn(sub, CLICKABLES);
  const imp = btns.find((b) => /发票导入单据/.test(b.t)) || btns.find((b) => /导入/.test(b.t));
  if (!imp) { console.log('找不到导入按钮：', JSON.stringify(btns.map((b) => b.t))); process.exit(1); }
  console.log('导入按钮', JSON.stringify(imp));
  await clickAt(sub, imp.x, imp.y);

  // 导入不是点了就算数：先看汇总提示。出现「错误」或「0张发票可以导入」一律判失败，
  // 并把「已选发票列表」里的错因读出来 —— 汇总那层不含原因。
  {
    let summary = '';
    for (let i = 0; i < 6; i++) {
      await sleep(1500);
      const m = await evalIn(sub, MODALS).catch(() => []);
      if (m && m.length) { summary = m.join(' / '); break; }
    }
    console.log('导入汇总提示:', summary || '(没读到)');
    if (/错误|0张发票可以导入|失败/.test(summary)) {
      const why = await evalIn(sub, `(() => { const vis = ${VIS}; const out = [];
        for (const n of document.querySelectorAll('*')) {
          if (n.children.length !== 0 || !vis(n)) continue;
          const t = (n.textContent||'').trim();
          if (/错误原因|重复|禁止|失效|查验/.test(t) && t.length < 120) out.push(t);
        } return [...new Set(out)]; })()`).catch(() => []);
      console.log('列表里的错因:', JSON.stringify(why));
      console.log('导入被拒，停。');
      process.exit(2);
    }
  }

  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const tag = (i * 3 + 3) + 's';
    let alive = true;
    try {
      const m = await evalIn(sub, MODALS);
      if (m && m.length) console.log('  iframe 弹层 @' + tag, JSON.stringify(m).slice(0, 300));
    } catch (e) { alive = false; console.log('  iframe @' + tag + ' 已断开'); }
    const g = await grids(s, tag);
    const rows = g.r && g.r.rows ? g.r.rows.filter((x) => x.kind !== 'total') : [];
    if (!alive && rows.length) break;
  }
  console.log('--- 判定看：明细网格有没有被写入 ---');
  await grids(s, '收尾');
} finally { s.close(); }
