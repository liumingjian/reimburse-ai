import { connect, evalIn, clickAt, typeText, pressKey, selectAll } from './chrome.mjs';

// 费用报销单页面的回读与字段写入。
//
// 实测事实决定了这里的做法（2026-09-05，K3Cloud 8.2.0）：
//
//   1. 明细网格的单元格**没有字段 key**。表头有 `FCAUSA` 这种带实例 UUID 的 id，
//      但网格里没有，所以明细只能按**列标题**定位，不能按字段 key。
//   2. 网格比视口宽，横向滚动；单元格的文本在 DOM 里一直都在，
//      所以**回读不需要滚动**，但写入必须先把目标列滚进视口 ——
//      真实鼠标事件打的是视口坐标，看不见的地方点下去就是点在别的控件上。
//   3. 金蝶控件不认程序化赋值（"编辑态可见、失焦后丢失"的假成功，见 save-contract）。
//      所以写入只有一条路径：真点一下进编辑态 -> 全选 -> 逐键输入 -> Enter/Tab 提交。
//
// 写入之后一律**当场回读**，而且回读的是非编辑态的单元格文本：
// 写进去了和 ERP 收到了是两回事，只有回读能分辨。
// 这个模块**不含保存**，一行都没有 —— 保存要走单独的、每次现场授权的入口。

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

// 网格的定位逻辑。回读和写入必须用**同一套**行列判定，
// 否则"读到第 2 行"和"写到第 2 行"可能不是同一行。
//
// 列**按 DOM 顺序对齐，不按坐标**。曾经按单元格 x 中心去匹配表头 x 中心，
// 那是错的：横向滚动时表头行和数据行不在同一个滚动容器里
// （实测表头还在 44..2614，数据行已经滚到 -812..1308），x 一对就全错位。
// 顺序对齐要求两边列数相同；不同就直接报出来，绝不"尽力匹配"——
// 错位的列会把税额写进申请付款金额，而且看上去一切正常。
const GRID_JS = `
  const vis = ${VIS};
  const clean = (s) => s.replace(/设置/g, '').replace(/\\s+/g, ' ').trim();
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
        // 编辑态的单元格 innerText 是空的，值在里面的 input 上。
        // 两者分开回报：input 里有字不等于 ERP 收到了。
        const inp = td.querySelector('input,textarea');
        if (inp && inp.value !== '') editValues[label] = String(inp.value);
      });
      if (!Object.values(values).some((v) => v !== '') && Object.keys(editValues).length === 0) continue;
      const b = tr.getBoundingClientRect();
      // 合计行按 class 认，不按"有没有序号"—— 行进编辑态时序号也可能读不出来。
      const kind = /k-footer-template/.test(tr.className) ? 'total' : 'data';
      rows.push({ y: Math.round(b.y + b.height / 2), values, editValues, nodes, kind,
        editing: /k-grid-edit-row/.test(tr.className) });
    }
    return { grid, heads, rows, gridCount: grids.length };
  };
  // 按**表头标签语义**认网格，不按位置索引。位置索引是 fail-open 的：
  // ERP 换个布局，读到的就是另一个网格，而且看上去一切正常。
  // 认到零个或多个都不给结论 —— 对账不该比写入更松。
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
      // nodes 是 DOM 节点，序列化不了，也不该越过通道 —— 只回文本。
      rows: g.rows.map((r) => ({ y: r.y, kind: r.kind, editing: r.editing,
        values: r.values, editValues: r.editValues })) };
  };
`;

/**
 * 读一个网格：列标题 -> 每行的单元格文本。
 * `which` 是第几个可见网格（明细在前、收票在后）。
 */
export async function readGrid(session, which = 0) {
  return evalIn(session, `(() => {
    ${GRID_JS}
    const g = pick(${Number(which)});
    if (!g.grid) return { ok: false, reason: '页面上没有第 ${Number(which)} 个可见网格', gridCount: g.gridCount };
    return readPicked(g);
  })()`);
}

/**
 * 按**表头标签**读一个网格：收票认 `价税合计` 列、明细认 `申请报销金额` 列。
 * 对账走这条路，不走位置索引 —— 索引取错网格时读数看上去照样正常。
 * 认到零个或多于一个都不给结论。它只求值，不点击、不滚动。
 */
