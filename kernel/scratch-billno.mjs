import { authorizedPage } from './src/erpcatalog.mjs';
import { openSession, headerField, formTabs } from './src/erpform.mjs';
const gate = await authorizedPage({});
if (!gate.ok) process.exit(2);
const s = await openSession(gate.wsUrl);
try {
  console.log('页签', JSON.stringify(await formTabs(s)));
  for (const k of ['FBILLNO', 'FDATE', 'FCAUSA']) {
    const r = await headerField(s, k);
    console.log(k, JSON.stringify({ value: r.value, instances: r.instances, visible: r.visibleInstances }));
  }
} finally { s.close(); }
