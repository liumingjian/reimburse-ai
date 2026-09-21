// Reproduce the HUMAN path into 税额 (tax), step by step, with the editor under observation at every step.
//
// The owner reports (2026-09-20) that 费用金额 (net) and 税额 are BOTH hand-fillable on this very form, and that
// 申请报销金额/申请付款金额 then compute as their sum — tested by hand in the same live browser this drives. That
// contradicts V-67's rule, so the difference is in HOW we write, not in what the column allows. This separates
// the two candidate causes that V-67 could not:
//   (a) the characters never reach the editor (typeText sends no keyCode; a Kendo numeric filter would eat them)
//   (b) they reach it and the commit discards them (one Enter, no blur, no change event)
// It reads document.activeElement and the edit row's inputs BEFORE the click, after the click, after typing and
// after the commit, so (a) and (b) leave different traces.
//
// Writes only into 费用金额/税额 of one row on an UNSAVED 新增. Saves nothing, imports nothing, deletes nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-human.ts [--blur]
import { autoAttach, clickAt, connect, enableFocusEmulation, evalIn, pressKey, selectAll, targets, typeText, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { cellTarget, readGridByColumn, settleGrid, writeCell } from '../src/erp/executor/erpform';
import { sleep } from '../src/erp/executor/pace';

const ROW = 0;
const NET = '费用金额';
const TAX = '税额';
const SUM = '申请报销金额';
const PAY = '申请付款金额';

const readRow = async (session: CdpSession) => {
  const grid = await readGridByColumn(session, SUM);
  if (!grid.ok) return { ok: false as const, reason: grid.reason };
  const row = grid.rows.filter((r) => r.kind === 'data')[ROW];
  if (!row) return { ok: false as const, reason: '没有这一行' };
  const v = row.values;
  return { ok: true as const, editing: row.editing, net: v[NET] ?? '', tax: v[TAX] ?? '', sum: v[SUM] ?? '',
    pay: v[PAY] ?? '', edit: row.editValues ?? {} };
};

// What has focus, and what every input in the edit row currently holds. `\\s` on purpose: a template literal
// eats a lone `\s`.
const ACTIVE = `(() => {
  const a = document.activeElement;
  const tr = document.querySelector('tr.k-grid-edit-row');
  const one = (n) => ({ cls: String(n.className || '').slice(0, 44), role: n.getAttribute('data-role'),
    v: String(n.value), hidden: n.offsetParent === null });
  return {
    focus: a ? { tag: a.tagName, cls: String(a.className || '').slice(0, 44), role: a.getAttribute('data-role'),
      v: 'value' in a ? String(a.value) : null } : null,
    editRow: !!tr,
    inputs: tr ? [...tr.querySelectorAll('input,textarea')].map(one) : [],
  };
})()`;

const look = (session: CdpSession, when: string) =>
  evalIn<any>(session, ACTIVE).then((r) => console.log(when, JSON.stringify(r)))
    .catch((e) => console.log(when, 'threw', String(e).slice(0, 160)));

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  await enableFocusEmulation(session);
  await autoAttach(session);
  const blur = process.argv.includes('--blur');
  // Two knobs, so one run at a time can be made to differ from the hand path by exactly one thing.
  const storm = process.argv.includes('--storm');   // clear the way clearEditor does, not with one Delete
  const settle = process.argv.includes('--settle'); // wait for the grid to go quiet first, as writeCell does
  console.log('knobs:', JSON.stringify({ blur, storm, settle }));
  console.log('commit style:', blur ? 'click another cell (what a human does)' : 'Enter (what writeCell does)');
  console.log('before:', JSON.stringify(await readRow(session)));

  // Clear both money cells so nothing is inherited from the round before.
  for (const column of [NET, TAX]) {
    await writeCell(session, { which: 0, row: ROW, column, value: '', expect: { mode: 'equals', value: '' }, settleFirst: true })
      .catch(() => undefined);
  }
  await sleep(1500);
  console.log('cleared:', JSON.stringify(await readRow(session)));

  /** One column, by hand, with the editor watched at every step. */
  const hand = async (column: string, value: string) => {
    console.log('=== ' + column + ' <- ' + value);
    if (settle) await settleGrid(session, 0);
    await look(session, '  step0 before click:');
    const spot = await cellTarget(session, { which: 0, row: ROW, column });
    console.log('  cell:', JSON.stringify(spot));
    if (!spot.ok) return;
    await clickAt(session, spot.x, spot.y);
    await sleep(1200);
    await look(session, '  step1 after click:');

    await selectAll(session);
    if (storm) {
      // clearEditor's own clearing: one more key than the length each way, twice over.
      const seen = String((await cellTarget(session, { which: 0, row: ROW, column, scroll: false })).editValue ?? '');
      console.log('  storm clearing over:', JSON.stringify(seen));
      for (let i = 0; i < seen.length + 1; i++) await pressKey(session, 'Backspace');
      for (let i = 0; i < seen.length + 1; i++) await pressKey(session, 'Delete');
    } else {
      await pressKey(session, 'Delete');
    }
    await sleep(400);
    await look(session, '  step2 after clearing:');

    await typeText(session, value);
    await sleep(800);
    await look(session, '  step3 after typing:');

    if (blur) {
      // Commit the way a person does: click a neutral cell and let the editor lose focus.
      const neutral = await cellTarget(session, { which: 0, row: ROW, column: '费用项目' });
      if (neutral.ok) await clickAt(session, neutral.x, neutral.y);
    } else {
      await pressKey(session, 'Enter');
    }
    await sleep(1500);
    await look(session, '  step4 after commit:');
    console.log('  row:', JSON.stringify(await readRow(session)));
    await sleep(3000);
    console.log('  settled:', JSON.stringify(await readRow(session)));
  };

  /** The product's own writeCell, with the row read before and after so a failure can be placed. */
  const real = async (column: string, value: string) => {
    console.log('=== writeCell ' + column + ' <- ' + value);
    await look(session, '  before:');
    const done = await writeCell(session, { which: 0, row: ROW, column, value, expect: { mode: 'equals', value }, settleFirst: true })
      .catch((error: any) => ({ ok: false, reason: String(error?.message ?? error) }));
    console.log('  result:', JSON.stringify(done));
    await look(session, '  after:');
    console.log('  row:', JSON.stringify(await readRow(session)));
    await sleep(3000);
    console.log('  settled:', JSON.stringify(await readRow(session)));
  };

  const put = process.argv.includes('--real') ? real : hand;
  await put(NET, '32.18');
  await put(TAX, '0.32');
} finally {
  session.close();
}
