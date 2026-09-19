// Live exercise of the real `importInvoices` — the one step `live-upload.ts` stops short of.
//
// It CROSSES the ADR-0025 consumption boundary: it uploads this task's real invoices, ticks them and clicks
// 发票导入单据, which binds them to the 费用报销单 on screen. That is safe to repeat because the ERP re-binds an
// existing 收票单 rather than minting a new one (ADR-0026, 「已存在对应的收票单，已进行覆盖」) and the bill is never
// saved, but it is not free, so it refuses to start without BAOX_ERP_LIVE_IMPORT=1. It saves nothing, submits
// nothing and deletes nothing.
//
// BAOX_DATA_DIR=<app data dir> pnpm --filter @baox/server exec tsx scripts/live-import.ts
// It wants a tab strip with no 费用报销单-新增 on it (run scripts/reset-erp-tabs.ts first).

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { autoAttach, connect, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { importInvoices, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from '../src/erp/executor/steps';

if (process.env['BAOX_ERP_LIVE_IMPORT'] !== '1') {
  console.error('refusing to run: this script crosses the 发票导入单据 consumption boundary. Set BAOX_ERP_LIVE_IMPORT=1.');
  process.exit(2);
}

const dataDir = process.env['BAOX_DATA_DIR'] ?? join(process.env['HOME'] ?? '', '.baox-app');
const db = new DatabaseSync(join(dataDir, 'baox.sqlite'), { readOnly: true });
const row = db.prepare('select plan from erp_job order by rowid desc limit 1').get() as { plan: string } | undefined;
if (!row) throw new Error('no erp_job in the database');
const plan = JSON.parse(row.plan).plan as { invoices: { sha256: string; fileName: string; mime: string }[] };

const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const dir = await mkdtemp(join(tmpdir(), 'baox-live-import-'));
const paths: string[] = [];
for (const [index, ref] of plan.invoices.entries()) {
  const blob = join(dataDir, 'files', 'sha256', ref.sha256.slice(0, 2), ref.sha256);
  const bytes = await readFile(blob);
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error(`blob ${ref.fileName} does not match its sha256`);
  const ext = extname(ref.fileName).toLowerCase() || MIME_EXTENSIONS[ref.mime] || '';
  const base = ref.fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'invoice';
  const path = join(dir, `${String(index + 1).padStart(2, '0')}-${base}${ext}`);
  await writeFile(path, bytes, { mode: 0o600 });
  paths.push(path);
}
console.log(`staged ${paths.length} invoices in ${dir}`);

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) throw new Error('no ERP page open');
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('fresh form  :', JSON.stringify(await openNewReimbursement(page, { timeoutMs: 45_000 })));
  console.log('assistant   :', JSON.stringify(await openInvoiceAssistant(page, { timeoutMs: 90_000 })));
  console.log('upload      :', JSON.stringify(await uploadInvoices(page, paths)));
  console.log('import      :', JSON.stringify(await importInvoices(page)));
} finally {
  session.close();
}
