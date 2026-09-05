// 只读旁观：用户手工导发票的时候，把状态变化和相关控制台输出记下来。
// 这个脚本**不点任何东西**，只求值。
import { evalIn, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MINUTES = Number(process.env.WATCH_MIN || 5);

// 一次取回一份"现场快照"，变了才打印。
const SNAP = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  const wins = [...document.querySelectorAll('.k-window')].filter(vis)
    .map(n => (n.innerText||'').trim().split('\\n')[0].slice(0,20));
  const grids = [...document.querySelectorAll('table')].filter(vis);
  const gridInfo = [];
  for (const g of grids) {
    const heads = [...g.querySelectorAll('th')].map(h => (h.textContent||'').trim());
    if (!heads.length) continue;
    const key = heads.includes('发票号码') ? '收票' : (heads.includes('费用项目') ? '明细' : null);
    if (!key) continue;
    const rows = [...g.querySelectorAll('tbody tr')].filter(r => !r.className.includes('k-footer-template'));
    gridInfo.push(key + ':' + rows.length + '行 ' +
      rows.map(r => [...r.children].map(c => (c.textContent||'').trim())
        .filter(t => t && t !== '0.00').slice(0, 5).join('/')).join(' ; ').slice(0, 180));
  }
  const ae = document.activeElement;
  return {
    wins: wins.join(','),
    grids: gridInfo.join(' || '),
    focus: ae ? ae.tagName + '.' + String(ae.className||'').slice(0,26) : '',
    sel: [...document.querySelectorAll('tr.k-state-selected,tr.k-grid-edit-row')].length,
  };
})()`;

const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const kids = await autoAttach(s);
  const logs = [];
  s.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ');
    if (/PiaoZone|PWY|copys|FRECINVINFO|FEINVOICE|FREIMBANDREC|invoice/i.test(t)) logs.push(t.slice(0, 230));
  });
  await s.send('Runtime.enable');

  console.log('开始旁观，' + MINUTES + ' 分钟。请照平时的做法把发票导进这张单。');
  let last = '';
  let lastLog = 0;
  const until = Date.now() + MINUTES * 60000;
  while (Date.now() < until) {
    await sleep(1500);
    let snap;
    try { snap = await evalIn(s, SNAP); } catch { continue; }
    const pz = (await kids.list()).some((i) => (i.url || '').includes('piaozone'));
    const line = JSON.stringify({ ...snap, pz });
    if (line !== last) {
      const t = Math.round((Date.now() - (until - MINUTES * 60000)) / 1000);
      console.log('[' + t + 's]', line.slice(0, 420));
      last = line;
    }
    while (lastLog < logs.length) console.log('    log:', logs[lastLog++]);
  }
  console.log('--- 旁观结束 ---');
} finally { s.close(); }
