// Live exercise of the real `uploadInvoices` against the 发票无忧助手, with this task's real invoice files.
//
// It stops at the ADR-0025 consumption boundary: it uploads, waits for recognition and ticks the recognised rows,
// and it never calls `importInvoices`, so no invoice is bound to a 单据 and no 收票占用 is created. Everything it
// does is repeatable. It is a QA instrument, not part of the app.
//
// `pnpm --filter @baox/server exec tsx scripts/live-upload.ts` with a blank 费用报销单-新增 and its assistant open.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { autoAttach, connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { closeInvoiceAssistant, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from '@baox/erp-executor/steps';

const dataDir = process.env['BAOX_DATA_DIR'] ?? join(process.env['HOME'] ?? '', '.baox-app');
const db = new DatabaseSync(join(dataDir, 'baox.sqlite'), { readOnly: true });
const row = db.prepare('select plan from erp_job order by rowid desc limit 1').get() as { plan: string } | undefined;
if (!row) throw new Error('no erp_job in the database');
const plan = JSON.parse(row.plan).plan as { invoices: { sha256: string; fileName: string; mime: string }[] };

const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const dir = await mkdtemp(join(tmpdir(), 'baox-live-upload-'));
const paths: string[] = [];
for (const [index, ref] of plan.invoices.entries()) {
  const blob = join(dataDir, 'files', 'sha256', ref.sha256.slice(0, 2), ref.sha256);
  const bytes = await readFile(blob);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== ref.sha256) throw new Error(`blob ${ref.fileName} does not match its sha256`);
  const ext = extname(ref.fileName).toLowerCase() || MIME_EXTENSIONS[ref.mime] || '';
  const base = ref.fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'invoice';
  const path = join(dir, `${String(index + 1).padStart(2, '0')}-${base}${ext}`);
  await writeFile(path, bytes, { mode: 0o600 });
  paths.push(path);
}
console.log(`staged ${paths.length} invoices in ${dir}`);

const all = await targets(cdpPortOf());
const erp = all.find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
const assistantTarget = all.find((t) => String(t.url).includes('piaozone'));
if (!erp) throw new Error('no ERP page open');
if (!assistantTarget) throw new Error('assistant iframe not open');

const session = await connect(erp.webSocketDebuggerUrl!);
try {
  // Close and reopen the assistant through the real steps, so it comes back on its entry menu and the whole path
  // runs, 电脑端选取 included. Navigating the iframe by hand instead gives the OOPIF a new target id and strands
  // the attached session. Reopening after a run that imported nothing is also the cheap experiment ADR-0025 asks
  // for: the corpus only ever recorded reopening AFTER an import.
  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('closing the assistant:', JSON.stringify(await closeInvoiceAssistant(page)));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // A reopened assistant loads its entry menu but its kdInvoices view stays blank, so the spent 费用报销单-新增 page
  // instance is closed and a fresh one opened. Closing an unsaved blank 新增 tab writes nothing. If ERP asks about
  // unsaved changes this stops rather than answering: 保存 is never ours to click (ADR-0028).
  const closed = await evalIn<{ ok: boolean; reason?: string }>(session, `(() => {
    const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const tab = [...document.querySelectorAll('li.k-item')].filter(vis)
      .find((n) => String(n.textContent || '').trim() === '费用报销单-新增');
    if (!tab) return { ok: false, reason: 'no 费用报销单-新增 tab' };
    const closer = [...tab.querySelectorAll('span.mainTabCloseButton')].filter(vis);
    if (closer.length !== 1) return { ok: false, reason: 'close button not unique: ' + closer.length };
    closer[0].click();
    return { ok: true };
  })()`);
  console.log('closing the spent form tab:', JSON.stringify(closed));
  if (!closed?.ok) throw new Error('could not close the spent tab: ' + String(closed?.reason));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const dialog = await evalIn<string>(session, `(() => {
    const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const win = [...document.querySelectorAll('.k-window')].filter(vis);
    return win.map((n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)).join(' | ');
  })()`);
  if (dialog) throw new Error('ERP put up a dialog on close, stopping: ' + dialog);

  console.log('opening a fresh form:', JSON.stringify(await openNewReimbursement(page, { timeoutMs: 45_000 })));
  console.log('opening the assistant:', JSON.stringify(await openInvoiceAssistant(page, { timeoutMs: 90_000 })));
  // `uploadInvoices` now waits for the entry menu itself; LIVE_SETTLE_MS is kept only to re-measure that threshold.
  const settleMs = Number(process.env['LIVE_SETTLE_MS'] ?? 0);
  if (settleMs) {
    console.log(`settling ${settleMs}ms before touching the entry menu`);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  try {
    const result = await uploadInvoices(page, paths);
    console.log('uploadInvoices:', JSON.stringify(result));
  } catch (error) {
    console.log('uploadInvoices failed:', String((error as Error).message));
    // What do the piaozone targets look like at the moment of failure? A click that navigates the OOPIF can leave
    // the attached session pointing at a target that no longer exists.
    for (const t of await targets(cdpPortOf())) {
      if (!String(t.url).includes('piaozone')) continue;
      const probe = await connect(t.webSocketDebuggerUrl!);
      try {
        const state = await evalIn(probe, `(() => {
          const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
            return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
          return {
            url: location.href.split('?')[0],
            hasUploadTab: [...document.querySelectorAll('body *')].some((n) => vis(n) && own(n) === '上传发票影像'),
            fileInputs: document.querySelectorAll('input[type=file]').length,
            text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
          };
        })()`);
        console.log('  target', t.id ?? '?', JSON.stringify(state));
      } finally { probe.close(); }
    }
    throw error;
  }
} finally {
  session.close();
}
