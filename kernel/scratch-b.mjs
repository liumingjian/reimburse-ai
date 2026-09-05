// B 核心：在**干净的**新增单上，上传 -> 勾选（验 checked）-> 发票导入单据 -> 回读收票网格。
// 每一步都要有证据；勾不上就不导入。
import { evalIn, clickAt, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, showSection, readGrid } from './src/erpform.mjs';
import { resolve } from 'node:path';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = resolve(process.cwd(), 'resources/交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf');

const TEXT = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  const l = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    const tx = (n.textContent||'').trim(); if (!tx || tx.length>40) continue;
    l.push(tx);
  }
  return l.join(' | ');
})()`;
const BOXES = `[...document.querySelectorAll('input.ant-checkbox-input')].map(n => {
  const b = n.getBoundingClientRect();
  return { checked: n.checked, x: Math.round(b.x+b.width/2), y: Math.round(b.y+b.height/2),
    // 用销方名称认行；发票号码不往日志里带。
    row: (n.closest('tr') ? n.closest('tr').textContent.trim().slice(0,14) : '(表头)') };
})`;

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
  console.log('勾选前 checked =', row.checked);
  if (!row.checked) {
    await clickAt(sub, row.x, row.y);
    await sleep(2000);
    boxes = await evalIn(sub, BOXES);
    row = boxes.find((b) => /苏州市吉利优行/.test(b.row));
  }
  console.log('勾选后 checked =', row && row.checked);
  if (!row || !row.checked) { console.log('没勾上就不导入'); process.exit(2); }

  console.log('导入前收票数据行',
    (await readGrid(s, 1)).rows.filter((r) => r.kind !== 'footer').length);
  await clickAt(sub, 721, 499);   // 发票导入单据
  for (let i = 0; i < 8; i++) {
    await sleep(3000);
    const g = await readGrid(s, 1).catch(() => null);
    const rows = g ? g.rows.filter((r) => r.kind !== 'footer') : [];
    const filled = rows.filter((r) => Object.values(r.values).some((v) => v && v !== '0' && v !== '0.00'));
    console.log('[' + (i * 3 + 3) + 's] 收票行', rows.length, '有值行', filled.length,
      filled.length ? JSON.stringify(filled[0].values).slice(0, 320) : '');
    if (filled.length) break;
  }
} finally { s.close(); }
