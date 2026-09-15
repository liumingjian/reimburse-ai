// Origin: kernel/src/erpform.mjs (CDP form primitives of the 费用报销单 expense reimbursement form).
//
// Facts measured on K3Cloud 8.2.0 (2026-09-05) that shape this module:
//   1. Detail grid cells carry no field key, so grids are located and read by header label only.
//   2. The grid scrolls horizontally. Cell text stays in the DOM, so reads never scroll; writes must scroll the
//      target column into view first, because real mouse events hit viewport coordinates.
//   3. Kingdee controls ignore programmatic assignment ("visible while editing, lost on blur"). The only write
//      path is: real click into edit mode -> select all -> type key by key -> Enter/Tab.
// Every write is read back at once from the non-editing cell text: written and received by ERP are different.
// This module never saves.

import { clickAt, evalIn, pressKey, selectAll, typeText, type CdpSession } from './cdp';
import { sleep, waitFor, type Pace, DEFAULT_PACE } from './pace';

const SECTIONS = ['基本信息', '付款信息', '明细信息', '收票信息'];

const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;

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
      if (/^费用报销单-(新增|修改)$/.test(t)) {
        const b = n.getBoundingClientRect();
        tabs.push({ label: t, mode: t.endsWith('修改') ? 'modify' : 'new',
          x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
      }
    }
    return tabs;
  })()`);
}

/** Section anchors (基本信息/付款信息/明细信息/收票信息) on the top navigation bar. */
export async function sectionAnchors(session: CdpSession): Promise<Array<{ label: string; x: number; y: number }>> {
  return evalIn(session, `(() => {
    const vis = ${VIS};
    const want = ${JSON.stringify(SECTIONS)};
    const out = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const t = n.textContent.trim();
      if (!want.includes(t)) continue;
      const b = n.getBoundingClientRect();
      // Anchors sit on the top bar; a same-named heading in the body is not one.
      if (b.y > 260) continue;
      out.push({ label: t, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    }
    return out;
  })()`);
}

/** Render a section. 明细信息 renders lazily; clicking its anchor is in-page navigation and changes no value. */
export async function showSection(session: CdpSession, label: string, { settleMs = 2500 } = {}) {
  const anchors = await sectionAnchors(session);
  const anchor = anchors.find((a) => a.label === label);
  if (!anchor) return { ok: false as const, reason: `页面上找不到「${label}」区域锚点`, anchors };
  await clickAt(session, anchor.x, anchor.y);
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

export type CellTarget = {
  ok: boolean; reason?: string; column?: string; text: string; editValue?: string | null; editing?: boolean;
  focused?: boolean; focusTag?: string | null; editorBound?: boolean; x: number; y: number; inView?: boolean;
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
    const b = td.getBoundingClientRect();
    const inp = td.querySelector('input,textarea');
    const a = document.activeElement;
    return { ok: true, column: col, text: clean(td.innerText),
      editValue: inp ? String(inp.value) : null, editing: r.editing,
      // Typing works only when focus sits on a real input control inside this cell.
      focused: !!(a && td.contains(a) && a !== td),
      focusTag: a && td.contains(a) ? a.tagName : null,
      editorBound: !!(a && td.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)),
      x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
      inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
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

export type CellWrite = {
  which?: number; row?: number; column: string; value: string; expect?: Expect; commit?: 'Enter' | 'Tab';
  clicks?: number; readyMs?: number; settleMs?: number; settleFirst?: boolean; pace?: Pace;
};

/** Write one detail cell: real click -> select all -> type -> commit key -> read back. */
export async function writeCell(session: CdpSession, { which = 0, row = 0, column, value, expect = null,
  commit = 'Enter', clicks = 3, readyMs = 9000, settleMs = 8000, settleFirst = true, pace = DEFAULT_PACE }: CellWrite) {
  // Wait for the previous cell's recalculation first: a click during it is swallowed or its editor is taken away.
  if (settleFirst) await settleGrid(session, which, { quietMs: pace.quietMs, maxMs: pace.quietMs * 10 });
  const at = () => cellTarget(session, { which, row, column, scroll: false });
  const before = await cellTarget(session, { which, row, column });
  if (!before.ok) return { ...before, ok: false, column };
  if (!before.inView) {
    return { ok: false, column, target: before,
      reason: `「${column}」滚动之后仍然不在视口里（x=${before.x} y=${before.y}）；不在看不见的地方点击` };
  }
  // Retry only the focusing click (no side effect); re-locate before each retry because the page may have scrolled.
  let ready: CellTarget | null = null;
  let spot = before;
  for (let attempt = 0; attempt < clicks && !(ready && ready.editorBound); attempt++) {
    if (attempt > 0) {
      spot = await cellTarget(session, { which, row, column });
      if (!spot.ok || !spot.inView) break;
    }
    await clickAt(session, spot.x, spot.y);
    ready = await waitFor(at, (c) => c.ok && c.editorBound === true, Math.ceil(readyMs / clicks), pace.pollMs);
  }
  if (!ready || !ready.ok || ready.editorBound !== true) {
    return { ok: false, column, wrote: String(value), before: before.text,
      reason: `点了「${column}」之后这一格里没有绑好的编辑控件`
        + `（焦点在 ${ready?.focusTag ?? '别处'}），不往一个没绑好的控件里打字` };
  }

  await selectAll(session);
  await typeText(session, String(value));
  await pressKey(session, commit);

  const want = String(value);
  const after = await waitFor(at, (c) => c.ok && c.text !== '' && cellMatches(c.text, want, expect), settleMs, pace.pollMs);
  const matched = after.ok && cellMatches(after.text, want, expect);
  return { ok: matched, column, wrote: want, expect,
    before: before.text, after: after.ok ? after.text : null,
    editValue: after.ok ? after.editValue : null,
    editing: after.ok ? after.editing : null, matched,
    reason: matched ? undefined
      : `写了「${want}」，「${column}」回读是「${after.ok ? after.text : '读不出'}」，`
        + `跟预期的「${expect ? expect.value : want}」对不上` };
}

export type OptionSelect = { which?: number; row?: number; column: string; option: string; readyMs?: number; settleMs?: number; pace?: Pace };

/** Dropdown column (发票类型 invoice type): open, pick the exactly-equal item, read back. */
export async function selectOption(session: CdpSession, { which = 0, row = 0, column, option,
  readyMs = 6000, settleMs = 6000, pace = DEFAULT_PACE }: OptionSelect) {
  const before = await cellTarget(session, { which, row, column });
  if (!before.ok) return { ...before, ok: false, column };
  if (!before.inView) {
    return { ok: false, column, target: before, reason: `「${column}」滚动之后仍然不在视口里；不在看不见的地方点击` };
  }
  await clickAt(session, before.x, before.y);

  // Items appear before the editor binds; a pick in that window is dropped silently. Wait on the condition.
  const listItems = () => evalIn<Array<{ text: string; x: number; y: number }>>(session, `(() => {
    const vis = ${VIS};
    return [...document.querySelectorAll('ul[class*=k-list] li, li[role=option]')].filter(vis)
      .map((n) => { const b = n.getBoundingClientRect();
        return { text: n.innerText.replace(/\\s+/g, ' ').trim(),
          x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
  })()`);
  const probe = async () => ({ items: await listItems(), cell: await cellTarget(session, { which, row, column, scroll: false }) });
  const seen = await waitFor(probe, (p) => p.items.length > 0 && p.cell.ok && p.cell.focused === true, readyMs, pace.pollMs);
  const items = seen.items;
  const ready = seen.items.length > 0 && seen.cell.ok && seen.cell.focused === true;

  const hit = items.filter((i) => i.text === option);
  if (hit.length !== 1) {
    // Close what was opened; an open dropdown would disturb the next step.
    await pressKey(session, 'Escape');
    return { ok: false, column, wrote: option, ready, options: items.map((i) => i.text),
      reason: hit.length === 0
        ? `「${column}」的候选项里没有完全等于「${option}」的一项`
        : `「${column}」里有 ${hit.length} 项都叫「${option}」，选哪个都是猜` };
  }
  await clickAt(session, hit[0]!.x, hit[0]!.y);

  const after = await waitFor(() => cellTarget(session, { which, row, column, scroll: false }), (c) => c.ok && c.text === option, settleMs, pace.pollMs);
  const matched = after.ok && after.text === option;
  return { ok: matched, column, wrote: option, ready,
    before: before.text, after: after.ok ? after.text : null,
    options: items.map((i) => i.text), matched,
    reason: matched ? undefined : `点中了「${option}」，但单元格回读仍然是「${after.ok ? after.text : '读不出'}」` };
}

/** Leave edit mode before the final read-back; clicking a section anchor is the lightest blur available. */
export async function leaveEdit(session: CdpSession, { label = '明细信息', settleMs = 1200 } = {}) {
  const shown = await showSection(session, label, { settleMs });
  if (!shown.ok) return shown;
  const grid = await readGrid(session, 0);
  return { ok: true as const, stillEditing: grid.ok ? grid.rows.some((r) => r.editing) : null };
}

export type HeaderField = {
  ok: boolean; reason?: string; id?: string; tag?: string; instances?: number; visibleInstances?: number;
  focused?: boolean; value: string; x: number; y: number; inView?: boolean;
};

/**
 * A header field, id `<form-instance UUID>-<key>[-EDITOR]`, found by suffix. Exactly one visible instance is
 * accepted: zero would fall back to a stale hidden form, several would be a guess. `scroll` is for writes only.
 */
export async function headerField(session: CdpSession, key: string, { scroll = true } = {}): Promise<HeaderField> {
  return evalIn(session, `(() => {
    const key = ${JSON.stringify(key)};
    const all = [...document.querySelectorAll('[id]')]
      .filter((n) => n.id.endsWith('-' + key) || n.id.endsWith('-' + key + '-EDITOR'));
    if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
    const showing = (x) => {
      const b = x.getBoundingClientRect();
      const st = getComputedStyle(x);
      return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const visible = all.filter(showing);
    if (visible.length === 0) {
      return { ok: false, reason: '表头字段 ' + key + ' 没有可见实例', instances: all.length, visibleInstances: 0 };
    }
    if (visible.length > 1) {
      return { ok: false, reason: '表头字段 ' + key + ' 有 ' + visible.length + ' 个可见实例，认不出是哪一张单的',
        instances: all.length, visibleInstances: visible.length };
    }
    const hit = visible;
    const n = hit.find((x) => x.id.endsWith('-EDITOR')) || hit[0];
    if (${scroll ? 'true' : 'false'}) n.scrollIntoView({ block: 'center', inline: 'nearest' });
    const input = n.matches('input,textarea') ? n : n.querySelector('input,textarea');
    const t = input || n;
    const b = t.getBoundingClientRect();
    const a = document.activeElement;
    return { ok: true, id: n.id, tag: t.tagName, instances: all.length, visibleInstances: visible.length,
      focused: a === t || (n.contains(a) && a !== n),
      value: (input ? input.value : n.innerText).replace(/\\s+/g, ' ').trim(),
      x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
      inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
  })()`);
}

/** Write a header field, committed with Tab: the purpose must really blur to pass the save check. */
export async function writeHeader(session: CdpSession, key: string, value: string, { readyMs = 4000, settleMs = 600, pace = DEFAULT_PACE }: { readyMs?: number; settleMs?: number; pace?: Pace } = {}) {
  const before = await headerField(session, key);
  if (!before.ok) return { ...before, ok: false, key };
  if (!before.inView) {
    return { ok: false, key, target: before, reason: `表头字段 ${key} 滚动之后仍然不在视口里（x=${before.x} y=${before.y}）` };
  }
  await clickAt(session, before.x, before.y);
  const ready = await waitFor(() => headerField(session, key), (c) => c.ok && c.focused === true, readyMs, pace.pollMs);
  if (!ready.ok || ready.focused !== true) {
    return { ok: false, key, wrote: String(value), before: before.value, after: null,
      reason: `点了表头字段 ${key} 之后焦点没有落进这个控件，不往一个没拿到焦点的控件里打字` };
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
