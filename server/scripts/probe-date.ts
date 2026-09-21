// What IS the 开始日期 (start date) cell of the 费用明细 grid, and which commit key writes the date that was
// typed? Measured, not guessed.
//
// The live stop this exists for (2026-09-19): `writeCell` typed 「2026/9/6」 into 开始日期, pressed Enter, and
// the cell read back 「2026/9/20」 — that day's date in Beijing. One observation, three live explanations:
//   1. a date picker opens on the click and Enter picks its HIGHLIGHTED day instead of committing the text;
//   2. the typed format is rejected (`2026/9/6` vs `2026-09-06` vs `2026/09/06`) and the control falls back;
//   3. something recalculates the cell after the commit.
// Nobody had separated them, so this probe measures all three in one pass: the DOM of the control, whether a
// panel opens on the click and which day it marks, what the input holds before and after each commit, and what
// the non-editing cell reads back.
//
// ALL THREE WERE WRONG (measured 2026-09-20, output below). No panel ever opens; both formats are accepted; no
// late recalculation. The control is a Kendo datepicker that the ERP opens PRE-FILLED with today, and it ignores
// select-all, so the typed date was appended to today's and the datepicker parsed the front of the result.
// Backspace is the only clearing it answers to, and once it is empty Enter and Tab both commit faithfully.
// The fix that came out of this is `clearEditor` in `erp-executor/src/erpform.ts`.
//
// It opens a 费用报销单-新增 (new expense reimbursement) and types into a detail row, so it is not read-only —
// but it SAVES NOTHING: no 保存, no 提交, no 删除行, no 发票导入单据, and it touches no existing 单据. An unsaved
// 新增 form is scratch paper (ADR-0028: baox fills, the employee saves). Clean up afterwards with
// `reset-erp-tabs.ts`, which declines the save.
//
// Usage on the mac, against the dedicated ERP Chromium on CDP 9333:
//   pnpm --filter @baox/server exec tsx scripts/probe-date.ts
import { clickAt, connect, enableFocusEmulation, evalIn, pressKey, selectAll, targets, typeText } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { cellTarget, readGrid, sectionAnchors, showSection, writeCell } from '@baox/erp-executor/erpform';
import { clickReach } from '@baox/erp-executor/hit';
import { DEFAULT_PACE, sleep } from '@baox/erp-executor/pace';
import { addDetailRow, openNewReimbursement, type WritePage } from '@baox/erp-executor/steps';

const COLUMN = process.env['PROBE_DATE_COLUMN'] ?? '开始日期';
const ROW = Number(process.env['PROBE_DATE_ROW'] ?? 0);

