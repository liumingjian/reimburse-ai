// 只读：单据编号、单据状态、表头几个关键字段。判"到底存没存"用。
import { evalIn } from './src/chrome.mjs';
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, formTabs } from './src/erpform.mjs';
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  console.log('页签', JSON.stringify((await formTabs(s)).map((t) => t.label)));
  const r = await evalIn(s, `(() => {
    const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n);
      return b.width>0 && b.height>0 && st.visibility!=='hidden' && st.display!=='none'; };
    const want = ['单据编号','单据状态','申请人','申请日期','报销总金额','合计金额','币别'];
    const out = {};
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const tx = (n.textContent||'').replace(/\\s+/g,'').replace(/[:：*]/g,'').trim();
      if (!want.includes(tx)) continue;
      // 标签右边最近的那个值控件
      const box = n.closest('.kd-form-item,.k-widget,div');
      const host = box && box.parentElement ? box.parentElement : null;
      let v = '';
      if (host) {
        const inp = host.querySelector('input,textarea');
        if (inp) v = inp.value;
        if (!v) v = (host.innerText||'').replace(/\\s+/g,' ').replace(tx,'').trim().slice(0,60);
      }
      if (!(tx in out)) out[tx] = v;
    }
    return out;
  })()`);
  console.log('表头', JSON.stringify(r, null, 1));
} finally { s.close(); }
