// Read the 费用明细 grid of whatever 费用报销单 is on screen, as a table. Reads only; writes nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-rows-now.ts
import { connect, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { readGridByColumn } from '@baox/erp-executor/erpform';

const COLUMNS = ['收票单号', '项目', '费用项目', '发票类型', '开始日期', '费用金额', '税额', '申请报销金额', '申请付款金额'];

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp?.webSocketDebuggerUrl) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl);
try {
  const grid = await readGridByColumn(session, '申请报销金额');
  if (!grid.ok) { console.log('grid:', JSON.stringify(grid).slice(0, 300)); process.exit(2); }
  const rows = grid.rows.filter((r) => r.kind === 'data');
  console.log(`rows: ${rows.length}`);
  rows.forEach((row, index) => {
    const shown = COLUMNS.map((c) => `${c}=${row.values[c] ?? ''}`).join(' | ');
    console.log(`  ${String(index + 1).padStart(2)} ${shown}`);
  });
  const total = grid.rows.find((r) => r.kind === 'total');
  if (total) console.log('total:', JSON.stringify(total.values));
} finally {
  session.close();
}