// One measurement of everything that could explain the wrong date: the cell's control, every floating
// date-ish panel on the page, and which day each panel marks.
const MEASURE_JS = (column: string, row: number) => `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const box = (n) => { const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const clean = (s) => String(s ?? '').replace(/设置/g, '').replace(/\\s+/g, ' ').trim();
  const norm = (v) => v.replace(/^\\./, '').replace(/\\s*\\*$/, '').trim();
  const cls = (n) => String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || '');

  const out = {};
  // Today as the PAGE sees it, and today in Beijing: the wrong value in the live stop was exactly today.
  const now = new Date();
  out.today = {
    pageLocal: now.toLocaleDateString('en-CA'),
    beijing: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // The cell, located the way erpform.ts locates it: first visible .kd-grid-panel, columns by header order.
  const grid = [...document.querySelectorAll('.kd-grid-panel')].filter(vis)[0];
  if (!grid) return { ...out, ok: false, reason: 'no visible .kd-grid-panel' };
  const headCells = [...grid.querySelectorAll('th,[class*=header-cell]')].filter(vis);
  const heads = headCells.map((n) => norm(clean(n.innerText)));
  const headTr = headCells.length ? headCells[0].closest('tr') : null;
  const dataRows = [];
  for (const tr of [...grid.querySelectorAll('tr')].filter(vis)) {
    if (tr === headTr) continue;
    if (tr.children.length !== heads.length) continue;
    if (/k-footer-template/.test(cls(tr))) continue;
    dataRows.push(tr);
  }
  const tr = dataRows[${row}];
  const idx = heads.indexOf(${JSON.stringify(column)});
  out.columns = heads;
  out.dataRowCount = dataRows.length;
  if (!tr || idx < 0) return { ...out, ok: false, reason: 'row or column not found' };
  const td = tr.children[idx];

  const inp = td.querySelector('input,textarea');
  const a = document.activeElement;
  out.cell = {
    text: clean(td.innerText), box: box(td), tdCls: cls(td),
    rowEditing: /k-grid-edit-row/.test(cls(tr)),
    // Everything inside the cell, so a picker trigger button cannot hide in it unnoticed.
    inner: td.innerHTML.slice(0, 400),
    descendants: [...td.querySelectorAll('*')].map((n) => ({ tag: n.tagName, cls: cls(n).slice(0, 60), text: clean(n.innerText).slice(0, 20) })),
    input: inp ? { tag: inp.tagName, type: inp.getAttribute('type'), cls: cls(inp).slice(0, 80),
      id: inp.id || null, value: String(inp.value), readOnly: inp.readOnly, disabled: inp.disabled,
      autocomplete: inp.getAttribute('autocomplete'), role: inp.getAttribute('role'),
      ariaExpanded: inp.getAttribute('aria-expanded'), placeholder: inp.getAttribute('placeholder'),
      selectionStart: inp.selectionStart, selectionEnd: inp.selectionEnd } : null,
    focusedInCell: !!(a && td.contains(a) && a !== td),
    editorBound: !!(a && td.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)),
  };
  out.activeElement = a ? { tag: a.tagName, cls: cls(a).slice(0, 80), id: a.id || null,
    value: a.value === undefined ? null : String(a.value) } : null;

  // Every floating panel that could be a date picker: absolutely/fixed positioned, visible, and either
  // date-ish by class or holding a month grid of day numbers.
  const panels = [];
  for (const n of document.querySelectorAll('body *')) {
    if (!vis(n)) continue;
    const s = getComputedStyle(n);
    if (s.position !== 'absolute' && s.position !== 'fixed') continue;
    const b = n.getBoundingClientRect();
    if (b.width < 120 || b.height < 120) continue;
    const c = cls(n);
    const dateish = /date|calendar|picker|month|year/i.test(c);
    const days = [...n.querySelectorAll('td,li,span,div')].filter((d) => /^\\d{1,2}$/.test(clean(d.innerText)));
    if (!dateish && days.length < 20) continue;
    panels.push({
      tag: n.tagName, cls: c.slice(0, 100), box: box(n), z: s.zIndex, dateish, dayCells: days.length,
      title: clean(n.innerText).slice(0, 40),
      // Which days the panel MARKS, by any class a Kingdee/kendo calendar uses for today or the selection.
      marked: days.filter((d) => /selected|today|active|current|k-state|focus|kd-.*-on/i.test(cls(d)))
        .map((d) => ({ day: clean(d.innerText), cls: cls(d).slice(0, 70),
          title: d.getAttribute('title') || (d.firstElementChild && d.firstElementChild.getAttribute('title')) || null })),
    });
  }
  out.panels = panels;
  return { ...out, ok: true };
})()`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
// An occluded ERP window is `hidden`, and a hidden page swallows every Input.dispatchMouseEvent (V-53).
console.log('focus emulation:', JSON.stringify(await enableFocusEmulation(session)));

const measure = (tag: string) => evalIn<any>(session, MEASURE_JS(COLUMN, ROW)).then((m) => ({ tag, ...m }));
const show = (label: string, value: unknown) => console.log(`\n--- ${label}\n${JSON.stringify(value, null, 1)}`);

