// 只读：回读明细 / 收票两个网格。
import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, readGrid, formTabs } from './src/erpform.mjs';
const gate = await authorizedPage({});
if (!gate.ok) { console.log('身份没过'); process.exit(2); }
const s = await openSession(gate.wsUrl);
try {
  console.log('页签', JSON.stringify(await formTabs(s)));
  for (const [i, name] of [[0, '明细'], [1, '收票']]) {
    const g = await readGrid(s, i).catch((e) => ({ err: String(e) }));
    console.log('==', name);
    if (g.err) { console.log('  ', g.err); continue; }
    for (const r of g.rows || []) {
      const kept = Object.entries(r.values).filter(([, v]) => v && v !== '0.00' && v !== '0');
      console.log('  ', r.kind, JSON.stringify(Object.fromEntries(kept)));
    }
  }
} finally { s.close(); }
