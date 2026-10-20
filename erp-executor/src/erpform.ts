// Origin: 50931a3:kernel/src/erpform.mjs (CDP form primitives of the 费用报销单 expense reimbursement form).
//
// Facts measured on K3Cloud 8.2.0 (2026-09-05) that shape this module:
//   1. Detail grid cells carry no field key, so grids are located and read by header label only.
//   2. The grid scrolls horizontally. Cell text stays in the DOM, so reads never scroll; writes must scroll the
//      target column into view first, because real mouse events hit viewport coordinates.
//   3. Kingdee controls ignore programmatic assignment ("visible while editing, lost on blur"). The only write
//      path is: real click into edit mode -> empty the editor -> type key by key -> Enter/Tab.
//   4. Emptying it is not select-all: the date editors are Kendo datepickers, they open pre-filled with today,
//      and they ignore select-all, so the typed value is appended to today's date (`clearEditor`).
// Every write is read back at once from the non-editing cell text: written and received by ERP are different.
// This module never saves.

import { evalIn, pressKey, selectAll, typeText, type CdpSession } from './cdp';
import { headerFieldSnippet, type HeaderField } from './header-locator';
import { HIT_JS, clickReach, reachProblem, type Reach } from './hit';
import { sleep, waitFor, type Pace, DEFAULT_PACE } from './pace';

const SECTIONS = ['基本信息', '付款信息', '明细信息', '收票信息'];

const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;

/** ERP's loading overlay, shown (live 2026-10-19/20): it takes clicks, and a lookup resolves under it. */
export const OVERLAY_SHOWN = `[...document.querySelectorAll('.kd-ui-blockingExtention-item')].some((n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
})`;

/** At once when the overlay is not up; else once it has stayed away for `quietMs`, or after `maxMs`. */
async function outwaitOverlay(session: CdpSession, { quietMs, pollMs }: Pace, maxMs: number) {
  if (!(await evalIn<boolean>(session, OVERLAY_SHOWN).catch(() => false))) return;
  const deadline = Date.now() + maxMs;
  let clearSince: number | null = null;
  while (Date.now() < deadline) {
    if (await evalIn<boolean>(session, OVERLAY_SHOWN).catch(() => false)) clearSince = null;
    else if ((clearSince ??= Date.now()) <= Date.now() - quietMs) return;
    await sleep(pollMs);
  }
}

export type FormTab = { label: string; mode: 'new' | 'modify'; x: number; y: number };
export type GridColumn = { label: string; required?: boolean };
export type GridRow = { y?: number; kind: 'data' | 'total'; editing?: boolean; values: Record<string, string>; editValues?: Record<string, string> };
export type Grid =
  | { ok: true; columns: GridColumn[]; rowCount?: number; rows: GridRow[]; matchedGrids?: number }
  | { ok: false; reason: string; matchedGrids?: number; [extra: string]: unknown };

/** Open form tabs, and whether each is 新增 (new) or 修改 (modify): one of the save postconditions. */
export async function formTabs(session: CdpSession): Promise<FormTab[]> {
  return evalIn(session, `(() => {
    const vis = ${VIS};
    const tabs = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const t = n.textContent.trim();
      // 修改 with or without spaces: live 2026-10-13 the tab read 「费用报销单 - 修改」 after 暂存 (tabs.ts has met the
      // spaced caption on a loading 新增 too), and the exact match read that as no form at all.
      if (/^费用报销单(-新增|\\s*-\\s*修改)$/.test(t)) {
        const b = n.getBoundingClientRect();
        tabs.push({ label: t, mode: t.endsWith('修改') ? 'modify' : 'new',
          x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
      }
    }
    return tabs;
  })()`);
}

/** Section anchors (基本信息/付款信息/明细信息/收票信息) on the top navigation bar. */
export async function sectionAnchors(session: CdpSession): Promise<Array<Reach & { label: string }>> {
  return evalIn(session, `(() => {
    const vis = ${VIS};
    const at = ${HIT_JS};
    const want = ${JSON.stringify(SECTIONS)};
    const out = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const t = n.textContent.trim();
      if (!want.includes(t)) continue;
      const b = n.getBoundingClientRect();
      // Anchors sit on the top bar; a same-named heading in the body is not one.
      if (b.y > 260) continue;
      out.push({ label: t, ...at(n) });
    }
    return out;
  })()`);
}

