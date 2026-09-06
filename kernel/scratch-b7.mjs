// 只读：把「已选发票列表」数据行的 HTML 拉出来，找预警元素和它的 title/提示文本。
import { evalIn, autoAttach } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession } from './src/erpform.mjs';
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  const kids = await autoAttach(s);
  const sub = await kids.waitFor((u) => u.includes('piaozone'), { timeout: 8000 });
  if (!sub) { console.log('助手没开着'); process.exit(1); }
  const html = await evalIn(sub, `(() => {
    for (const tr of document.querySelectorAll('tr')) {
      if (/26112000003288524821/.test(tr.textContent||'')) return tr.outerHTML;
    }
    return null; })()`);
  console.log('行 HTML:', String(html).slice(0, 3000));
  const err = await evalIn(sub, `(() => {
    const out = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0) continue;
      const t = (n.textContent||'').trim();
      if (/重复报销|错误原因|SPD|FYBX|单据/.test(t) && t.length < 120) out.push(t);
      const ti = n.getAttribute && n.getAttribute('title');
      if (ti && ti.trim()) out.push('[title] ' + ti.trim().slice(0,120));
    }
    return [...new Set(out)]; })()`);
  console.log('错误/标题文本:', JSON.stringify(err).slice(0, 1200));
} finally { s.close(); }
