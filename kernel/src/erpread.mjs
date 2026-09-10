import { isEgoPage } from './ego.mjs';
import { evaluateBrowserPage, isDefaultBrowserPage } from './browser-read.mjs';

// 费用报销单的只读回读。这个模块故意不依赖 erpform.mjs：后者还承载
// 旧写入路径的 Chrome/CDP 操作，erp-read 和 erp-reconcile 不能经由它回退。

export const READ_TIMEOUT_MS = 15_000;
const SECTIONS = ['基本信息', '付款信息', '明细信息', '收票信息'];
const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;

const egoPageRequired = () => {
  const error = new Error('ERP 只读回读需要 ego task-space page context；旧 Chrome/CDP 页面句柄已阻塞');
  error.code = 'EGO_PAGE_REQUIRED';
  return error;
};

const evaluatorOf = (options = {}) => options.evaluate ?? evaluateBrowserPage;

const assertReadPageShape = (page, evaluate) => {
  if (page?.transport === 'ego') {
    if (evaluate === evaluateBrowserPage && !isEgoPage(page)) throw egoPageRequired();
    if (page?.taskSpace === null || page?.taskSpace === undefined || !page?.tabId) throw egoPageRequired();
    return;
  }
  if (page?.transport === 'default' && isDefaultBrowserPage(page)) return;
  if (page?.transport === 'default') {
    const error = new Error('ERP 只读回读需要有效的系统默认浏览器页面句柄');
    error.code = 'DEFAULT_BROWSER_PAGE_REQUIRED';
    throw error;
  }
  throw egoPageRequired();
};

const evaluateRead = (page, expression, options = {}) => {
  const evaluate = evaluatorOf(options);
  assertReadPageShape(page, evaluate);
  const evaluateOptions = { timeoutMs: READ_TIMEOUT_MS };
  if (page?.transport === 'default') evaluateOptions.origin = page.origin;
  return evaluate(page, expression, evaluateOptions);
};

const FORM_TABS_JS = `(() => {
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
})()`;

const SECTION_ANCHORS_JS = `(() => {
  const vis = ${VIS};
  const want = ${JSON.stringify(SECTIONS)};
  const out = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    const t = n.textContent.trim();
    if (!want.includes(t)) continue;
    const b = n.getBoundingClientRect();
    // 顶部导航锚点在页面正文之前，同名正文标题不算导航。
    if (b.y > 260) continue;
    out.push({ label: t, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  }
  return out;
})()`;

// 明细和收票网格按列标题定位，列仍按 DOM 顺序对齐。这里不保留写入所需的
// nodes、scrollIntoView 或坐标动作，只返回可序列化的文本事实。
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
      tds.forEach((td, i) => {
        const label = heads[i].label;
        if (!label) return;
        values[label] = clean(td.innerText);
        const inp = td.querySelector('input,textarea');
        if (inp && inp.value !== '') editValues[label] = String(inp.value);
      });
      if (!Object.values(values).some((v) => v !== '') && Object.keys(editValues).length === 0) continue;
      const b = tr.getBoundingClientRect();
      const kind = /k-footer-template/.test(tr.className) ? 'total' : 'data';
      rows.push({ y: Math.round(b.y + b.height / 2), values, editValues, kind,
        editing: /k-grid-edit-row/.test(tr.className) });
    }
    return { grid, heads, rows, gridCount: grids.length };
  };
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
    if (bad.length) return { ok: false,
      reason: '有 ' + bad.length + ' 行的单元格数量和表头列数对不上，不按错位的列读',
      columnCount: g.heads.length, bad };
    return { ok: true,
      columns: g.heads.map((h) => ({ label: h.label, required: h.required })),
      rowCount: g.rows.filter((r) => r.kind === 'data').length,
      rows: g.rows.map((r) => ({ y: r.y, kind: r.kind, editing: r.editing,
        values: r.values, editValues: r.editValues })) };
  };