/** Click the cell the way `writeCell` does: hit-tested, then poll until an editor is actually bound. */
async function openEditor() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const spot = await cellTarget(session, { which: 0, row: ROW, column: COLUMN });
    if (!spot.ok) return { ok: false as const, reason: spot.reason };
    await clickReach(session, spot, `「${COLUMN}」`);
    for (let i = 0; i < 20; i += 1) {
      await sleep(300);
      const c = await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false });
      if (c.ok && c.editorBound === true) return { ok: true as const };
    }
  }
  return { ok: false as const, reason: 'editor never bound' };
}

/** The lightest blur available that changes no value: the 明细信息 section anchor (in-page navigation). */
async function blurOnNeutralPoint() {
  const anchor = (await sectionAnchors(session)).find((a) => a.label === '明细信息');
  if (!anchor || !anchor.onTarget) return { clicked: false, reason: '明细信息 anchor not reachable' };
  await clickAt(session, anchor.x, anchor.y);
  return { clicked: true, at: { x: anchor.x, y: anchor.y } };
}

type Clear = 'selectAll' | 'keyDownSelectAll' | 'bareMetaA' | 'backspace' | 'backspaceTrace' | 'backspaceDelete' | 'selectAllThenBackspace' | 'none';
type Candidate = { name: string; clear: Clear; value: string; commit: 'Enter' | 'Tab' | 'Escape+Tab' | 'blur' };

// Round 1 (live 2026-09-20) measured the control and killed all three standing hypotheses at once: the cell is a
// Kendo datepicker (`data-role="datepicker"`, `.k-widget.k-datepicker`), NO panel opens on the click
// (`aria-expanded=false`, zero floating panels), and after `selectAll()` + `typeText('2026/9/1')` the input held
//   value: "2026/9/202026/9/1"
// — the typed text was APPENDED to the ERP's own default (today in Beijing, 2026/9/20), and the datepicker
// parses the FRONT of that and ignores the rest, so the cell read back today. So the question is no longer
// which key commits: it is which keystrokes actually CLEAR this control.
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;
const META_A = { windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: SELECT_ALL_MODIFIER };

async function clearBy(how: Clear) {
  if (how === 'none') return;
  if (how === 'selectAll') return selectAll(session);
  if (how === 'keyDownSelectAll') {
    // Is `rawKeyDown` the reason the editing command is dropped? Chromium applies `commands` while handling the
    // key event, and the two event types take different paths.
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...META_A, commands: ['selectAll'] });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...META_A });
    return;
  }
  if (how === 'bareMetaA') {
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...META_A });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...META_A });
    return;
  }
  if (how === 'backspaceTrace') {
    // One Backspace at a time, reading the input after each, and once more a second later: the live run of
    // 2026-09-20 emptied 结束日期 and then read 「0」 back out of it, which no count of keystrokes explains.
    for (let i = 0; i < 14; i += 1) {
      await pressKey(session, 'Backspace');
      const m = await measure(`backspace-${i + 1}`);
      console.log(`TRACE backspace ${i + 1}: value=${JSON.stringify(m.cell?.input?.value)} `
        + `selection=${m.cell?.input?.selectionStart}..${m.cell?.input?.selectionEnd} cellText=${JSON.stringify(m.cell?.text)} `
        + `inputs=${m.cell?.descendants?.filter((d: any) => d.tag === 'INPUT').length}`);
    }
    await sleep(1500);
    const late = await measure('backspace-late');
    console.log(`TRACE 1.5s later: value=${JSON.stringify(late.cell?.input?.value)} inner=${JSON.stringify(late.cell?.inner)}`);
    return;
  }
  if (how === 'backspaceDelete') {
    // The caret lands where the CLICK landed (measured: 8 of 9 on 结束日期), so Backspace only ever reaches what
    // is left of it. Delete takes the rest — but a Delete that escaped the input could be a 删除行 (delete row)
    // on a Kingdee grid, so the row count is measured before and after and reported here, not assumed.
    const rowsBefore = (await measure('before-delete')).dataRowCount;
    for (let i = 0; i < 14; i += 1) await pressKey(session, 'Backspace');
    const afterBackspaces = await measure('after-backspaces');
    for (let i = 0; i < 14; i += 1) await pressKey(session, 'Delete');
    const afterDeletes = await measure('after-deletes');
    console.log(`TRACE backspace-then-delete: afterBackspaces=${JSON.stringify(afterBackspaces.cell?.input?.value)} `
      + `afterDeletes=${JSON.stringify(afterDeletes.cell?.input?.value)} `
      + `rows ${rowsBefore} -> ${afterDeletes.dataRowCount} (a row that vanished here would be a 删除行)`);
    return;
  }
  if (how === 'selectAllThenBackspace') {
    await selectAll(session);
    await pressKey(session, 'Backspace');
    return;
  }
  for (let i = 0; i < 14; i += 1) await pressKey(session, 'Backspace');
}