/**
 * Render a section. 明细信息 renders lazily; clicking its anchor is in-page navigation and changes no value.
 *
 * The anchor is polled until a mouse event sent at it would actually reach it, not read once. A form that is
 * still opening paints the ERP's own blocking overlay over the whole top bar — the same
 * `kd-ui-blockingExtention-item` that `tabs.ts` outwaits on the tab strip — and measured live 2026-09-19 on a
 * freshly opened 费用报销单-新增, `elementFromPoint` at the 收票信息 anchor (312, 145) answered an anonymous DIV.
 * Refusing on the first read calls a form that is merely busy a form that is stuck; clicking anyway sends the
 * navigation to the overlay and reports a section that was never shown. So: wait for it, then click it, and
 * refuse only when the cover is still there at the end — naming it.
 *
 * The bound is the generic slow-ERP one (`pace.longMs`, 90 s live) rather than a budget of its own: what is being
 * waited for is a form finishing its own opening, which is the same work `openNewReimbursement` already bounds at
 * 45 s. `tabs.ts` has seen this overlay sit for two minutes over a form being CLOSED with ten 收票行 on it; if a
 * freshly opened blank form ever takes that long here, this is the wait to lengthen, with the measurement.
 */
export async function showSection(session: CdpSession, label: string, { settleMs = 2500, pace = DEFAULT_PACE }: { settleMs?: number; pace?: Pace } = {}) {
  const find = async () => (await sectionAnchors(session)).find((a) => a.label === label) ?? null;
  const anchor = await waitFor(find, (a) => a !== null && a.onTarget === true, pace.longMs, pace.pollMs);
  if (!anchor) return { ok: false as const, reason: `页面上找不到「${label}」区域锚点`, anchors: await sectionAnchors(session) };
  const problem = reachProblem(`「${label}」区域锚点`, anchor);
  if (problem) return { ok: false as const, reason: problem, anchors: [anchor] };
  await clickReach(session, anchor, `「${label}」区域锚点`);
  await sleep(settleMs);
  return { ok: true as const, anchor };
}

// Grid location. Reads and writes share one row/column rule, or "read row 2" and "write row 2" could differ.
// Columns align by DOM order, never by x coordinate: header and body scroll in different containers, and a
// misaligned column would write the tax into the payable amount while everything looks fine.
const GRID_JS = `
  const vis = ${VIS};
  const clean = (s) => String(s ?? '').replace(/设置/g, '').replace(/\\s+/g, ' ').trim();
  const norm = (v) => v.replace(/^\\./, '').replace(/\\s*\\*$/, '').trim();
  const pick = (which) => {
    const grids = [...document.querySelectorAll('.kd-grid-panel')].filter(vis);
    const grid = grids[which];
    if (!grid) return { grid: null, gridCount: grids.length };
    const headCells = [...grid.querySelectorAll('th,[class*=header-cell]')].filter(vis);
    const heads = headCells.map((n) => {
      const raw = clean(n.innerText);
      return { label: norm(raw), required: /\\*\\s*$/.test(raw) };
    });
    const headTr = headCells.length ? headCells[0].closest('tr') : null;
    const rows = [];
    for (const tr of [...grid.querySelectorAll('tr')].filter(vis)) {
      if (tr === headTr) continue;
      const tds = [...tr.children];
      if (tds.length !== heads.length) {
        rows.push({ misaligned: true, cellCount: tds.length, cls: tr.className });
        continue;
      }
      const values = {};
      const editValues = {};
      const nodes = {};
      tds.forEach((td, i) => {
        const label = heads[i].label;
        if (!label) return;
        nodes[label] = td;
        values[label] = clean(td.innerText);
        // An editing cell has empty innerText; its value sits on the input. Reported apart: text in an input
        // is not what ERP received.
        const inp = td.querySelector('input,textarea');
        if (inp && inp.value !== '') editValues[label] = String(inp.value);
      });
      if (!Object.values(values).some((v) => v !== '') && Object.keys(editValues).length === 0) continue;
      const b = tr.getBoundingClientRect();
      // The total row is recognised by class, not by a missing row number.
      const kind = /k-footer-template/.test(tr.className) ? 'total' : 'data';
      rows.push({ y: Math.round(b.y + b.height / 2), values, editValues, nodes, kind,
        editing: /k-grid-edit-row/.test(tr.className) });
    }
    return { grid, heads, rows, gridCount: grids.length };
  };
  // Grids are recognised by header label, not by position: an index is fail-open when the layout changes.
  const pickBy = (label) => {
    const grids = [...document.querySelectorAll('.kd-grid-panel')].filter(vis);
    const hits = [];
    grids.forEach((grid, i) => {
      const headCells = [...grid.querySelectorAll('th,[class*=header-cell]')].filter(vis);
      if (headCells.some((n) => norm(clean(n.innerText)) === label)) hits.push(i);
    });
    return hits;
  };
  const readPicked = (g) => {
    const bad = g.rows.filter((r) => r.misaligned);
    if (bad.length) return { ok: false, reason: '有 ' + bad.length + ' 行的单元格数量和表头列数对不上，不按错位的列读', columnCount: g.heads.length, bad };
    return { ok: true,
      columns: g.heads.map((h) => ({ label: h.label, required: h.required })),
      rowCount: g.rows.filter((r) => r.kind === 'data').length,
      rows: g.rows.map((r) => ({ y: r.y, kind: r.kind, editing: r.editing,
        values: r.values, editValues: r.editValues })) };
  };
`;

