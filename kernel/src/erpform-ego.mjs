import { evaluateEgoPage, isEgoPage, runEgoScript } from './ego.mjs';
import { readFormTabs, readSectionAnchors } from './erpread.mjs';

// ERP 草稿字段的 ego-only 写入适配。这个文件不导入 chrome.mjs 或 erpform.mjs，
// 也不包含保存、导入、删除或其它单据副作用。每个字段都按“定位 -> 滚入视口 ->
// 真点击 -> 等真实编辑控件 -> 全选逐键输入 -> 提交 -> 非编辑态回读”执行。

const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;

const egoPageRequired = () => {
  const error = new Error('ERP 写入字段需要 ego task-space page context；旧 Chrome/CDP 页面句柄已阻塞');
  error.code = 'EGO_PAGE_REQUIRED';
  return error;
};

const assertPage = (page, evaluate) => {
  if (page?.transport !== 'ego' || page?.taskSpace === null || page?.taskSpace === undefined
      || !page?.tabId) throw egoPageRequired();
  if (evaluate === evaluateEgoPage && !isEgoPage(page)) throw egoPageRequired();
};

const evaluatePage = (page, expression, deps = {}) => {
  const evaluate = deps.evaluate ?? evaluateEgoPage;
  assertPage(page, evaluate);
  return evaluate(page, expression, { timeoutMs: deps.timeoutMs ?? 15_000 });
};

const selectedTabScript = (page, action) => `
const tabs = await listTabs();
const tab = tabs.find((candidate) => (candidate.targetId ?? candidate.id) === ${JSON.stringify(page.tabId)});
if (!tab) throw new Error('ego task space 中找不到目标页面');
await switchTab(tab.targetId ?? tab.id);
${action}
`;

const actionRun = (page, action, deps = {}) => {
  if (page?.transport !== 'ego' || page?.taskSpace === null || page?.taskSpace === undefined
      || !page?.tabId) throw egoPageRequired();
  // A supplied runner is the test seam; production uses runEgoScript, which
  // performs the configured task-space ownership check before spawning ego.
  if (!deps.run && !isEgoPage(page)) throw egoPageRequired();
  return (deps.run ?? runEgoScript)(selectedTabScript(page, action));
};

export const clickEgo = (page, x, y, deps = {}) => actionRun(page,
  `await click([${Number(x)}, ${Number(y)}]);\nreturn true;`, deps);

export const typeEgo = (page, value, deps = {}) => actionRun(page,
  `await typeText(${JSON.stringify(String(value))});\nreturn true;`, deps);

export const pressEgo = (page, key, deps = {}) => actionRun(page,
  `await pressKey(${JSON.stringify(String(key))});\nreturn true;`, deps);

/**
 * ERP editors only honor this replacement command through the input event
 * protocol; a modifier-only pressKey can leave the old value selected nowhere.
 */
export const selectAllEgo = (page, deps = {}) => {
  const modifier = process.platform === 'darwin' ? 4 : 2;
  const body = "await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: " + modifier + ", commands: ['selectAll'] }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: " + modifier + " }); return true;";
  return actionRun(page, body, deps);
};

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
        const inp = td.querySelector('input,textarea');
        if (inp && inp.value !== '') editValues[label] = String(inp.value);
      });
      if (!Object.values(values).some((v) => v !== '') && Object.keys(editValues).length === 0) continue;
      const b = tr.getBoundingClientRect();
      rows.push({ y: Math.round(b.y + b.height / 2), values, editValues, nodes,
        kind: /k-footer-template/.test(tr.className) ? 'total' : 'data',
        editing: /k-grid-edit-row/.test(tr.className) });
    }
    return { grid, heads, rows, gridCount: grids.length };
  };