const TRACE = process.env['PROBE_DATE_TRACE'];
const CANDIDATES: Candidate[] = TRACE
  ? (TRACE === 'delete'
    ? [{ name: 'Backspace then Delete + Enter', clear: 'backspaceDelete', value: '2026/9/7', commit: 'Enter' }]
    : [{ name: 'Backspace one at a time + Enter', clear: 'backspaceTrace', value: '2026/9/6', commit: 'Enter' }])
  : [
  { name: 'selectAll (current writeCell) + Enter', clear: 'selectAll', value: '2026/9/1', commit: 'Enter' },
  { name: 'keyDown selectAll + Enter', clear: 'keyDownSelectAll', value: '2026/9/2', commit: 'Enter' },
  { name: 'bare Meta+A + Enter', clear: 'bareMetaA', value: '2026/9/3', commit: 'Enter' },
  { name: 'Backspace x14 + Enter', clear: 'backspace', value: '2026/9/4', commit: 'Enter' },
  { name: 'selectAll then Backspace + Enter', clear: 'selectAllThenBackspace', value: '2026/9/5', commit: 'Enter' },
  { name: 'Backspace x14 + Tab', clear: 'backspace', value: '2026/9/6', commit: 'Tab' },
  { name: 'Backspace x14, dashed ISO + Enter', clear: 'backspace', value: '2026-09-07', commit: 'Enter' },
  { name: 'Backspace x14, zero-padded slash + Enter', clear: 'backspace', value: '2026/09/08', commit: 'Enter' },
];

// The live stop of 2026-09-20 was on 结束日期, and only AFTER 开始日期 had been written — which moves 天数 and may
// be what re-fills the cell. Reproduce that order, with the real primitive, before measuring 结束日期.
const PREWRITE = process.env['PROBE_DATE_PREWRITE'];