/** Read the grid whose header has `column` (receipts: 价税合计, detail: 申请报销金额). Zero or several hits: no answer. */
export async function readGridByColumn(session: CdpSession, column: string): Promise<Grid> {
  return evalIn(session, `(() => {
    ${GRID_JS}
    const label = ${JSON.stringify(column)};
    const hits = pickBy(label);
    if (hits.length === 0) return { ok: false, matchedGrids: 0, reason: '页面上没有哪个可见网格的表头有「' + label + '」列' };
    if (hits.length > 1) return { ok: false, matchedGrids: hits.length, reason: '有 ' + hits.length + ' 个可见网格的表头都有「' + label + '」列，认不出该读哪个' };
    const g = pick(hits[0]);
    if (!g.grid) return { ok: false, matchedGrids: 1, reason: '「' + label + '」所在的网格读不出来' };
    return { ...readPicked(g), matchedGrids: 1 };
  })()`);
}

/** Read the `which`-th visible grid (detail first, receipts second). Prefer readGridByColumn. */
export async function readGrid(session: CdpSession, which = 0): Promise<Grid> {
  return evalIn(session, `(() => {
    ${GRID_JS}
    const g = pick(${Number(which)});
    if (!g.grid) return { ok: false, reason: '页面上没有第 ${Number(which)} 个可见网格', gridCount: g.gridCount };
    return readPicked(g);
  })()`);
}

export type CellTarget = Partial<Reach> & {
  ok: boolean; reason?: string; column?: string; text: string; editValue?: string | null; editing?: boolean;
  focused?: boolean; focusTag?: string | null; editorBound?: boolean; x: number; y: number;
};

/** Scroll a cell into view (only before acting) and report its viewport position and editor state. */
export async function cellTarget(session: CdpSession, { which = 0, row = 0, column, scroll = true }: { which?: number; row?: number; column: string; scroll?: boolean }): Promise<CellTarget> {
  return evalIn(session, `(() => {
    ${GRID_JS}
    const g = pick(${Number(which)});
    if (!g.grid) return { ok: false, reason: '页面上没有第 ${Number(which)} 个可见网格', gridCount: g.gridCount };
    const bad = g.rows.filter((r) => r.misaligned);
    if (bad.length) return { ok: false, reason: '有 ' + bad.length + ' 行的单元格数量和表头列数对不上，不在错位的网格上写入', bad };
    const data = g.rows.filter((r) => r.kind === 'data');
    const r = data[${Number(row)}];
    if (!r) return { ok: false, reason: '这个网格里没有第 ${Number(row) + 1} 条明细', rowCount: data.length };
    const col = ${JSON.stringify(column)};
    const td = r.nodes[col];
    if (!td) return { ok: false, reason: '这个网格里没有「' + col + '」列', columns: Object.keys(r.nodes) };
    // Scroll once before acting: scrolling while an editor is open cancels the edit.
    if (${scroll ? 'true' : 'false'}) td.scrollIntoView({ inline: 'center', block: 'nearest' });
    const inp = td.querySelector('input,textarea');
    const a = document.activeElement;
    return { ok: true, column: col, text: clean(td.innerText),
      editValue: inp ? String(inp.value) : null, editing: r.editing,
      // Typing works only when focus sits on a real input control inside this cell.
      focused: !!(a && td.contains(a) && a !== td),
      focusTag: a && td.contains(a) ? a.tagName : null,
      editorBound: !!(a && td.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)),
      // Where to click it and what would be hit there: a 处理结果 or 提示 window floats over this grid with no
      // 遮罩, and a cell click that lands on the window leaves the cell unedited and says nothing.
      ...(${HIT_JS})(td) };
  })()`);
}

/** Wait until two consecutive reads of the grid are identical (linked recalculation has stopped). */
export async function settleGrid(session: CdpSession, which = 0, { quietMs = 900, maxMs = 9000 } = {}) {
  const snapshot = async () => {
    const g = await readGrid(session, which);
    return g.ok ? JSON.stringify(g.rows.map((r) => r.values)) : null;
  };
  const deadline = Date.now() + maxMs;
  let prev = await snapshot();
  while (Date.now() < deadline) {
    await sleep(quietMs);
    const now = await snapshot();
    if (now !== null && now === prev) return { settled: true };
    prev = now;
  }
  return { settled: false };
}

