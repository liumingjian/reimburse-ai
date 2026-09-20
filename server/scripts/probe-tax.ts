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
import { autoAttach, connect, enableFocusEmulation, evalIn, pressKey, targets, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { leaveEdit, readGridByColumn, showSection, writeCell } from '../src/erp/executor/erpform';
import { addDetailRow, openNewReimbursement, type WritePage } from '../src/erp/executor/steps';
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
    receipt: v[RECEIPT] ?? '', rate: v[RATE] ?? '', edit: row.editValues ?? {} };
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
  const children = await autoAttach(session);
  console.log('before:', JSON.stringify(await readRow(session)));

  // `--orders` asks the narrower question the first run raised: is 税额 unwritable FULL STOP, or only unwritable
  // after 费用金额 has been written? Same row, cleared before each trial, one variable changed between them.
  if (process.argv.includes('--orders')) {
    const clear = async () => {
      for (const column of [NET, TAX]) {
        await writeCell(session, { which: 0, row: ROW, column, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true })
          .catch(() => undefined);
      }
      await sleep(1500);
      return readRow(session);
    };
    const put = async (column: string, value: string) => {
      const done = await writeCell(session, { which: 0, row: ROW, column, value, expect: { mode: 'equals', value }, settleFirst: true })
        .catch((error: any) => ({ ok: false, reason: String(error?.message ?? error), after: null }));
      return { column, value, ok: done.ok, reason: (done as any).reason ?? null, readBack: (done as any).after ?? null };
    };
    for (const pair of [{ net: '32.18', tax: '0.32' }, { net: '644.95', tax: '58.05' }]) {
      console.log('TAX ALONE  cleared:', JSON.stringify(await clear()));
      const taxAlone = await put(TAX, pair.tax);
      console.log('TAX ALONE  ', JSON.stringify({ ...taxAlone, settled: await readRow(session), after10s: (await watch(session, 10_000)).slice(-1) }));

      console.log('NET THEN TAX cleared:', JSON.stringify(await clear()));
      const first = await put(NET, pair.net);
      await sleep(3000);
      const second = await put(TAX, pair.tax);
      console.log('NET THEN TAX', JSON.stringify({ first, second, settled: await readRow(session) }));
    }
    process.exit(0);
  }

  // `--taxfirst` tests the one order the fill has never used. Measured 2026-09-20: writing 税额 into a CLEAN row
  // makes ERP compute 申请报销金额 from it within ~257ms, while writing it straight after 费用金额 leaves the
  // computed column stuck at the net alone (32.18+0.32 -> 32.18, 644.95+58.05 -> 644.95 — V-59's signature,
  // reproduced twice in a row). If the recalculation that runs on the LAST commit is the one that counts, then
  // committing the net last should make it count BOTH.
  if (process.argv.includes('--taxfirst')) {
    const clear = async () => {
      for (const column of [NET, TAX]) {
        await writeCell(session, { which: 0, row: ROW, column, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true })
          .catch(() => undefined);
      }
      // Long enough that the next trial does not start inside the previous one's recalculation — the mistake that
      // made the first `--orders` run unreadable (its clear had not taken, and the row was still in edit mode).
      await sleep(3000);
      return readRow(session);
    };
    const put = async (column: string, value: string) => {
      const done = await writeCell(session, { which: 0, row: ROW, column, value, expect: { mode: 'equals', value }, settleFirst: true })
        .catch((error: any) => ({ ok: false, reason: String(error?.message ?? error), after: null }));
      return { column, value, ok: done.ok, reason: (done as any).reason ?? null, readBack: (done as any).after ?? null };
    };
    // Every column of the row, once: the five this probe names are a guess at which ones matter, and the
    // 税率(%) reading that keeps coming back empty is only interesting next to what ERP put in the rest.
    const all = await readGridByColumn(session, SUM);
    console.log('columns:', JSON.stringify(all.ok ? all.rows.filter((r) => r.kind === 'data')[ROW]?.values : all));
    for (const pair of [{ net: '32.18', tax: '0.32' }, { net: '644.95', tax: '58.05' }, { net: '1677.36', tax: '100.64' }]) {
      const cleared = await clear();
      const first = await put(TAX, pair.tax);
      await sleep(1500);
      const between = await readRow(session);
      const second = await put(NET, pair.net);
      const samples = await watch(session, 8000);
      console.log('TAX FIRST', JSON.stringify({ pair, cleared, first, between, second, last: samples.slice(-1)[0] ?? null }));
    }
    process.exit(0);
  }

  // `--editor` answers the question V-66 could only point at: when a money write "fails", did the editor never
  // RECEIVE the value, or did it receive it and the commit get discarded?
  //
  // The distinction is readable because `readGridByColumn` reports the two separately — `values[col]` is the
  // cell's committed text, `editValues[col]` is the live `input.value` of the editor sitting in that cell. And
  // it matters, because `writeCell`'s entire commit step is ONE Enter key (erpform.ts:355): no blur, no
  // `change`, no Kendo widget call. Its read-back then polls `td.innerText`, which an OPEN editor leaves empty.
  // So «回读是「」» and «editing: true» are not two symptoms — on that reading they are one: Enter did not close
  // the editor. This mode tests exactly that, and then tries the commits `writeCell` never tries.
  //
  // It also dumps every input in the edit row. A Kendo NumericTextBox paints a visible formatted input FIRST and
  // keeps the real name-bearing value in a hidden sibling; `td.querySelector('input,textarea')` takes the first.
  // If that is what these cells are, then everything the code has ever "read back" from an editor — including
  // `clearEditor`'s proof that it emptied the cell — was a reading of the display node alone.
  if (process.argv.includes('--editor')) {
    // Scoped to `tr.k-grid-edit-row`, which exists only in the BODY table — the header table cannot match it.
    // (V-65 wasted a run on a hand-written «first tr», which in Kendo lands in the header.)
    const EDIT_ROW = `(() => {
      const tr = document.querySelector('tr.k-grid-edit-row');
      if (!tr) return { editRow: false };
      const cells = [...tr.children].map((td) => ({
        text: String(td.innerText || '').replace(/\\s+/g, ' ').trim(),
        inputs: [...td.querySelectorAll('input,textarea')].map((n) => ({
          tag: n.tagName, cls: String(n.className || '').slice(0, 60), name: n.getAttribute('name'),
          type: n.getAttribute('type'), role: n.getAttribute('data-role'),
          value: String(n.value), hidden: n.offsetParent === null,
        })),
      })).filter((c) => c.inputs.length > 0);
      return { editRow: true, cells };
    })()`;

    const page: WritePage = { session, children };
    if (!(await readRow(session)).ok) {
      console.log('open form :', JSON.stringify(await openNewReimbursement(page)));
      console.log('section   :', JSON.stringify((await showSection(session, '明细信息')).ok));
    }
    if (!(await readRow(session)).ok) console.log('add row   :', JSON.stringify(await addDetailRow(page)));

    const clear = async () => {
      for (const column of [NET, TAX]) {
        await writeCell(session, { which: 0, row: ROW, column, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true })
          .catch(() => undefined);
      }
      await sleep(3000);
      return readRow(session);
    };

    for (const pair of [{ net: '32.18', tax: '0.32' }, { net: '644.95', tax: '58.05' }, { net: '15.56', tax: '0.47' }]) {
      console.log('=== pair', JSON.stringify(pair), 'cleared:', JSON.stringify(await clear()));
      for (const [column, value] of [[NET, pair.net], [TAX, pair.tax]] as Array<[string, string]>) {
        // A SHORT read-back budget on purpose: the point is to look at the row while the editor is still up,
        // not to find out 8s later that the text never arrived. The 10s watch below covers the slow case.
        const wrote = await writeCell(session, { which: 0, row: ROW, column, value,
          expect: { mode: 'equals', value }, settleFirst: true, settleMs: 1500 })
          .catch((error: any) => ({ ok: false, reason: String(error?.message ?? error), after: null }));
        const straightAfter = await readRow(session);
        const dom = await evalIn<any>(session, EDIT_ROW).catch((error) => ({ thrown: String(error).slice(0, 200) }));
        // Ten seconds of waiting, never yet measured: does the cell — or ERP's computed 申请报销金额 — ever
        // catch up on its own? Every earlier observation read once, immediately.
        const waited = await watch(session, 10_000);

        // Only when it did not take. Each escalation is a commit `writeCell` does not perform today, tried in
        // order of how little it disturbs: Tab commits the same editor; leaving the row is the blur that
        // Kendo's own widgets treat as final. Neither types anything, so neither can put a wrong figure in.
        const escalation: Record<string, unknown> = {};
        if (!(wrote as any).ok) {
          await pressKey(session, 'Tab');
          await sleep(2000);
          escalation.afterTab = await readRow(session);
          if (!String((escalation.afterTab as any)?.[column === NET ? 'net' : 'tax'] ?? '')) {
            escalation.leave = await leaveEdit(session).catch((e: any) => ({ ok: false, reason: String(e?.message ?? e) }));
            await sleep(2000);
            escalation.afterLeave = await readRow(session);
          }
        }
        console.log(JSON.stringify({ trial: `${column}=${value}`, wroteOk: (wrote as any).ok,
          reason: (wrote as any).reason ?? null, readBack: (wrote as any).after ?? null,
          straightAfter, dom, waitedFirst: waited[0] ?? null, waitedLast: waited.slice(-1)[0] ?? null,
          waitedSteps: waited.length, escalation }, null, 1));
      }
      console.log('=== pair settled:', JSON.stringify(await readRow(session)));
    }
    process.exit(0);
  }

  // `--rate` tests the rule the numbers themselves point at. Measured 2026-09-20 over --editor and --taxfirst,
  // with no counterexample: ERP CLEARS 税额 the moment 费用金额 commits, and refuses a 税额 write while 费用金额
  // is non-empty. (The «about half the writes do not take» of V-66 was rows that a failed clear had left dirty,
  // not flakiness — every failure in this round had 费用金额 non-empty at the time of the write.) So 税额 is not
  // an input column at all. And the four pairs the fill was carrying divide exactly, to the cent:
  //   32.18→0.32 = 1%   15.56→0.47 = 3%   1677.36→100.64 = 6%   644.95→58.05 = 9%
  // all four standard VAT rates. If 税额 is derived from 税率(%), then writing the RATE is the only way to put
  // a tax on the row — and the value ERP computes should match the invoice's own tax to the cent.
  if (process.argv.includes('--rate')) {
    const clear = async () => {
      for (const column of [TAX, NET, RATE]) {
        await writeCell(session, { which: 0, row: ROW, column, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true })
          .catch(() => undefined);
      }
      await sleep(3000);
      return readRow(session);
    };
    const put = async (column: string, value: string) => {
      const done = await writeCell(session, { which: 0, row: ROW, column, value, expect: { mode: 'equals', value }, settleFirst: true })
        .catch((error: any) => ({ ok: false, reason: String(error?.message ?? error), after: null }));
      return { column, value, ok: (done as any).ok, reason: (done as any).reason ?? null, readBack: (done as any).after ?? null };
    };
    for (const t of [{ net: '32.18', rate: '1', tax: '0.32' }, { net: '644.95', rate: '9', tax: '58.05' },
      { net: '1677.36', rate: '6', tax: '100.64' }, { net: '15.56', rate: '3', tax: '0.47' }]) {
      const cleared = await clear();
      const net = await put(NET, t.net);
      await sleep(1500);
      // The rate is written LAST on purpose: 费用金额 is the commit that wipes 税额, so a rate written before it
      // would be judged on a row that is about to be recalculated anyway.
      const rate = await put(RATE, t.rate);
      const samples = await watch(session, 10_000);
      const last = samples.slice(-1)[0] as any;
      console.log('RATE', JSON.stringify({ want: t, cleared, net, rate, settled: last ?? null,
        taxAgrees: String(last?.tax ?? '').replace(/[¥￥,]/g, '') === t.tax,
        sumAgrees: String(last?.sum ?? '').replace(/[¥￥,]/g, '')
          === (Math.round((Number(t.net) + Number(t.tax)) * 100) / 100).toFixed(2) }));
    }
    process.exit(0);
  }

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
