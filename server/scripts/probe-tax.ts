// Does ERP fill 税额 (tax) BY ITSELF once 费用金额 (net) is written, or does it have to be typed?
//
// The live stop it exists for (2026-09-20): the first fill ever to reach 填写明细 died on its first money cell
// («写了「32.18」，「费用金额」回读是「」»), and a 16-trial run of `probe-money.ts` on the same form came back
// 5/16 with the SAME failure over and over — «写了「…」，「税额」回读是「」». V-59's model (a ~260ms model lag,
// paced between the two writes) does not explain that: an empty read-back is not a late one. The hypothesis this
// measures is simpler — on a row ERP has linked to a 收票 record, ERP OWNS 税额, and a typed one is discarded.
//
// Unlike `probe-money.ts` this resets the row between trials, so no trial inherits the one before it. It writes
// only 费用金额, never 税额, on an UNSAVED 新增; it saves nothing, imports nothing and deletes nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-tax.ts
import { autoAttach, connect, enableFocusEmulation, targets, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { readGridByColumn, writeCell } from '../src/erp/executor/erpform';
import { sleep } from '../src/erp/executor/pace';

const ROW = 0;
const NET = '费用金额';
const TAX = '税额';
const SUM = '申请报销金额';
const RECEIPT = '收票单号';
const RATE = '税率(%)';

const NETS = ['32.18', '15.56', '1677.36', '644.95'];

const readRow = async (session: CdpSession) => {
  const grid = await readGridByColumn(session, SUM);
  if (!grid.ok) return { ok: false as const, reason: grid.reason };
  const row = grid.rows.filter((r) => r.kind === 'data')[ROW];
  if (!row) return { ok: false as const, reason: '没有这一行' };
  const v = row.values;
  return { ok: true as const, editing: row.editing, net: v[NET] ?? '', tax: v[TAX] ?? '', sum: v[SUM] ?? '',
    receipt: v[RECEIPT] ?? '', rate: v[RATE] ?? '' };
};

/** Sample the row for `forMs`, keeping only readings that differ from the one before. */
const watch = async (session: CdpSession, forMs: number) => {
  const started = Date.now();
  const out: Array<Record<string, unknown>> = [];
  let last = '';
  do {
    const seen = await readRow(session);
    const key = JSON.stringify(seen);
    if (key !== last) { out.push({ t: Date.now() - started, ...seen }); last = key; }
    await sleep(250);
  } while (Date.now() - started < forMs);
  return out;
};

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  await enableFocusEmulation(session);
  await autoAttach(session);
  console.log('before:', JSON.stringify(await readRow(session)));
  for (const net of NETS) {
    // Reset first, so no trial inherits the one before it — the flaw that made `probe-money.ts`'s tallies
    // unreadable (its 'tax_first 32.18' trial started with 644.95 already in the cell).
    const cleared = await writeCell(session, { which: 0, row: ROW, column: NET, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true });
    await sleep(1500);
    const afterClear = await readRow(session);
    const wrote = await writeCell(session, { which: 0, row: ROW, column: NET, value: net, expect: { mode: 'equals', value: net }, settleFirst: true });
    // Ten seconds is far longer than the ~260ms V-59 measured: if ERP is going to produce 税额 on its own, it
    // has had every chance, and if it never does then typing it is the only way it can ever be there.
    const samples = await watch(session, 10_000);
    console.log(JSON.stringify({ net, cleared: cleared.ok, afterClear, wroteOk: wrote.ok, wroteReason: wrote.reason ?? null,
      readBack: wrote.after ?? null, samples }, null, 1));
  }
  console.log('after:', JSON.stringify(await readRow(session)));
} finally { session.close(); }