export async function readGridByColumn(session, column) {
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

/**
 * 把某个单元格滚进视口并回报它的视口坐标。
 * 横向滚动是写入的前提；`block: 'nearest'` 是为了别顺手改变纵向位置，
 * 那会让同一次操作里刚测好的其它坐标全部作废。
 */
export async function cellTarget(session, { which = 0, row = 0, column, scroll = true }) {
  return evalIn(session, `(() => {
    ${GRID_JS}
    const g = pick(${Number(which)});
    if (!g.grid) return { ok: false, reason: '页面上没有第 ${Number(which)} 个可见网格', gridCount: g.gridCount };
    // 有错位行就整个不认：错位会让行号悄悄错开一位，而写入是按行号下手的。
    const bad = g.rows.filter((r) => r.misaligned);
    if (bad.length) return { ok: false, reason: '有 ' + bad.length + ' 行的单元格数量和表头列数对不上，不在错位的网格上写入', bad };
    const data = g.rows.filter((r) => r.kind === 'data');
    const r = data[${Number(row)}];
    if (!r) return { ok: false, reason: '这个网格里没有第 ${Number(row) + 1} 条明细', rowCount: data.length };
    const col = ${JSON.stringify(column)};
    const td = r.nodes[col];
    if (!td) return { ok: false, reason: '这个网格里没有「' + col + '」列', columns: Object.keys(r.nodes) };
    // 滚动只在**动手之前**做一次。编辑器开着的时候再滚，编辑会被取消 ——
    // 而回读是要反复轮询的，每轮都滚一次就等于每轮都把自己刚写的取消一次。
    if (${scroll ? 'true' : 'false'}) td.scrollIntoView({ inline: 'center', block: 'nearest' });
    const b = td.getBoundingClientRect();
    const inp = td.querySelector('input,textarea');
    const a = document.activeElement;
    return { ok: true, column: col, text: clean(td.innerText),
      editValue: inp ? String(inp.value) : null, editing: r.editing,
      // editing 是**整行**的状态（k-grid-edit-row）。行早就在编辑态了，
      // 而这一格的编辑器可能还没绑好。焦点"落在这一格里"也还不够：
      // td 自己拿到焦点时 contains 一样是 true，这时打字全落空。
      // 真正能打字的判据是焦点落在这一格里一个真正的输入控件上。
      // 金额格用 kd-editor-input-bound，F7 格是另一套 class，所以按标签认，不按 class 认。
      focused: !!(a && td.contains(a) && a !== td),
      focusTag: a && td.contains(a) ? a.tagName : null,
      editorBound: !!(a && td.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)),
      x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
      inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
  })()`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 反复观测直到满足条件，或者超时。超时**不抛错**，回最后一次观测 ——
 * 判断留给调用方，这里不替谁决定"再等等大概就好了"。
 */
const waitFor = async (probe, ok, ms) => {
  const deadline = Date.now() + ms;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(300);
    last = await probe();
  }
  return last;
};

/**
 * 等网格算完。写一个字段会触发联动重算（写费用金额会重算申请报销/申请付款，
 * 并清掉税额），重算期间写下一格，值会被这轮重算覆盖掉 ——
 * 实测表现就是"税额单独写没问题，跟在费用金额后面写就丢"。
 *
 * 判据是**连续两次读到的明细一模一样**，不是等一个拍脑袋的时长。
 * 超时不报错：回一个 settled=false，让调用方自己决定认不认。
 */
export async function settleGrid(session, which = 0, { quietMs = 900, maxMs = 9000 } = {}) {
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

/**
 * 写一个明细单元格：真点进编辑态 -> 全选 -> 逐键输入 -> 提交键 -> 回读。
 *
 * 返回里 `matched` 只表示"回读文本和写进去的字面量一致"。F7 类字段
 * （项目、费用项目）按编码写、回读出来的是名称，`matched` 会是 false 而并非失败 ——
 * 这里如实回报，判断留给调用方，内核不替 ERP 圆场。
 */
export async function writeCell(session, { which = 0, row = 0, column, value, expect = null,
  commit = 'Enter', clicks = 3, readyMs = 9000, settleMs = 8000, settleFirst = true } = {}) {
  // 先等上一格的联动重算停下来再动手。实测：网格安静时点一下，编辑器 400ms 内就绑好了；
  // 重算还在跑的时候点，同一下点击要么被吞掉、要么绑好的编辑器随即被这轮重算收走。
  if (settleFirst) await settleGrid(session, which);
  const at = () => cellTarget(session, { which, row, column, scroll: false });
  const before = await cellTarget(session, { which, row, column });
  if (!before.ok) return { ok: false, column, ...before };
  if (!before.inView) {
    return { ok: false, column, target: before,
      reason: `「${column}」滚动之后仍然不在视口里（x=${before.x} y=${before.y}）；不在看不见的地方点击` };
  }
  // 点开之后编辑器不是立刻就绑好的，尤其是紧接着上一个字段的联动重算、
  // 或者上一格的下拉刚合上的时候。在那个空窗里逐键输入，字会打进一个
  // 马上被丢掉的控件：实测表现是"写了等于没写"，而且不报错。
  //
  // 那一下点击也可能整个被吞掉（被正在关闭的下拉挡住），所以点击本身要重试。
  // 重试的是**取得焦点**这个动作 —— 它不改任何值，重复点没有副作用；
  // 值只写一次，而且写完照样要回读。
  // 每次重试都**重新定位**再点：上一步写表头会把页面滚动一段，
  // 沿用第一次算出的坐标就是点在旧位置上，看起来像"点了没反应"。
  let ready = null;
  let spot = before;
  for (let attempt = 0; attempt < clicks && !(ready && ready.editorBound); attempt++) {
    if (attempt > 0) {
      spot = await cellTarget(session, { which, row, column });
      if (!spot.ok || !spot.inView) break;
    }
    await clickAt(session, spot.x, spot.y);
    ready = await waitFor(at, (c) => c.ok && c.editorBound === true, Math.ceil(readyMs / clicks));
  }
  if (!ready.ok || ready.editorBound !== true) {
    return { ok: false, column, wrote: String(value), before: before.text,
      reason: `点了「${column}」之后这一格里没有绑好的编辑控件`
        + `（焦点在 ${ready.focusTag ?? '别处'}），不往一个没绑好的控件里打字` };
  }

  await selectAll(session);
  await typeText(session, String(value));
  await pressKey(session, commit);

  // 提交之后也不能立刻回读：实测 800ms 时单元格还是空的，1200ms 才回填。
  const want = String(value);
  const after = await waitFor(at, (c) => c.ok && c.text !== '' && cellMatches(c.text, want, expect), settleMs);

  const matched = after.ok && cellMatches(after.text, want, expect);
  return { ok: matched, column, wrote: want, expect,
    before: before.text, after: after.ok ? after.text : null,
    // 编辑态里 input 上的值只是"看得见"，不是 ERP 收到了。分开回报，不合并成一个 after。
    editValue: after.ok ? after.editValue : null,
    editing: after.ok ? after.editing : null, matched,
    reason: matched ? undefined
      : `写了「${want}」，「${column}」回读是「${after.ok ? after.text : '读不出'}」，` +
        `跟预期的「${expect ? expect.value : want}」对不上` };
}

/**
 * 回读到的文本算不算"写对了"。
 *
 * 默认按写进去的字面量比。F7 列（项目、费用项目）按编码写、回读出来是名称，
 * 所以调用方要显式给出**预期回读成什么**：
 *   项目  -> { mode: 'endsWith', value: '-111454' }（显示名以项目号结尾）
 *   费用项目 -> { mode: 'equals', value: '长途交通' }（名称来自只读主数据核对）
 * 不给预期就只能按字面量比，比不上就是比不上 —— 这里不做模糊匹配。
 */
export const cellMatches = (text, want, expect) => {
  if (!expect) return sameValue(text, want);
  return expect.mode === 'endsWith' ? String(text).endsWith(expect.value) : sameValue(text, expect.value);
};

// 金额列回读出来带货币符号和千分位（实测 `¥18.25`），F7 列回读出来是名称而不是编码。
// 这里只做符号层面的归一化，不做任何数值换算 —— 归一化之后还是不等就是不等。
const sameValue = (got, want) => {
  if (got === want) return true;
  const money = (t) => String(t).replace(/[¥￥,\s]/g, '');
  return /^[¥￥]?[\d,]+(\.\d+)?$/.test(String(got)) && money(got) === money(want);
};

/**
 * 下拉列（发票类型）：点开、按**完全一致**的文本挑一项、回读。
 *
 * 它不是文本框，是 Kendo 的 dropdown（焦点落在一个 span 上），
 * 所以逐键输入对它没有任何作用 —— 实测写"其他运输票"之后它仍然是"普通发票"，
 * 而且不报错。这类"写了等于没写"只有回读能发现。
 *
 * 只认完全一致：选错发票类型会连带影响税额口径，宁可停下来把候选项列出来。
 */
export async function selectOption(session, { which = 0, row = 0, column, option,
  readyMs = 6000, settleMs = 6000 } = {}) {
  const before = await cellTarget(session, { which, row, column });
  if (!before.ok) return { ok: false, column, ...before };
  if (!before.inView) {
    return { ok: false, column, target: before,
      reason: `「${column}」滚动之后仍然不在视口里；不在看不见的地方点击` };
  }
  await clickAt(session, before.x, before.y);

  // 下拉的候选项**先于**编辑器绑好就出现了。在那个空窗里点中一项，
  // 下拉会照常关上、值却被丢掉，而且不报任何错（实测 900ms 时必丢、1500ms 时成功）。
  // 所以等的是条件不是时长：候选项出得来，而且这一行确实进了编辑态。
  const listItems = () => evalIn(session, `(() => {
    const vis = ${VIS};
    return [...document.querySelectorAll('ul[class*=k-list] li, li[role=option]')].filter(vis)
      .map((n) => { const b = n.getBoundingClientRect();
        return { text: n.innerText.replace(/\\s+/g, ' ').trim(),
          x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
  })()`);
  const probe = async () => ({ items: await listItems(),
    cell: await cellTarget(session, { which, row, column, scroll: false }) });
  const seen = await waitFor(probe,
    (p) => p.items.length > 0 && p.cell.ok && p.cell.focused === true, readyMs);
  const items = seen.items;
  const ready = seen.items.length > 0 && seen.cell.ok && seen.cell.focused === true;

  const hit = items.filter((i) => i.text === option);
  if (hit.length !== 1) {
    // 点开了就得关上，别把一个张着的下拉留在页面上给下一步添乱。
    await pressKey(session, 'Escape');
    return { ok: false, column, wrote: option, ready, options: items.map((i) => i.text),
      reason: hit.length === 0
        ? `「${column}」的候选项里没有完全等于「${option}」的一项`
        : `「${column}」里有 ${hit.length} 项都叫「${option}」，选哪个都是猜` };
  }
  await clickAt(session, hit[0].x, hit[0].y);

  const after = await waitFor(() => cellTarget(session, { which, row, column, scroll: false }),
    (c) => c.ok && c.text === option, settleMs);

  const matched = after.ok && after.text === option;
  // 枚举列没有"写对了但回读不一样"这回事：候选项是照着文本点的。
  // 所以对不上就是没写进去，不能报成功。
  return { ok: matched, column, wrote: option, ready,
    before: before.text, after: after.ok ? after.text : null,
    options: items.map((i) => i.text), matched,
    reason: matched ? undefined : `点中了「${option}」，但单元格回读仍然是「${after.ok ? after.text : '读不出'}」` };
}

/**
 * 让明细行离开编辑态。编辑态的单元格 innerText 是空的，
 * 而 save-contract 要求读的是**非编辑态**的单元格文本 —— 所以最终回读之前必须先离开。
 * 点区域锚点是页内导航，不改任何值，是这里能找到的最轻的一次失焦。
 */
export async function leaveEdit(session, { label = '明细信息', settleMs = 1200 } = {}) {
  const shown = await showSection(session, label, { settleMs });
  if (!shown.ok) return shown;
  const grid = await readGrid(session, 0);
  return { ok: true, stillEditing: grid.ok ? grid.rows.some((r) => r.editing) : null };
}

/**
 * 表头字段。id 形如 `<表单实例UUID>-<字段key>[-EDITOR]`，
 * 所以按后缀找，不去猜那个 UUID。
 *
 * `scroll` 只在**写入前**要开。只读探针（对账）必须关掉它：
 * 滚动是页面副作用，而对账的立场是一个字都不改。
 */
export async function headerField(session, key, { scroll = true } = {}) {
  return evalIn(session, `(() => {
    const key = ${JSON.stringify(key)};
    const all = [...document.querySelectorAll('[id]')]
      .filter((n) => n.id.endsWith('-' + key) || n.id.endsWith('-' + key + '-EDITOR'));
    if (all.length === 0) return { ok: false, reason: '页面上找不到表头字段 ' + key };
    // 页面上可能同时挂着**多套 form 实例**（上一张单没卸干净），id 会重名。
    // 隐藏那套的 rect 全是 0，照着点等于点页面左上角，焦点永远进不去，
    // 回读还会读出别的单据的旧值 —— 实测 FCAUSA 就这样读出了另一张表单的「客户支持」。
    // 所以先按可见性挑，一个可见的都没有才退回原来的集合。
    const showing = (x) => {
      const b = x.getBoundingClientRect();
      const st = getComputedStyle(x);
      return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    // 恰好一个可见实例才认。零个时退回全集是 **fail-open 缺陷**：
    // 隐藏那套的值是真的旧值，实测在隐藏字段上取到过 2025-12 的陈旧单号。
    // 多于一个同样不认 —— 挑哪个都是猜。
    const visible = all.filter(showing);
    if (visible.length === 0) {
      return { ok: false, reason: '表头字段 ' + key + ' 没有可见实例', instances: all.length, visibleInstances: 0 };
    }
    if (visible.length > 1) {
      return { ok: false, reason: '表头字段 ' + key + ' 有 ' + visible.length + ' 个可见实例，认不出是哪一张单的',
        instances: all.length, visibleInstances: visible.length };
    }
    const hit = visible;
    // 带 -EDITOR 的才是真正的输入控件，外层那个只是容器。
    const n = hit.find((x) => x.id.endsWith('-EDITOR')) || hit[0];
    // 表头可能已经滚出视口（实测 rect.y 为负），写入前必须先滚回来。
    if (${scroll ? 'true' : 'false'}) n.scrollIntoView({ block: 'center', inline: 'nearest' });
    const input = n.matches('input,textarea') ? n : n.querySelector('input,textarea');
    const t = input || n;
    const b = t.getBoundingClientRect();
    const a = document.activeElement;
    return { ok: true, id: n.id, tag: t.tagName, instances: all.length, visibleInstances: visible.length,
      // 跟明细格一样：点了不等于焦点进去了，焦点没进去就打字，字全落空。
      focused: a === t || (n.contains(a) && a !== n),
      value: (input ? input.value : n.innerText).replace(/\\s+/g, ' ').trim(),
      x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
      inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight };
  })()`);
}

/**
 * 写表头字段。用 Tab 提交而不是 Enter：save-contract 记着事由必须**真实失焦**，
 * 单纯 DOM 里可见的值过不了保存校验。
 */
export async function writeHeader(session, key, value, { readyMs = 4000, settleMs = 600 } = {}) {
  const before = await headerField(session, key);
  if (!before.ok) return { ok: false, key, ...before };
  if (!before.inView) {
    return { ok: false, key, target: before,
      reason: `表头字段 ${key} 滚动之后仍然不在视口里（x=${before.x} y=${before.y}）` };
  }
  await clickAt(session, before.x, before.y);
  const ready = await waitFor(() => headerField(session, key), (c) => c.ok && c.focused === true, readyMs);
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
    reason: matched ? undefined
      : `写了「${value}」，表头 ${key} 回读是「${after.ok ? after.value : '读不出'}」` };
}

/** 打开一个已登录页面的会话。调用方负责关。 */
export async function openSession(wsUrl) {
  return connect(wsUrl, { timeout: 20000 });
}
