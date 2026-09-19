// What ERP does with 费用金额 (net) and 税额 (tax), and WHEN its own computed 申请报销金额 catches up.
//
// The live stop this exists for (2026-09-20): a full fill wrote eleven 费用明细 rows, every cell read back the
// value that had just been typed into it, and three rows still carried a 申请报销金额 that was not 费用金额 + 税额
// (row 1 ¥32.18+¥0.32 -> ¥32.18, row 2 ¥15.56+¥0.47 -> ¥0.47, row 11 ¥1,677.36+¥100.64 -> ¥1,677.36). The form
// total came out 116.52 short. `writeCell` compares the very cell it typed into, so a value that is in the DOM
// but never reached ERP's model reads back as a success; ERP's computed column is the only witness.
//
// This script measures the mechanism instead of guessing at it. It writes the two money cells of ONE detail row
// on an UNSAVED 新增 (new) bill, over and over, varying the order and the pace, and after every keystroke burst
// it SAMPLES the row over time: both cell texts, both editor values, the computed 申请报销金额, the grid's own
// total row, and the ERP requests that went out in between. It saves nothing, submits nothing, deletes nothing
// and adds at most one detail row.
//
//   pnpm --filter @baox/server exec tsx scripts/probe-money.ts --dry     # read-only: the plan and what is on screen
//   pnpm --filter @baox/server exec tsx scripts/probe-money.ts           # writes the two money cells, repeatedly
import { autoAttach, connect, enableFocusEmulation, targets, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { readGridByColumn, showSection, writeCell } from '../src/erp/executor/erpform';
import { addDetailRow, openNewReimbursement, type WritePage } from '../src/erp/executor/steps';
import { sleep } from '../src/erp/executor/pace';

const dry = process.argv.includes('--dry');
const ROW = 0;
const NET = '费用金额';
const TAX = '税额';
const SUM = '申请报销金额';

// The three pairs that failed live, plus one that succeeded, so a variant is not judged on one shape of number.
const PAIRS: Array<{ net: string; tax: string }> = [
  { net: '32.18', tax: '0.32' },
  { net: '15.56', tax: '0.47' },
  { net: '1677.36', tax: '100.64' },
  { net: '644.95', tax: '58.05' },
];

type Variant = { name: string; order: 'net_first' | 'tax_first'; gapMs: number; settleFirst: boolean };
const VARIANTS: Variant[] = [
  { name: 'production', order: 'net_first', gapMs: 0, settleFirst: true },
  { name: 'back_to_back', order: 'net_first', gapMs: 0, settleFirst: false },
  { name: 'tax_first', order: 'tax_first', gapMs: 0, settleFirst: true },
  { name: 'slow_gap_3s', order: 'net_first', gapMs: 3000, settleFirst: true },
];

const money = (t: unknown) => {
  const s = String(t ?? '').replace(/[¥￥,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * 100) : null;
};

/** One reading of the row under test: what the cells show, what their editors hold, and what ERP computed. */
const readRow = async (session: CdpSession) => {
  const grid = await readGridByColumn(session, SUM);
  if (!grid.ok) return { ok: false as const, reason: grid.reason };
  const data = grid.rows.filter((r) => r.kind === 'data');
  const total = grid.rows.find((r) => r.kind === 'total');
  const row = data[ROW];
  if (!row) return { ok: false as const, reason: `网格里没有第 ${ROW + 1} 条明细`, rowCount: data.length };
  return {
    ok: true as const, rowCount: data.length, editing: row.editing,
    net: row.values[NET] ?? '', tax: row.values[TAX] ?? '', sum: row.values[SUM] ?? '',
    editNet: row.editValues?.[NET] ?? null, editTax: row.editValues?.[TAX] ?? null, editSum: row.editValues?.[SUM] ?? null,
    total: total?.values[SUM] ?? null,
  };
};

/** Sample the row every `everyMs` for `forMs`, keeping only the readings that differ from the one before. */
const sampleRow = async (session: CdpSession, { forMs, everyMs = 250 }: { forMs: number; everyMs?: number }) => {
  const started = Date.now();
  const out: Array<Record<string, unknown>> = [];
  let last = '';
  do {
    const seen = await readRow(session);
    const key = JSON.stringify(seen);
    if (key !== last) { out.push({ t: Date.now() - started, ...seen }); last = key; }
    await sleep(everyMs);
  } while (Date.now() - started < forMs);
  return out;
};

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);

// Every ERP request that goes out, so a write that changed nothing on the wire is distinguishable from one whose
// answer simply came back late. Only the path and the time are kept; no payload is read.
const wire: Array<{ t: number; url: string }> = [];
let mark = Date.now();
const since = () => { const from = mark; mark = Date.now(); return wire.filter((r) => r.t >= from).map((r) => `${r.t - from}ms ${r.url}`); };

try {
  await enableFocusEmulation(session);
  await session.send('Network.enable', {});
  session.on?.('Network.requestWillBeSent', (p: any) => {
    const url = String(p?.request?.url ?? '');
    if (url.includes('erp.antute.com.cn')) wire.push({ t: Date.now(), url: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 80) });
  });

  const page: WritePage = { session, children: await autoAttach(session) };
  console.log('variants    :', JSON.stringify(VARIANTS.map((v) => v.name)));
  console.log('pairs       :', JSON.stringify(PAIRS));
  console.log('before      :', JSON.stringify(await readRow(session)));
  if (dry) process.exit(0);

  const before = await readRow(session);
  if (!before.ok) {
    console.log('open form   :', JSON.stringify(await openNewReimbursement(page)));
    console.log('section     :', JSON.stringify((await showSection(session, '明细信息')).ok));
  }
  const now = await readRow(session);
  if (!now.ok) console.log('add row     :', JSON.stringify(await addDetailRow(page)));

  const verdicts: Array<Record<string, unknown>> = [];
  for (const variant of VARIANTS) {
    for (const pair of PAIRS) {
      const label = `${variant.name} ${pair.net}+${pair.tax}`;
      const columns = variant.order === 'net_first'
        ? [{ column: NET, value: pair.net }, { column: TAX, value: pair.tax }]
        : [{ column: TAX, value: pair.tax }, { column: NET, value: pair.net }];
      const steps: Array<Record<string, unknown>> = [];
      let broke: string | null = null;
      for (const [index, spec] of columns.entries()) {
        if (index > 0 && variant.gapMs) await sleep(variant.gapMs);
        since();
        const wrote = await writeCell(session, { which: 0, row: ROW, column: spec.column, value: spec.value,
          expect: { mode: 'equals', value: spec.value }, settleFirst: variant.settleFirst });
        const after = await sampleRow(session, { forMs: 4000 });
        steps.push({ column: spec.column, value: spec.value, ok: wrote.ok, readBack: wrote.after ?? null,
          reason: wrote.reason ?? null, requests: since(), samples: after });
        if (!wrote.ok) { broke = String(wrote.reason ?? ''); break; }
      }
      // Leaving the row is the last chance ERP has to take a value it is still holding in an editor.
      await showSection(session, '明细信息');
      const settled = await sampleRow(session, { forMs: 5000, everyMs: 500 });
      const final = await readRow(session);
      const expected = money(pair.net)! + money(pair.tax)!;
      const got = final.ok ? money(final.sum) : null;
      verdicts.push({ label, agrees: got === expected, expected, got,
        net: final.ok ? final.net : null, tax: final.ok ? final.tax : null, editing: final.ok ? final.editing : null,
        total: final.ok ? final.total : null, broke });
      console.log(JSON.stringify({ trial: label, variant, pair, broke, steps, afterLeave: settled, final }, null, 1));
    }
  }
  console.log('=== verdicts ===');
  for (const v of verdicts) console.log(JSON.stringify(v));
  const bad = verdicts.filter((v) => !v.agrees).length;
  console.log(`=== ${verdicts.length - bad}/${verdicts.length} trials had 申请报销金额 == 费用金额 + 税额 ===`);
} finally {
  session.close();
}
