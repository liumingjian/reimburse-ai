// A one-off MEASUREMENT of what the 选择发票 split menu's second item, 不合并生成费用明细
// (do not merge, generate expense details), actually produces in the 费用明细 grid.
//
// Why it exists: baox imports with 不生成费用明细, and that mode leaves 收票单号 empty on every detail row, while
// the strict read-back keys detail rows BY 收票单号 (`erp-executor/src/draft-flow.ts` detailRowsForFill,
// matchReceiptRows). 不合并生成费用明细 has never been measured. This script measures it and prints the grids; it
// changes no product behaviour and decides nothing.
//
// It CROSSES the ADR-0025 consumption boundary exactly as `live-import.ts` does — it uploads invoices, ticks them
// and clicks 发票导入单据 — so it refuses to start without BAOX_ERP_MAPPING_PROBE=1. It saves nothing, submits
// nothing, deletes nothing and clicks no item on the never-click list.
//
// BAOX_ERP_MAPPING_PROBE=1 PROBE_INVOICES='<file>:<file>:...' \
//   pnpm --filter @baox/server exec tsx scripts/probe-import-mode.ts
// It wants a tab strip with no 费用报销单 tab on it (run scripts/reset-erp-tabs.ts first).

import { autoAttach, connect, enableFocusEmulation, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { readGridByColumn } from '@baox/erp-executor/erpform';
import { importInvoices, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from '@baox/erp-executor/steps';
import { DETAIL_COLUMN, RECEIPTS_COLUMN, readForm } from '@baox/erp-executor/reader';

const MODE_ID = process.env['PROBE_IMPORT_MODE'] ?? 'tbMappingFillEntry';

if (process.env['BAOX_ERP_MAPPING_PROBE'] !== '1') {
  console.error('refusing to run: this script crosses the 发票导入单据 consumption boundary. Set BAOX_ERP_MAPPING_PROBE=1.');
  process.exit(2);
}
const paths = (process.env['PROBE_INVOICES'] ?? '').split(':').filter(Boolean);
if (!paths.length) { console.error('PROBE_INVOICES must list the invoice files, colon separated'); process.exit(2); }
console.log(`staged ${paths.length} invoices`);

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) throw new Error('no ERP page open');
const session = await connect(erp.webSocketDebuggerUrl!);
// This script connects on its own, so it claims focus itself (V-53: a hidden page receives no mouse event at all).
console.log('focus emulation:', JSON.stringify(await enableFocusEmulation(session)));
try {
  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('fresh form  :', JSON.stringify(await openNewReimbursement(page, { timeoutMs: 45_000 })));
  console.log('assistant   :', JSON.stringify(await openInvoiceAssistant(page, { timeoutMs: 90_000, modeId: MODE_ID })));
  console.log('upload      :', JSON.stringify(await uploadInvoices(page, paths)));
  console.log('import      :', JSON.stringify(await importInvoices(page)));
  const form = await readForm(session);
  console.log('formMode    :', JSON.stringify(form.formMode));
  console.log('billNo      :', JSON.stringify(form.billNo));
  console.log(`receipts(${RECEIPTS_COLUMN}):`, JSON.stringify(await readGridByColumn(session, RECEIPTS_COLUMN)));
  console.log(`detail(${DETAIL_COLUMN}):`, JSON.stringify(await readGridByColumn(session, DETAIL_COLUMN)));
} finally {
  session.close();
}
