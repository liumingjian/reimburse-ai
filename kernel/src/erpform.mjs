import { connect, evalIn, clickAt } from './chrome.mjs';

// 费用报销单页面的只读回读。
//
// 两条实测事实决定了这里的做法（2026-09-05，K3Cloud 8.2.0）：
//
//   1. 明细网格的单元格**没有字段 key**。表头有 `FCAUSA` 这种带实例 UUID 的 id，
//      但网格里没有，所以明细只能按**列标题**定位，不能按字段 key。
//   2. 网格比视口宽，横向滚动；但单元格的文本在 DOM 里一直都在，
//      所以**回读不需要滚动**，只有写入才需要。
//
// 这个模块只读不写：保存后置条件要求逐项回读，回读本身不能有任何副作用。

const SECTIONS = ['基本信息', '付款信息', '明细信息', '收票信息'];

const VIS = `(n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }`;

/** 页面上开着的单据页签，以及当前是"新增"还是"修改"——保存成功的判据之一。 */
export async function formTabs(session) {
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

/** 区域锚点（基本信息/付款信息/明细信息/收票信息）的位置。 */
export async function sectionAnchors(session) {
  return evalIn(session, `(() => {
    const vis = ${VIS};
    const want = ${JSON.stringify(SECTIONS)};
    const out = [];
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length !== 0 || !vis(n)) continue;
      const t = n.textContent.trim();
      if (!want.includes(t)) continue;
      const b = n.getBoundingClientRect();
      // 锚点在页面顶部的导航条上，正文里的同名标题不是。
      if (b.y > 260) continue;
      out.push({ label: t, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    }
    return out;
  })()`);
}

/**
 * 让某个区域渲染出来。明细信息是懒渲染的：不点它，网格在 DOM 里根本不存在。
 * 点区域锚点只是页内导航，不改任何值。
 */
export async function showSection(session, label, { settleMs = 2500 } = {}) {
  const anchors = await sectionAnchors(session);
  const a = anchors.find((x) => x.label === label);
  if (!a) return { ok: false, reason: `页面上找不到「${label}」区域锚点`, anchors };
  await clickAt(session, a.x, a.y);
  await new Promise((r) => setTimeout(r, settleMs));
  return { ok: true, anchor: a };
}

/**
 * 读一个网格：列标题 -> 每行的单元格文本。
 * `which` 是第几个可见网格（明细在前、收票在后）。
 */
export async function readGrid(session, which = 0) {
  return evalIn(session, `(() => {
    const vis = ${VIS};
    const grids = [...document.querySelectorAll('.kd-grid-panel')].filter(vis);
    const grid = grids[${Number(which)}];
    if (!grid) return { ok: false, reason: '页面上没有第 ${Number(which)} 个可见网格', gridCount: grids.length };

    const clean = (s) => s.replace(/设置/g, '').replace(/\\s+/g, ' ').trim();
    const heads = [...grid.querySelectorAll('th,[class*=header-cell]')].filter(vis).map((n) => {
      const b = n.getBoundingClientRect();
      return { label: clean(n.innerText).replace(/^\\./, '').replace(/\\s*\\*$/, ''),
        required: /\\*\\s*$/.test(clean(n.innerText)),
        x: Math.round(b.x + b.width / 2) };
    }).filter((h) => h.label);

    const rows = [...grid.querySelectorAll('tr')].filter(vis).map((tr) => {
      const b = tr.getBoundingClientRect();
      const cells = [...tr.children].map((td) => {
        const c = td.getBoundingClientRect();
        return { x: Math.round(c.x + c.width / 2), text: clean(td.innerText) };
      });
      return { y: Math.round(b.y + b.height / 2), cells };
    });

    // 按 x 把单元格对回列。网格横向滚动，但 DOM 文本一直在，所以不用滚。
    const byLabel = rows.map((r) => {
      const o = {};
      for (const h of heads) {
        const cell = r.cells.find((c) => Math.abs(c.x - h.x) < 3);
        if (cell) o[h.label] = cell.text;
      }
      return { y: r.y, values: o };
    });
    // 两种行不是数据：整行全空的占位行，以及表头行本身 ——
    // 表头也是一个 <tr>，它的单元格文本就是列名（有的还带 "." 前缀和 "*" 号）。
    const norm = (v) => v.replace(/^\\./, '').replace(/\\s*\\*$/, '').trim();
    const isHeaderRow = (r) => {
      const labels = Object.keys(r.values);
      const same = labels.filter((k) => r.values[k] && norm(r.values[k]) === k).length;
      return labels.length > 0 && same > labels.length / 2;
    };
    const kept = byLabel.filter((r) =>
      Object.values(r.values).some((v) => v !== '') && !isHeaderRow(r));
    // 网格最后一行是合计行：没有序号，只有几个金额列有值。
    // 不丢掉它 —— 金额守恒对账要用 —— 但要标出来，别当成一条明细。
    const marked = kept.map((r) => ({ ...r, kind: r.values['序号'] ? 'data' : 'total' }));
    return { ok: true, columns: heads.map((h) => ({ label: h.label, required: h.required })),
      rowCount: marked.filter((r) => r.kind === 'data').length, rows: marked };
  })()`);
}

/** 打开一个已登录页面的会话。调用方负责关。 */
export async function openSession(wsUrl) {
  return connect(wsUrl, { timeout: 20000 });
}