try {
  const page: WritePage = { session, pace: DEFAULT_PACE };
  console.log('open 新增:', JSON.stringify(await openNewReimbursement(page)));
  console.log('明细信息:', JSON.stringify((await showSection(session, '明细信息')).ok));
  let grid = await readGrid(session, 0);
  console.log('grid:', JSON.stringify(grid.ok ? { columns: grid.columns.map((c) => c.label), rowCount: grid.rowCount } : grid));
  if (grid.ok && (grid.rowCount ?? 0) <= ROW) {
    console.log('add detail row:', JSON.stringify(await addDetailRow(page)));
    await sleep(2000);
    grid = await readGrid(session, 0);
    console.log('grid after add:', JSON.stringify(grid.ok ? { rowCount: grid.rowCount } : grid));
  }

  if (PREWRITE) {
    console.log('prewrite 开始日期:', JSON.stringify(await writeCell(session, { which: 0, row: ROW, column: '开始日期', value: PREWRITE, expect: { mode: 'equals', value: PREWRITE } })));
  }
  show('A. before any click', await measure('before-click'));
  const opened = await openEditor();
  console.log('open editor:', JSON.stringify(opened));
  show('B. after the click that binds the editor', await measure('after-click'));
  if (!opened.ok) process.exit(2);

  for (const candidate of CANDIDATES) {
    console.log(`\n\n======== ${candidate.name}: clear=${candidate.clear} type 「${candidate.value}」 commit=${candidate.commit}`);
    const bound = await cellTarget(session, { which: 0, row: ROW, column: COLUMN, scroll: false });
    if (!bound.ok || bound.editorBound !== true) {
      const again = await openEditor();
      console.log('re-open editor:', JSON.stringify(again));
      if (!again.ok) break;
    }
    await clearBy(candidate.clear);
    await sleep(300);
    const cleared = await measure('cleared');
    console.log(`CLEARED ${candidate.name}: inputValue=${JSON.stringify(cleared.cell?.input?.value)} `
      + `selection=${cleared.cell?.input?.selectionStart}..${cleared.cell?.input?.selectionEnd}`);
    await typeText(session, candidate.value);
    await sleep(500);
    show('C. typed, not yet committed', await measure('typed'));

    if (candidate.commit === 'Enter') await pressKey(session, 'Enter');
    else if (candidate.commit === 'Tab') await pressKey(session, 'Tab');
    else if (candidate.commit === 'Escape+Tab') { await pressKey(session, 'Escape'); await sleep(400); await pressKey(session, 'Tab'); }
    else console.log('blur:', JSON.stringify(await blurOnNeutralPoint()));

    await sleep(2500);
    const after = await measure('committed');
    show('D. committed', after);
    console.log(`VERDICT ${candidate.name}: typed=${candidate.value} cellText=${JSON.stringify(after.cell?.text)} inputValue=${JSON.stringify(after.cell?.input?.value)}`);
    // Leave edit mode, so the next candidate starts from the same state this one did.
    await blurOnNeutralPoint();
    await sleep(1200);
    const settled = await measure('settled');
    console.log(`SETTLED ${candidate.name}: cellText=${JSON.stringify(settled.cell?.text)} (a value that changes here is a late recalculation, cause 3)`);
  }

  // Phase E: is the select-all failure the DATEPICKER's, or every editor's? The fix depends on the answer: a
  // Kendo-only quirk is a date-column special case, a grid-wide one means every pre-filled cell (税额, which
  // `fillApprovedPreview` clears before writing) is concatenating too, and `writeHeader` with it.
  const selectionOf = (column: string) => evalIn<any>(session, MEASURE_JS(column, ROW)).then((m) => m.cell?.input);
  for (const [column, value] of [['费用金额', '100.00'], ['事由', 'QA']] as const) {
    const spot = await cellTarget(session, { which: 0, row: ROW, column });
    if (!spot.ok || !spot.onTarget) { console.log(`E ${column}: unreachable ${spot.reason ?? ''}`); continue; }
    await clickReach(session, spot, column);
    await sleep(1500);
    for (let i = 0; i < 14; i += 1) await pressKey(session, 'Backspace');
    await typeText(session, value);
    await pressKey(session, 'Enter');
    await sleep(2000);
    // Re-open the now non-empty cell and ask only one question: does select-all select anything?
    const again = await cellTarget(session, { which: 0, row: ROW, column });
    if (again.ok && again.onTarget) await clickReach(session, again, column);
    await sleep(1500);
    const before = await selectionOf(column);
    await selectAll(session);
    await sleep(300);
    const after = await selectionOf(column);
    console.log(`E ${column}: value=${JSON.stringify(after?.value)} beforeSelectAll=${before?.selectionStart}..${before?.selectionEnd} afterSelectAll=${after?.selectionStart}..${after?.selectionEnd}`);
  }
} finally {
  session.close();
}
