// 导入刚点完：把两个网格、弹窗、助手是否还在，一次全读回来。
import { evalIn } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, showSection, readGrid, formTabs } from './src/erpform.mjs';
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  console.log('页签', JSON.stringify((await formTabs(s)).map((t) => t.label)));
  console.log('弹窗', JSON.stringify(await evalIn(s, `(() => {
    const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
      return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
    return [...document.querySelectorAll('.k-window,[role=dialog],.kdMessageBox')].filter(vis)
      .map(n => (n.innerText||'').replace(/\\s+/g,' ').slice(0,120)); })()`)));
  await showSection(s, '收票信息');
  console.log('收票网格:');
  for (const r of (await readGrid(s, 1)).rows) console.log('  [' + r.kind + ']', JSON.stringify(r.values).slice(0, 400));
  await showSection(s, '明细信息');
  console.log('明细网格:');
  for (const r of (await readGrid(s, 0)).rows) console.log('  [' + r.kind + ']', JSON.stringify(r.values).slice(0, 500));
} finally { s.close(); }