export type Expect = { mode: 'equals' | 'endsWith'; value: string } | null;

// Money reads back with a currency sign and grouping (`¥18.25`); F7 columns read back names, not codes. Only
// symbols are normalised; no numeric conversion.
const sameValue = (got: string, want: string) => {
  if (got === want) return true;
  const money = (t: string) => String(t).replace(/[¥￥,\s]/g, '');
  return /^[¥￥]?[\d,]+(\.\d+)?$/.test(String(got)) && money(got) === money(want);
};

/** Whether read-back text counts as written. F7 columns need an explicit expected read-back from the caller. */
export const cellMatches = (text: string, want: string, expect: Expect | undefined) => {
  if (!expect) return sameValue(text, want);
  return expect.mode === 'endsWith' ? String(text).endsWith(expect.value) : sameValue(text, expect.value);
};

/**
 * Empty the bound editor before typing into it, and prove it empty rather than assume it.
 *
 * Select-all is not enough, measured live 2026-09-20 on the 开始日期 (start date) editor of the 费用明细 grid.
 * That cell is a Kendo datepicker (`data-role="datepicker"`, `.k-widget.k-datepicker`) which the ERP opens
 * PRE-FILLED with today's date, and it ignores select-all however it is dispatched — `rawKeyDown` or `keyDown`,
 * with `commands: ['selectAll']` or a bare Meta+A: `selectionStart == selectionEnd == 9` before and after, every
 * time. So the typed date was APPENDED, and the datepicker parses the front of what it holds and ignores the
 * rest:
 *   typed 2026/9/1  into 2026/9/20 -> input "2026/9/202026/9/1" -> cell read back 2026/9/20 (today)
 *   typed 2026/9/3  into 2026/9/2  -> input "2026/9/22026/9/3"  -> cell read back 2026/9/22 (a date nobody asked for)
 * The first shape is what stopped the live fill of 2026-09-19 on `field_write_failed`; the second is worse,
 * because it would have passed a laxer read-back with the wrong date on the bill.
 *
 * Backspace does clear it — but only what is LEFT of the caret, and the caret lands where the click landed, not
 * at the end. Traced live on 结束日期, whose click put the caret at 8 of 9: `2026/9/20` went
 * `2026/9/0`, `2026/90`, ... , `20`, `0` and then stopped dead, because a Backspace at offset 0 does nothing.
 * That stranded `0` is what stopped the fill of 2026-09-20 one column further on than the round before it.
 * Delete takes what is right of the caret, and the two together empty the control from wherever the caret is:
 * measured on the same cell, `afterBackspaces="0"`, `afterDeletes=""`, and the typed date then committed and read
 * back. Both keys go to a bound editor and the grid keeps its rows (measured 1 -> 1 across the Deletes, including
 * Deletes sent to an already empty control — this is not a 删除行).
 *
 * The commit key was never the problem: with an empty control, `2026/9/6`, `2026-09-07` and `2026/09/08` all
 * committed faithfully on Enter AND on Tab, all read back as `YYYY/M/D`. Date columns need no commit of their
 * own — the CLEARING is what they need.
 *
 * Select-all stays first: it is measured to work on the other editors (费用金额 opens with its value already
 * selected, 事由 went 2..2 -> 0..2), and where it works one Backspace then empties the whole selection. An
 * editor already read as empty is left alone, which is every write into a blank cell.
 */
async function clearEditor(session: CdpSession, at: () => Promise<CellTarget>, ready: CellTarget,
  { rounds = 2 } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  await selectAll(session);
  let seen = String(ready.editValue ?? '');
  for (let round = 0; round < rounds && seen !== ''; round++) {
    // One more than the length each way: with a live selection the first Backspace takes all of it, and from any
    // caret position the two runs together cover the whole value. The extra keys land on an empty control.
    for (let i = 0; i < seen.length + 1; i++) await pressKey(session, 'Backspace');
    for (let i = 0; i < seen.length + 1; i++) await pressKey(session, 'Delete');
    const now = await at();
    if (!now.ok) return { ok: false, reason: `清空「${ready.column}」时读不到这一格：${now.reason ?? ''}` };
    seen = String(now.editValue ?? '');
  }
  return seen === '' ? { ok: true }
    : { ok: false, reason: `「${ready.column}」的编辑控件清不空（还剩「${seen}」），不往还有旧值的控件里打字` };
}

/**
 * Wait until the bound editor holds a settled value: two consecutive equal, non-empty readings.
 *
 * Kendo parses a keystroke into its own model asynchronously, and the commit key reads THAT model, not the DOM
 * input. Where the commit closes the whole edit row there is no second chance — the row shuts with the cell
 * empty. Two equal readings rather than one, so a value still being reformatted is not mistaken for a settled one.
 */