`;

const gridExpression = (which, { scroll = false, row = 0, column = null } = {}) => `(() => {
  ${GRID_JS}
  const g = pick(${Number(which)});
  if (!g.grid) return { ok: false, reason: '页面上没有第 ${Number(which) + 1} 个可见网格', gridCount: g.gridCount };
  const bad = g.rows.filter((r) => r.misaligned);
  if (bad.length) return { ok: false,
    reason: '有 ' + bad.length + ' 行的单元格数量和表头列数对不上，不按错位的列写入', bad };
  ${column === null ? `return { ok: true,
    columns: g.heads.map((h) => ({ label: h.label, required: h.required })),
    rowCount: g.rows.filter((r) => r.kind === 'data').length,
    rows: g.rows.map((r) => ({ y: r.y, kind: r.kind, editing: r.editing,
      values: r.values, editValues: r.editValues })) };` : `
  const data = g.rows.filter((r) => r.kind === 'data');
  const r = data[${Number(row)}];
  if (!r) return { ok: false, reason: '这个网格里没有第 ${Number(row) + 1} 条明细', rowCount: data.length };
  const col = ${JSON.stringify(column)};
  const td = r.nodes[col];
  if (!td) return { ok: false, reason: '这个网格里没有「' + col + '」列', columns: Object.keys(r.nodes) };
  if (${scroll ? 'true' : 'false'}) td.scrollIntoView({ inline: 'center', block: 'nearest' });
  const b = td.getBoundingClientRect();
  const input = td.querySelector('input,textarea');
  const active = document.activeElement;
  return { ok: true, column: col, text: clean(td.innerText),
    editValue: input ? String(input.value) : null, editing: r.editing,
    focused: !!(active && td.contains(active) && active !== td),
    focusTag: active && td.contains(active) ? active.tagName : null,
    editorBound: !!(active && td.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)),
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
    inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };`}
})()`;

export async function formTabs(page, deps = {}) {
  return readFormTabs(page, deps);
}

export async function sectionAnchors(page, deps = {}) {
  return readSectionAnchors(page, deps);
}

export async function readGrid(page, which = 0, deps = {}) {
  return evaluatePage(page, gridExpression(which), deps);
}

export async function cellTarget(page, { which = 0, row = 0, column, scroll = true } = {}, deps = {}) {
  if (typeof column !== 'string' || !column.trim()) throw new TypeError('grid column must be a non-empty string');
  return evaluatePage(page, gridExpression(which, { scroll, row, column }), deps);
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, predicate, maxMs, sleep = sleepDefault) => {
  const deadline = Date.now() + maxMs;
  let last = await probe();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
    last = await probe();
  }
  return last;
};

export async function settleGrid(page, which = 0, { quietMs = 900, maxMs = 9000 } = {}, deps = {}) {
  const snapshot = async () => {
    const grid = await readGrid(page, which, deps);
    return grid.ok ? JSON.stringify(grid.rows.map((row) => row.values)) : null;
  };
  const sleep = deps.sleep ?? sleepDefault;
  const deadline = Date.now() + maxMs;
  let previous = await snapshot();
  while (Date.now() < deadline) {
    await sleep(quietMs);
    const current = await snapshot();
    if (current !== null && current === previous) return { settled: true };
    previous = current;
  }
  return { settled: false };
}

const actionsOf = (deps) => ({
  click: deps.click ?? ((page, x, y) => clickEgo(page, x, y, deps)),
  type: deps.type ?? ((page, value) => typeEgo(page, value, deps)),
  press: deps.press ?? ((page, key) => pressEgo(page, key, deps)),
  selectAll: deps.selectAll ?? ((page) => selectAllEgo(page, deps)),
  sleep: deps.sleep ?? sleepDefault,
});

/** Compare a field with its exact expected business value. Project names never use suffix matching. */
export const cellMatches = (got, wrote, expect = null) => {
  const normalizeMoney = (value) => String(value).replace(/[¥￥,\s]/g, '');
  const sameValue = (left, right) => left === right
    || (/^[¥￥]?[\d,]+(?:\.\d+)?$/.test(String(left))
      && normalizeMoney(left) === normalizeMoney(right));
  if (!expect) return sameValue(got, wrote);
  if (expect.mode !== 'equals' || typeof expect.value !== 'string') return false;
  return sameValue(got, expect.value);
};

export async function writeCell(page, {
  which = 0, row = 0, column, value, expect = null, commit = 'Enter', clicks = 3,
  readyMs = 9000, settleMs = 8000, settleFirst = true,
} = {}, deps = {}) {
  const actions = actionsOf(deps);
  if (settleFirst) await settleGrid(page, which, {}, deps);
  const probe = (scroll = false) => cellTarget(page, { which, row, column, scroll }, deps);
  const before = await probe(true);
  if (!before.ok) return { ok: false, column, ...before };
  if (!before.inView) return { ok: false, column, target: before,
    reason: `「${column}」滚动之后仍然不在视口里（x=${before.x} y=${before.y}）` };

  let ready = null;
  let spot = before;
  for (let attempt = 0; attempt < clicks && !(ready?.editorBound); attempt += 1) {
    if (attempt > 0) {
      spot = await probe(true);
      if (!spot.ok || !spot.inView) break;
    }
    await actions.click(page, spot.x, spot.y);
    ready = await waitFor(() => probe(false), (candidate) => candidate.ok && candidate.editorBound === true,
      Math.ceil(readyMs / Math.max(1, clicks)), actions.sleep);
  }
  if (!ready?.ok || ready.editorBound !== true) {
    return { ok: false, column, wrote: String(value), before: before.text,
      reason: `点了「${column}」之后没有绑好的真实编辑控件（焦点在 ${ready?.focusTag ?? '别处'}）` };
  }

  await actions.selectAll(page);
  await actions.type(page, String(value));
  await actions.press(page, commit);
  const after = await waitFor(() => probe(false),
    (candidate) => candidate.ok && candidate.text !== '' && cellMatches(candidate.text, String(value), expect),
    settleMs, actions.sleep);
  const matched = after?.ok === true && cellMatches(after.text, String(value), expect);
  return { ok: matched, column, wrote: String(value), expect, before: before.text,
    after: after?.ok ? after.text : null, editValue: after?.ok ? after.editValue : null,
    editing: after?.ok ? after.editing : null, matched,
    reason: matched ? undefined : `写入「${value}」后「${column}」回读不符合精确预期` };
}

const headerExpression = (key, scroll) => `(() => {
  const key = ${JSON.stringify(key)};
  const all = [...document.querySelectorAll('[id]')]
    .filter((node) => node.id.endsWith('-' + key) || node.id.endsWith('-' + key + '-EDITOR'));
  if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
  const visible = all.filter((node) => {
    const b = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return b.width > 0 && b.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  if (visible.length === 0) return { ok: false, reason: '表头字段 ' + key + ' 没有可见实例', visibleInstances: 0 };
  const fieldSuffix = '-' + key;
  const editorSuffix = fieldSuffix + '-EDITOR';
  const instanceOf = (node) => node.id.endsWith(editorSuffix)
    ? node.id.slice(0, -editorSuffix.length) : node.id.slice(0, -fieldSuffix.length);
  const groups = new Map();
  for (const node of visible) {
    const group = groups.get(instanceOf(node)) ?? [];
    group.push(node);
    groups.set(instanceOf(node), group);
  }
  if (groups.size !== 1) return { ok: false,
    reason: '表头字段 ' + key + ' 有 ' + groups.size + ' 个可见表单实例，拒绝猜测',
    visibleInstances: groups.size };
  const group = groups.values().next().value;
  const editors = group.filter((node) => node.id.endsWith(editorSuffix));
  if (editors.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的可见编辑控件不唯一，拒绝猜测', visibleInstances: groups.size };
  const editor = editors[0] ?? group[0];
  const inputs = editor.matches('input,textarea') ? [editor] : [...editor.querySelectorAll('input,textarea')];
  if (inputs.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的可见输入控件不唯一，拒绝猜测', visibleInstances: groups.size };
  const input = inputs[0] ?? null;
  const target = input ?? editor;
  if (${scroll ? 'true' : 'false'}) target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const b = target.getBoundingClientRect();
  const active = document.activeElement;
  return { ok: true, id: editor.id, tag: target.tagName, visibleInstances: groups.size,
    focused: active === target || (editor.contains(active) && active !== editor),
    value: String(input ? input.value : editor.innerText).replace(/\\s+/g, ' ').trim(),
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
    inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
})()`;

export async function headerField(page, key, { scroll = true } = {}, deps = {}) {
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('header field key must be non-empty');
  return evaluatePage(page, headerExpression(key, scroll), deps);
}

export async function writeHeader(page, key, value, { readyMs = 4000, settleMs = 600 } = {}, deps = {}) {
  const actions = actionsOf(deps);
  const before = await headerField(page, key, { scroll: true }, deps);
  if (!before.ok) return { ok: false, key, ...before };
  if (!before.inView) return { ok: false, key, target: before,
    reason: `表头字段 ${key} 滚动后仍然不在视口里` };
  await actions.click(page, before.x, before.y);
  const ready = await waitFor(() => headerField(page, key, { scroll: false }, deps),
    (candidate) => candidate.ok && candidate.focused === true, readyMs, actions.sleep);
  if (!ready?.ok || ready.focused !== true) {
    return { ok: false, key, wrote: String(value), before: before.value,
      reason: `点了表头字段 ${key} 之后焦点没有落进真实控件` };
  }
  await actions.selectAll(page);
  await actions.type(page, String(value));
  // FCAUSA 必须真实失焦，Enter 不作为表头提交信号。
  await actions.press(page, 'Tab');
  await actions.sleep(settleMs);
  const after = await headerField(page, key, { scroll: false }, deps);
  const matched = after.ok && after.value === String(value);
  return { ok: matched, key, wrote: String(value), before: before.value,
    after: after.ok ? after.value : null, matched,
    reason: matched ? undefined : `表头 ${key} 回读与写入值不一致` };
}

export async function selectOption(page, {
  which = 0, row = 0, column, option, readyMs = 6000, settleMs = 6000,
} = {}, deps = {}) {
  const actions = actionsOf(deps);
  const before = await cellTarget(page, { which, row, column, scroll: true }, deps);
  if (!before.ok) return { ok: false, column, ...before };
  if (!before.inView) return { ok: false, column, target: before, reason: `「${column}」不在视口里` };
  await actions.click(page, before.x, before.y);
  const listExpression = `(() => {
    const vis = ${VIS};
    return [...document.querySelectorAll('ul[class*=k-list] li, li[role=option]')].filter(vis)
      .map((node) => { const b = node.getBoundingClientRect();
        return { text: String(node.innerText).replace(/\\s+/g, ' ').trim(),
          x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
  })()`;
  const probe = async () => ({ items: await evaluatePage(page, listExpression, deps),
    cell: await cellTarget(page, { which, row, column, scroll: false }, deps) });
  const seen = await waitFor(probe, (candidate) => candidate.items.length > 0
    && candidate.cell.ok && candidate.cell.focused === true, readyMs, actions.sleep);
  const hit = seen.items.filter((item) => item.text === option);
  if (hit.length !== 1) {
    await actions.press(page, 'Escape');
    return { ok: false, column, wrote: option, options: seen.items.map((item) => item.text),
      reason: hit.length === 0 ? `「${column}」没有完全一致的候选项` : `「${column}」有重复候选项，拒绝猜测` };
  }
  await actions.click(page, hit[0].x, hit[0].y);
  const after = await waitFor(() => cellTarget(page, { which, row, column, scroll: false }, deps),
    (candidate) => candidate.ok && candidate.text === option, settleMs, actions.sleep);
  const matched = after.ok && after.text === option;
  return { ok: matched, column, wrote: option, before: before.text,
    after: after.ok ? after.text : null, options: seen.items.map((item) => item.text), matched,
    reason: matched ? undefined : `「${column}」回读不是「${option}」` };
}

export async function showSection(page, label, { settleMs = 2500 } = {}, deps = {}) {
  const anchors = await sectionAnchors(page, deps);
  const anchor = anchors.find((item) => item.label === label);
  if (!anchor) return { ok: false, reason: `页面上找不到「${label}」区域锚点`, anchors };
  const actions = actionsOf(deps);
  await actions.click(page, anchor.x, anchor.y);
  await actions.sleep(settleMs);
  return { ok: true, anchor };
}

export async function leaveEdit(page, { label = '明细信息', settleMs = 1200 } = {}, deps = {}) {
  const shown = await showSection(page, label, { settleMs }, deps);
  if (!shown.ok) return shown;
  const grid = await readGrid(page, 0, deps);
  return { ok: true, stillEditing: grid.ok ? grid.rows.some((row) => row.editing) : null };
}
