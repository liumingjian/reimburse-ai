// Watch what a LOOKUP column (F7, e.g. 项目 / 费用项目) does under the same keys `writeCell` sends.
//
// The live full round (2026-09-20) stopped on the detail row's first field: 写了「111705」，「项目」回读是「」，
// and the new `held` witness reported the editor as EMPTY throughout — so unlike the money cells, the characters
// never reached the editor at all. That is a different failure from a commit racing the parse, and it needs the
// cell's own structure read, not just its value: an F7 cell may carry a button and a hidden input beside the one
// that takes keys.
//
// Writes into ONE cell of one row on an UNSAVED 新增. Saves nothing, imports nothing, deletes nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-lookup.ts [--column 项目] [--value 111705] [--commit|--real]
import { autoAttach, clickAt, connect, enableFocusEmulation, evalIn, pressKey, targets, typeText } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { cellTarget, readGridByColumn, settleGrid, writeCell } from '@baox/erp-executor/erpform';
import { addDetailRow } from '@baox/erp-executor/steps';
import { sleep } from '@baox/erp-executor/pace';

const flag = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const COLUMN = flag('column', '项目');
const VALUE = flag('value', '111705');
const ROW = 0;

// Everything the edit row holds, plus the structure of the cell under the caret: an F7 usually renders a wrapper
// with a button, so `\\s` on purpose — a template literal eats a lone `\s`.
const LOOK = `(() => {
  const a = document.activeElement;
  const tr = document.querySelector('tr.k-grid-edit-row');
  const one = (n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 50), role: n.getAttribute('data-role'),
    ro: n.readOnly === true, v: String(n.value ?? ''), hidden: n.offsetParent === null });
  const td = tr ? [...tr.querySelectorAll('td')].find((c) => c.querySelector('input,textarea')) : null;
  return JSON.stringify({
    focus: a ? { tag: a.tagName, cls: String(a.className || '').slice(0, 50), ro: a.readOnly === true, v: 'value' in a ? String(a.value) : null } : null,
    editRow: !!tr,
    inputs: tr ? [...tr.querySelectorAll('input,textarea')].map(one) : [],
    editingCellHtml: td ? td.innerHTML.replace(/\\s+/g, ' ').slice(0, 400) : null,
    // A lookup that opened a dropdown leaves a popup in the document; its presence separates "the keys arrived and
    // the ERP is searching" from "the keys went nowhere".
    popups: [...document.querySelectorAll('.k-animation-container, .k-list-container, [id*=Popup]')]
      .filter((n) => n.offsetParent !== null).map((n) => String(n.className || n.id).slice(0, 60)),
  });
})()`;