async function holdsValue(at: () => Promise<CellTarget>, ms: number, pollMs: number) {
  const deadline = Date.now() + ms;
  let prev: string | null = null;
  let seen = '';
  do {
    const now = await at();
    seen = now.ok ? String(now.editValue ?? '') : '';
    if (seen !== '' && seen === prev) return { ok: true as const, value: seen };
    prev = seen;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  return { ok: false as const, value: seen };
}

export type CellWrite = {
  which?: number; row?: number; column: string; value: string; expect?: Expect; commit?: 'Enter' | 'Tab';
  clicks?: number; readyMs?: number; settleMs?: number; holdMs?: number; typeTries?: number; settleFirst?: boolean; pace?: Pace;
};

/**
 * Write one detail cell: real click -> empty the editor -> type -> commit key -> read back.
 *
 * The read-back is of the CELL THIS JUST TYPED INTO, so it proves the value is in the DOM and nothing more. A
 * value that never reached ERP's own model reads back here as a success — measured live 2026-09-20, three of
 * eleven 费用明细行 whose 费用金额 and 税额 both read back correctly and whose ERP-computed 申请报销金额 was not
 * their sum. Where ERP computes something from what was written, that computed value is the witness:
 * `computedTotalProblem` in draft-flow.ts checks it row by row.
 */
export async function writeCell(session: CdpSession, write: CellWrite) {
  const first = await writeCellOnce(session, write);
  const dropped = !first.ok && 'after' in first && (first.after === '' || first.after === 'select');
  if (!LOOKUP_COLUMNS.has(write.column) || !dropped) return first;
  // A lookup cell still empty — or 「select」, its dropdown icon's text, the editor open and empty — once ERP has had
  // LOOKUP_READBACK_MS is written once more, from an emptied editor, but only after ERP's overlay is gone: live
  // 2026-10-20 a lookup resolved up to 6.2 s after its commit under that overlay, and a write into a lookup ERP is
  // still resolving races ERP's own work. Nothing is saved before 暂存, so a second write appends nothing.
  if (write.settleFirst !== false) await outwaitOverlay(session, write.pace ?? DEFAULT_PACE, LOOKUP_READBACK_MS);
  return writeCellOnce(session, write);
}

// The 选择类 (F7) columns ERP resolves from a typed code, and how long their read-back waits for the name: live
// 2026-10-20 20 writes resolved in 0.25-6.2 s (median 0.55 s), and first fills read 「」 back at 8 s on a slower ERP.
const LOOKUP_COLUMNS = new Set(['项目', '费用项目']);
const LOOKUP_READBACK_MS = 30_000;

async function writeCellOnce(session: CdpSession, { which = 0, row = 0, column, value, expect = null,
  commit = 'Enter', clicks = 3, readyMs = 9000, settleMs, holdMs = 2500, typeTries = 3, settleFirst = true,
  pace = DEFAULT_PACE }: CellWrite) {
  // How long the read-back waits for the committed value: a lookup's name comes from a server call.
  const readbackMs = settleMs ?? (LOOKUP_COLUMNS.has(column) ? LOOKUP_READBACK_MS : 8000);
  // Wait for the previous cell's recalculation first: a click during it is swallowed or its editor is taken away.
  // And for a lookup ERP is still resolving in the previous cell: 费用项目 is typed the moment 项目 commits.
  if (settleFirst) {
    await settleGrid(session, which, { quietMs: pace.quietMs, maxMs: pace.quietMs * 10 });
    await outwaitOverlay(session, pace, LOOKUP_READBACK_MS);
  }
  const at = () => cellTarget(session, { which, row, column, scroll: false });
  // Polled, not read once, as `selectOption` does: live 2026-10-20 a 去报销 stopped on 「「项目」的落点…上盖着DIV」
  // right after 新增行, while ERP was still re-rendering the grid. A cover still there at the end is refused below.
  const before = await waitFor(() => cellTarget(session, { which, row, column }), (c) => !c.ok || c.onTarget !== false, readyMs, pace.pollMs);
  if (!before.ok) return { ...before, ok: false, column };
  const blocked = reachProblem(`「${column}」`, before);
  if (blocked) return { ok: false, column, target: before, reason: blocked };
  // Retry only the focusing click (no side effect); re-locate before each retry because the page may have scrolled.
  let ready: CellTarget | null = null;
  let spot = before;
  let unreachable: string | null = null;
  for (let attempt = 0; attempt < clicks && !(ready && ready.editorBound); attempt++) {
    if (attempt > 0) {
      spot = await cellTarget(session, { which, row, column });
      if (!spot.ok) break;
    }
    // Re-measured every round, so a cell that has just been covered stops the loop instead of being clicked
    // again into whatever is now on top of it.
    unreachable = reachProblem(`「${column}」`, spot);
    if (unreachable) break;
    await clickReach(session, spot, `「${column}」`);
    ready = await waitFor(at, (c) => c.ok && c.editorBound === true, Math.ceil(readyMs / clicks), pace.pollMs);
  }
  if (!ready || !ready.ok || ready.editorBound !== true) {
    // Name what is in the way when something is: «the cell has no editor» sent a live round looking at the
    // control for hours while a floating window sat on the point.
    return { ok: false, column, wrote: String(value), before: before.text,
      reason: unreachable ?? `点了「${column}」之后这一格里没有绑好的编辑控件`
        + `（焦点在 ${ready?.focusTag ?? '别处'}），不往一个没绑好的控件里打字` };
  }

  const emptied = await clearEditor(session, at, ready);
  if (!emptied.ok) {
    return { ok: false, column, wrote: String(value), before: before.text, reason: emptied.reason };
  }
  // Do not commit on the heels of the last keystroke. Measured live 2026-09-20 on one 费用明细 row: the very same
  // keys, clicks and Enter lost 税额 every time from writeCell and committed every time by hand — the difference
  // was the pause. 税额's Enter closes the WHOLE edit row, so a commit that arrives before Kendo has taken the
  // last character shuts the row with the cell empty. 费用金额 survives the same race only because its Enter
  // leaves the row open. An editor that never reports a value is committed anyway (not every editor exposes one),
  // and `held` goes into the result so the next failure can be placed without another live round.
  // Nothing to witness when clearing (an empty editor never settles on a non-empty value), nor where the cell
  // exposes no editor value at all — `editValue` is null only when the cell holds no input to read.
  //
  // And where the witness reports the editor still EMPTY, type again rather than commit into nothing. Measured
  // live 2026-09-20 on a freshly added 费用明细 row: 项目 (a 选择类 F7 column, 原文 kdbosf7) reports a bound,
  // focused INPUT, the first `111705` lands nowhere at all, a second click and a second typing lands it, and the
  // ERP then resolves the code to the project name within a second. The ERP re-renders the F7 as it initialises
  // its data source, so the input that was bound a moment ago is no longer the one on the page. Only a COMPLETELY
  // empty editor is retyped: a partial value means the keys are arriving, and typing again would append to it
  // (measured: two runs into the same F7 leave 「111705111705」).
  const unwatched = String(value) === '' || ready.editValue == null;
  let held: { ok: boolean; value: string; watched: boolean } = { ok: true, value: String(ready.editValue ?? ''), watched: false };
  for (let attempt = 0; attempt < Math.max(1, typeTries); attempt++) {
    if (attempt > 0) {
      const again = await cellTarget(session, { which, row, column });
      if (!again.ok) break;
      await clickReach(session, again, `「${column}」`);
      const rebound = await waitFor(at, (c) => c.ok && c.editorBound === true, Math.ceil(readyMs / clicks), pace.pollMs);
      if (!rebound.ok || rebound.editorBound !== true) break;
    }
    await typeText(session, String(value));
    if (unwatched) break;
    held = { ...(await holdsValue(at, holdMs, pace.pollMs)), watched: true };
    if (held.ok || held.value !== '') break;
  }
  await pressKey(session, commit);

  const want = String(value);
  let after = await waitFor(at, (c) => c.ok && c.text !== '' && cellMatches(c.text, want, expect), readbackMs, pace.pollMs);
  // A numeric editor can remain focused after Enter even after ERP computes the
  // row total. Blur that same editor once, without typing again, then require
  // committed cell text as before. An input value alone never proves success.
  if (commit === 'Enter' && (column === '税额' || column === '费用金额')
    && after.ok && after.text === '' && after.editorBound === true && after.focused === true
    && after.editValue != null && cellMatches(after.editValue, want, expect)) {
    await pressKey(session, 'Tab');
    after = await waitFor(at, (c) => c.ok && c.text !== '' && cellMatches(c.text, want, expect), readbackMs, pace.pollMs);
  }
  const matched = after.ok && cellMatches(after.text, want, expect);
  return { ok: matched, column, wrote: want, expect, held,
    before: before.text, after: after.ok ? after.text : null,
    editValue: after.ok ? after.editValue : null,
    editing: after.ok ? after.editing : null, matched,
    reason: matched ? undefined
      : `写了「${want}」，「${column}」回读是「${after.ok ? after.text : '读不出'}」，`
        + `跟预期的「${expect ? expect.value : want}」对不上`
        + `（提交前编辑控件里是「${held.value}」${held.ok ? '' : '，且一直没稳住'}）` };
}

export type OptionSelect = { which?: number; row?: number; column: string; option: string; readyMs?: number; settleMs?: number; opens?: number; pace?: Pace };

/** Dropdown column (发票类型 invoice type): open, pick the exactly-equal item, read back. */
export async function selectOption(session: CdpSession, { which = 0, row = 0, column, option,
  readyMs = 6000, settleMs = 6000, opens = 3, pace = DEFAULT_PACE }: OptionSelect) {
  // Poll for the point, do not read it once. Live 2026-09-20 a 去报销 that had just written 项目 and 费用项目 into
  // row 1 stopped here on 「发票类型」的落点（x=629 y=843）上盖着DIV, and a read of that same point a minute later
  // answered the cell itself — an anonymous DIV had been over it for a moment while the row settled. A cell that
  // is momentarily covered is BUSY, not unreachable; `showSection` already outwaits the same kind of cover.
  // The refusal stays for a cover that is still there at the end, and still names what is in the way.
  const before = await waitFor(() => cellTarget(session, { which, row, column }),
    (c) => c.ok && c.onTarget === true, readyMs, pace.pollMs);
  if (!before.ok) return { ...before, ok: false, column };
  const blocked = reachProblem(`「${column}」`, before);
  if (blocked) return { ok: false, column, target: before, reason: blocked };

  // Items appear before the editor binds; a pick in that window is dropped silently. Wait on the condition.
  // The items are hit-tested too: the dropdown is painted at the top of the stack, but so is a 处理结果 window,
  // and picking the wrong 发票类型 is a value nobody asked for written onto the bill.
  const listItems = () => evalIn<Array<Reach & { text: string }>>(session, `(() => {
    const vis = ${VIS};
    const at = ${HIT_JS};
    return [...document.querySelectorAll('ul[class*=k-list] li, li[role=option]')].filter(vis)
      .map((n) => ({ text: n.innerText.replace(/\\s+/g, ' ').trim(), ...at(n) }));
  })()`);
  // The WANTED item's own point is part of the condition, not something read once afterwards. Live 2026-09-20 a
  // 去报销 that had written five 费用明细行 in full stopped here on 「发票类型」候选项「普通发票」的落点（x=629
  // y=697）上盖着DIV: the list had just been painted, and the first read of its item answered the thing still on
  // top of it. The cell was already polled; the item was not, so the one read that decided was the earliest one.
  const probe = async () => ({ items: await listItems(), cell: await cellTarget(session, { which, row, column, scroll: false }) });
  const itemReady = (p: { items: Array<Reach & { text: string }>; cell: CellTarget }) => {
    // The row being in edit is the guard here, not focus on the cell: measured live 2026-09-20, while 发票类型's
    // list is up the cell reports `focused: false` and no focus tag at all — focus has gone to the list. Requiring
    // focus on the cell made an open, readable dropdown look like one that had not opened yet.
    if (!(p.items.length > 0 && p.cell.ok && (p.cell.focused === true || p.cell.editing === true))) return false;
    const wanted = p.items.filter((i) => i.text === option);
    // Zero or several is a refusal, not something waiting will mend: stop and let the caller say which it was.
    return wanted.length !== 1 || wanted[0]!.onTarget === true;
  };
  // ONE CLICK DOES NOT OPEN THIS DROPDOWN. Measured live 2026-09-20 on 发票类型 of a freshly added 费用明细行:
  // the first click puts the cell into edit and leaves the list closed (`aria-expanded="false"`), the second
  // opens it — six candidates, 普通发票 among them, exactly as this function's own selector reads them — and
  // every further click toggles it again. A single click therefore found no candidates at all and the whole
  // 去报销 stopped on 「发票类型」的候选项里没有完全等于「普通发票」的一项, over a list that was never open.
  //
  // So the click is repeated only while NOTHING is showing. Never while items are up: that would toggle shut the
  // very list being waited for.
  let seen = { items: [] as Array<Reach & { text: string }>, cell: before };
  for (let attempt = 0; attempt < Math.max(1, opens); attempt++) {
    const spot = attempt === 0 ? before
      : await waitFor(() => cellTarget(session, { which, row, column }), (c) => c.ok && c.onTarget === true, readyMs, pace.pollMs);
    if (!spot.ok) break;
    const shut = reachProblem(`「${column}」`, spot);
    if (shut) return { ok: false, column, target: spot, reason: shut };
    await clickReach(session, spot, `「${column}」`);
    seen = await waitFor(probe, itemReady, Math.ceil(readyMs / Math.max(1, opens)), pace.pollMs);
    if (seen.items.length > 0) break;
  }
  const items = seen.items;
  const ready = seen.items.length > 0 && seen.cell.ok && (seen.cell.focused === true || seen.cell.editing === true);

  const hit = items.filter((i) => i.text === option);
  if (hit.length !== 1) {
    // Close what was opened; an open dropdown would disturb the next step.
    await pressKey(session, 'Escape');
    return { ok: false, column, wrote: option, ready, options: items.map((i) => i.text),
      reason: hit.length === 0
        ? `「${column}」的候选项里没有完全等于「${option}」的一项`
        : `「${column}」里有 ${hit.length} 项都叫「${option}」，选哪个都是猜` };
  }
  const unreachable = reachProblem(`「${column}」候选项「${option}」`, hit[0]);
  if (unreachable) {
    await pressKey(session, 'Escape');
    return { ok: false, column, wrote: option, ready, options: items.map((i) => i.text), reason: unreachable };
  }
  await clickReach(session, hit[0]!, `「${column}」候选项「${option}」`);

  const after = await waitFor(() => cellTarget(session, { which, row, column, scroll: false }), (c) => c.ok && c.text === option, settleMs, pace.pollMs);
  const matched = after.ok && after.text === option;
  return { ok: matched, column, wrote: option, ready,
    before: before.text, after: after.ok ? after.text : null,
    options: items.map((i) => i.text), matched,
    reason: matched ? undefined : `点中了「${option}」，但单元格回读仍然是「${after.ok ? after.text : '读不出'}」` };
}

/**
 * Leave edit mode before the final read-back; clicking a section anchor is the lightest blur available.
 *
 * The leaving is WAITED for, not read once. The grid keeps `k-grid-edit-row` on the row for its own next render
 * or two after taking the value, and a single read taken right after the click turns that render into
 * `leave_edit_failed` — the same read-too-early that `addDetailRow` was returning `{ok:true}` over. The refusal
 * stays for a row that is still in edit at the end of the wait.
 */
export async function leaveEdit(session: CdpSession, { label = '明细信息', settleMs = 1200, editMs = 8000, pace = DEFAULT_PACE }: { label?: string; settleMs?: number; editMs?: number; pace?: Pace } = {}) {
  const shown = await showSection(session, label, { settleMs, pace });
  if (!shown.ok) return shown;
  const editing = (grid: Grid) => (grid.ok ? grid.rows.some((r) => r.editing) : null);
  const grid = await waitFor(() => readGrid(session, 0), (g) => editing(g) === false, editMs, pace.pollMs);
  return { ok: true as const, stillEditing: editing(grid) };
}

/**
 * A header field, id `<form-instance UUID>-<key>[-EDITOR]`. The rule that finds it is `header-locator.ts`, shared
 * with the read-only path so the two can no longer disagree about the same node. `scroll` is for writes only.
 */
export async function headerField(session: CdpSession, key: string, { scroll = true } = {}): Promise<HeaderField> {
  return evalIn(session, headerFieldSnippet(key, { scroll }));
}

/** Write a header field, committed with Tab: the purpose must really blur to pass the save check. */
export async function writeHeader(session: CdpSession, key: string, value: string, { readyMs = 4000, settleMs = 600, pace = DEFAULT_PACE }: { readyMs?: number; settleMs?: number; pace?: Pace } = {}) {
  const before = await headerField(session, key);
  if (!before.ok) return { ...before, ok: false, key };
  // Refuse BEFORE the click, naming what is at the point. This is the defect V-54 cost a whole live round: the
  // 处理结果 window floated over 事由 at z-index 10005, the click went to a SPAN「接收发票」 inside the report,
  // focus never arrived, and the message blamed the control — so the next four hours were spent on the control.
  const blocked = reachProblem(`表头字段 ${key}`, before);
  if (blocked) return { ok: false, key, target: before, reason: blocked };
  await clickReach(session, before, `表头字段 ${key}`);
  const ready = await waitFor(() => headerField(session, key), (c) => c.ok && c.focused === true, readyMs, pace.pollMs);
  if (!ready.ok || ready.focused !== true) {
    // The point was reachable a moment ago; if something has landed on it since, say so rather than the control.
    return { ok: false, key, wrote: String(value), before: before.value, after: null,
      reason: reachProblem(`表头字段 ${key}`, ready)
        ?? `点了表头字段 ${key} 之后焦点没有落进这个控件，不往一个没拿到焦点的控件里打字` };
  }
  await selectAll(session);
  await typeText(session, String(value));
  await pressKey(session, 'Tab');
  await sleep(settleMs);
  const after = await headerField(session, key);
  const matched = after.ok && after.value === String(value);
  return { ok: matched, key, wrote: String(value),
    before: before.value, after: after.ok ? after.value : null, matched,
    reason: matched ? undefined : `写了「${value}」，表头 ${key} 回读是「${after.ok ? after.value : '读不出'}」` };
}