`;

const readGridAt = (which) => `(() => {
  ${GRID_JS}
  const g = pick(${which});
  if (!g.grid) return { ok: false, reason: '页面上没有第 ${which + 1} 个可见网格', gridCount: g.gridCount };
  return readPicked(g);
})()`;

const readGridColumn = (column) => `(() => {
  ${GRID_JS}
  const label = ${JSON.stringify(column)};
  const hits = pickBy(label);
  if (hits.length === 0) return { ok: false, matchedGrids: 0,
    reason: '页面上没有哪个可见网格的表头有「' + label + '」列' };
  if (hits.length > 1) return { ok: false, matchedGrids: hits.length,
    reason: '有 ' + hits.length + ' 个可见网格的表头都有「' + label + '」列，认不出该读哪个' };
  const g = pick(hits[0]);
  if (!g.grid) return { ok: false, matchedGrids: 1, reason: '「' + label + '」所在的网格读不出来' };
  return { ...readPicked(g), matchedGrids: 1 };
})()`;

const readHeader = (key) => `(() => {
  const key = ${JSON.stringify(key)};
  const all = [...document.querySelectorAll('[id]')]
    .filter((n) => n.id.endsWith('-' + key) || n.id.endsWith('-' + key + '-EDITOR'));
  if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
  const visible = all.filter((n) => {
    const b = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  });
  if (visible.length === 0) return { ok: false,
    reason: '表头字段 ' + key + ' 没有可见实例', instances: all.length, visibleInstances: 0 };
  // 金蝶一套表单会同时渲染 field wrapper、-EDITOR textfield 和内部 input；
  // 它们共享同一个 form prefix，不能把控件层级误算成三张单。不同 prefix
  // 仍然是不同 form 实例，必须拒绝，不能取第一个碰运气。
  const fieldSuffix = '-' + key;
  const editorSuffix = fieldSuffix + '-EDITOR';
  const instanceOf = (n) => n.id.endsWith(editorSuffix)
    ? n.id.slice(0, -editorSuffix.length) : n.id.slice(0, -fieldSuffix.length);
  const groups = new Map();
  for (const n of visible) {
    const instance = instanceOf(n);
    const group = groups.get(instance) ?? [];
    group.push(n);
    groups.set(instance, group);
  }
  if (groups.size > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 有 ' + groups.size + ' 个可见表单实例，认不出是哪一张单的',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const group = groups.values().next().value;
  const editors = group.filter((x) => x.id.endsWith(editorSuffix));
  if (editors.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的同一表单实例有 ' + editors.length + ' 个可见编辑控件，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const n = editors[0] || group[0];
  const nestedInputs = n.matches('input,textarea') ? [n] : [...n.querySelectorAll('input,textarea')];
  if (nestedInputs.length > 1) return { ok: false,
    reason: '表头字段 ' + key + ' 的可见编辑控件不唯一，拒绝猜测',
    instances: all.length, visibleInstances: groups.size, visibleNodes: visible.length };
  const input = nestedInputs[0] || null;
  const t = input || n;
  const b = t.getBoundingClientRect();
  return { ok: true, id: n.id, tag: t.tagName, instances: all.length, visibleInstances: groups.size,
    visibleNodes: visible.length,
    value: String(input ? input.value : n.innerText).replace(/\\s+/g, ' ').trim(),
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
    inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
})()`;

export async function readFormTabs(page, options = {}) {
  return evaluateRead(page, FORM_TABS_JS, options);
}

export async function readSectionAnchors(page, options = {}) {
  return evaluateRead(page, SECTION_ANCHORS_JS, options);
}

export async function readGrid(page, which = 0, options = {}) {
  const index = Number(which);
  if (!Number.isInteger(index) || index < 0) throw new RangeError('grid index must be a non-negative integer');
  return evaluateRead(page, readGridAt(index), options);
}

export async function readGridByColumn(page, column, options = {}) {
  if (typeof column !== 'string' || !column.trim()) throw new TypeError('grid column must be a non-empty string');
  return evaluateRead(page, readGridColumn(column), options);
}

export async function readHeaderField(page, key, options = {}) {
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('header field key must be a non-empty string');
  return evaluateRead(page, readHeader(key), options);
}

/** Read the current form without clicking a lazy section or scrolling a field. */
export async function readErpForm(page, options = {}) {
  const formTabs = await readFormTabs(page, options);
  const anchors = await readSectionAnchors(page, options);
  const billNo = await readHeaderField(page, 'FBILLNO', options);
  const detail = await readGridByColumn(page, '申请报销金额', options);
  const receipts = await readGridByColumn(page, '价税合计', options);
  return { formTabs, anchors, billNo, detail, receipts };
}