const look = async (session: any, when: string) => {
  const raw = await evalIn<string>(session, LOOK).catch((e) => `threw ${String(e).slice(0, 120)}`);
  console.log(when, raw);
};

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp?.webSocketDebuggerUrl) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl);
try {
  await enableFocusEmulation(session);
  await autoAttach(session);
  console.log('column:', COLUMN, 'value:', VALUE, 'commit:', process.argv.includes('--commit'));

  await settleGrid(session, 0);
  await look(session, 'step0 before click:');

  // What a 下拉类 column actually offers, exactly as the page spells it — the fill matches candidates by strict
  // equality, so a trailing space or a different wording is the whole difference between a match and a stop.
  if (process.argv.includes('--options')) {
    // Every list on the page, visible or not, plus the cell's own editor state — so "no candidates" can be told
    // apart from "the list is there and hidden" and from "the control never opened".
    const LISTS = `(() => {
      const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const lists = [...document.querySelectorAll('ul[class*=k-list], .k-list-container, .k-animation-container')].map((n) => ({
        cls: String(n.className || '').slice(0, 50), vis: vis(n),
        items: [...n.querySelectorAll('li')].map((li) => ({ t: String(li.textContent).trim().slice(0, 20), vis: vis(li) })),
      }));
      const tr = document.querySelector('tr.k-grid-edit-row');
      const td = tr ? [...tr.querySelectorAll('td')].find((c) => c.querySelector('input,textarea,span[tabindex]')) : null;
      return JSON.stringify({ lists, editingCell: td ? td.innerHTML.replace(/\\s+/g, ' ').slice(0, 220) : null });
    })()`;
    if (process.argv.includes('--fresh')) {
      console.log('addDetailRow:', JSON.stringify(await addDetailRow({ session } as never)));
    }
    const grid0 = await readGridByColumn(session, COLUMN);
    const rowAt = process.argv.includes('--fresh') && grid0.ok ? grid0.rows.filter((r) => r.kind === 'data').length - 1 : ROW;
    for (const attempt of [1, 2, 3]) {
      const spot3 = await cellTarget(session, { which: 0, row: rowAt, column: COLUMN });
      console.log(`click ${attempt} cell:`, JSON.stringify(spot3));
      if (!spot3.ok) break;
      await clickAt(session, spot3.x, spot3.y);
      await sleep(1800);
      console.log(`  lists after click ${attempt}:`, await evalIn<string>(session, LISTS));
    }
    process.exit(0);
  }

  // Two measurements the failure needs and `--real` cannot give: does RE-TYPING rescue an editor that took
  // nothing, and does the F7 cell resolve 「select」 into the project name on its own if simply waited out?
  if (process.argv.includes('--watch')) {
    const added = await addDetailRow({ session } as never);
    console.log('addDetailRow:', JSON.stringify(added));
    const target = (added as any).rowIndex as number;
    const at = () => cellTarget(session, { which: 0, row: target, column: COLUMN, scroll: false });

    const spot2 = await cellTarget(session, { which: 0, row: target, column: COLUMN });
    await clickAt(session, spot2.x!, spot2.y!);
    for (let i = 0; i < 20; i += 1) { const c = await at(); if (c.ok && c.editorBound) break; await sleep(200); }
    console.log('bound:', JSON.stringify(await at()));

    // Type, witness, and type again if the editor took nothing at all.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await typeText(session, VALUE);
      await sleep(1200);
      const c = await at();
      console.log(`  after typing attempt ${attempt}:`, JSON.stringify({ editValue: c.editValue, bound: c.editorBound, focus: c.focusTag }));
      if (c.ok && String(c.editValue ?? '') !== '') break;
      // Re-focus before trying again: a control the ERP re-rendered has taken the old input away.
      const again = await cellTarget(session, { which: 0, row: target, column: COLUMN });
      if (again.ok) await clickAt(session, again.x, again.y);
      await sleep(600);
    }

    await pressKey(session, 'Enter');
    // Watch the cell resolve — or not — for half a minute, printing only what changes.
    let last = '';
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      const c = await at();
      const now = JSON.stringify({ text: c.text, editValue: c.editValue, editing: c.editing, bound: c.editorBound });
      if (now !== last) { console.log('  +' + (i + 1) + 's', now); last = now; }
    }
    process.exit(0);
  }

  // The product's own path, whole: clearing included, which is the one thing the hand path above leaves out.
  if (process.argv.includes('--real')) {
    const readback = flag('readback', VALUE);
    // `--fresh` isolates the one thing that differed when the live round failed: the row was BRAND NEW, so the F7
    // editor had never been opened on it. 新增行 is the same toolbar command the fill itself uses; it adds an empty
    // detail row and saves nothing.
    let target = ROW;
    if (process.argv.includes('--fresh')) {
      const added = await addDetailRow({ session } as never);
      const grid = await readGridByColumn(session, COLUMN);
      target = grid.ok ? grid.rows.filter((r) => r.kind === 'data').length - 1 : ROW;
      console.log('addDetailRow:', JSON.stringify(added));
      console.log('added a fresh row; writing into row index', target);
    }
    const before = await cellTarget(session, { which: 0, row: target, column: COLUMN });
    console.log('real before:', JSON.stringify(before));
    const result = await writeCell(session, { which: 0, row: target, column: COLUMN, value: VALUE, expect: { mode: 'equals', value: readback } });
    console.log('real result:', JSON.stringify(result));
    await look(session, 'real after:');
    await sleep(2500);
    const grid = await readGridByColumn(session, COLUMN);
    const row = grid.ok ? grid.rows.filter((r) => r.kind === 'data')[target] : null;
    console.log('real row:', JSON.stringify(row ? { editing: row.editing, value: row.values[COLUMN], edit: row.editValues?.[COLUMN] } : grid));
    process.exit(0);
  }

  const spot = await cellTarget(session, { which: 0, row: ROW, column: COLUMN });
  console.log('cell:', JSON.stringify(spot));
  if (!spot.ok) process.exit(2);

  await clickAt(session, spot.x, spot.y);
  await sleep(1500);
  await look(session, 'step1 after click:');
  console.log('cellTarget after click:', JSON.stringify(await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false })));

  await typeText(session, VALUE);
  await sleep(2000);
  await look(session, 'step2 after typing:');
  console.log('cellTarget after typing:', JSON.stringify(await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false })));

  if (process.argv.includes('--commit')) {
    await pressKey(session, 'Enter');
    await sleep(2500);
    await look(session, 'step3 after Enter:');
    console.log('cellTarget after Enter:', JSON.stringify(await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false })));
  }
} finally {
  session.close();
}
