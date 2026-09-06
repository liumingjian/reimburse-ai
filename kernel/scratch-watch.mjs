// 只读旁观：用户手工导发票的时候，把状态变化和相关控制台输出记下来。
// 这个脚本**不点任何东西**，只求值。
import { evalIn, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MINUTES = Number(process.env.WATCH_MIN || 5);

// 一次取回一份"现场快照"，变了才打印。
// 网格要按 .kd-grid-panel 认 —— 上一版按 <table> 找表头，
// Kendo 的表头和数据行不在同一个 table 里，所以整轮 grids 都是空的。
const SNAP = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
    return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
  const clean = (s) => (s||'').replace(/设置/g,'').replace(/\\s+/g,' ').trim();
  const wins = [...document.querySelectorAll('.k-window')].filter(vis)
    .map(n => clean(n.innerText).slice(0,24));
  const gridInfo = [];
  const panels = [...document.querySelectorAll('.kd-grid-panel')].filter(vis);
  panels.forEach((g, i) => {
    const headCells = [...g.querySelectorAll('th,[class*=header-cell]')].filter(vis);
    const heads = headCells.map(n => clean(n.innerText).replace(/^\\./,'').replace(/\\s*\\*$/,''));
    const headTr = headCells.length ? headCells[0].closest('tr') : null;
    const out = [];
    for (const tr of [...g.querySelectorAll('tr')].filter(vis)) {
      if (tr === headTr) continue;
      const tds = [...tr.children];
      const vals = tds.map(td => {
        const inp = td.querySelector('input,textarea');
        const t = clean(td.innerText);
        return (t === '' && inp && inp.value !== '') ? '<' + inp.value + '>' : t;
      });
      if (!vals.some(v => v !== '')) continue;
      const mark = (/k-grid-edit-row/.test(tr.className) ? '*edit' : '')
                 + (/k-state-selected/.test(tr.className) ? '*sel' : '')
                 + (/k-footer-template/.test(tr.className) ? '*total' : '');
      // 只留有值的列，配上列名，别把一屏的 0.00 都刷出来。
      const pairs = vals.map((v, j) => (v && v !== '0.00' && v !== '0')
        ? (heads[j] || ('c' + j)) + '=' + v : null).filter(Boolean);
      out.push(mark + '{' + pairs.join(',') + '}');
    }
    gridInfo.push('#' + i + '(' + heads.length + '列)' + out.join(''));
  });
  const ae = document.activeElement;
  return {
    wins: wins.join(','),
    grids: gridInfo.join(' || ').slice(0, 900),
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
    if (/PiaoZone|PWY|copys|FRECINVINFO|FEINVOICE|FREIMBANDREC|invoice/i.test(t)) logs.push(t.slice(0, 400));
  });
  await s.send('Runtime.enable');

  console.log('开始旁观，' + MINUTES + ' 分钟。请照平时的做法把发票导进这张单。');
  let last = '';
  let lastLog = 0;
  const started = Date.now();
  const until = started + MINUTES * 60000;
  while (Date.now() < until) {
    await sleep(1500);
    let snap;
    try { snap = await evalIn(s, SNAP); } catch { continue; }
    const pz = (await kids.list()).some((i) => (i.url || '').includes('piaozone'));
    const line = JSON.stringify({ ...snap, pz });
    if (line !== last) {
      console.log('[' + Math.round((Date.now() - started) / 1000) + 's]', line.slice(0, 1200));
      last = line;
    }
    while (lastLog < logs.length) console.log('    log:', logs[lastLog++]);
  }
  console.log('--- 旁观结束 ---');
} finally { s.close(); }
