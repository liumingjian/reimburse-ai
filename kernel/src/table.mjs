/**
 * 定宽文本表格。内核渲染好，模型**原样贴进对话**。
 *
 * 为什么渲染在内核：表格是给用户做判断用的界面，而界面的措辞、列的取舍、
 * 哪一栏留白，都是模型之间差异最大的地方。内核渲染好一整块文本，
 * 模型只负责搬运，用户看到的东西就和模型是谁无关。
 *
 * 中日韩字符在等宽终端里占两格。按码点数对齐会让中文那几列整体歪掉，
 * 所以这里按**显示宽度**算，不按字符数。
 */

/** 这个码点在等宽终端里占几格。 */
function charWidth(cp) {
  // 控制字符不占位；组合记号（U+0300–U+036F 等）附着在前一个字上。
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;       // 变体选择符
  return isWide(cp) ? 2 : 1;
}

/** Unicode 的东亚宽/全角区段，够用即可 —— 这里要处理的是中文票面和字段名。 */
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)             // 韩文字母
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) // 部首、假名、汉字
    || (cp >= 0xac00 && cp <= 0xd7a3)               // 韩文音节
    || (cp >= 0xf900 && cp <= 0xfaff)               // 兼容汉字
    || (cp >= 0xfe30 && cp <= 0xfe6f)               // 竖排/小型变体
    || (cp >= 0xff00 && cp <= 0xff60)               // 全角
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)             // 常见表情
    || (cp >= 0x20000 && cp <= 0x3fffd);            // 扩展汉字
}

/** 一串文本在终端里占几格。 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += charWidth(ch.codePointAt(0));
  return w;
}

/** 超过 max 格就截断，末尾用 `…` 顶上（`…` 自己占一格）。 */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (displayWidth(str) <= max) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

const pad = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

/**
 * 渲染一张表。
 *
 * `columns`：`{ key, label, max? }[]`，`max` 是这一列的显示宽度上限。
 * `rows`：对象数组，取 `columns[].key`。缺的值渲染成空白，不渲染成 `undefined`。
 *
 * 列宽取「表头和所有单元格里最宽的那个」，再受 `max` 约束 —— 表格因此**只跟内容有关**，
 * 同一批读数渲染两次一定一模一样。
 */
export function renderTable(columns, rows) {
  const cells = rows.map((r) => columns.map((c) => truncate(r[c.key] ?? '', c.max ?? 40)));
  const widths = columns.map((c, i) => Math.max(
    displayWidth(c.label),
    ...cells.map((row) => displayWidth(row[i])),
    1,
  ));
  const line = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const row = (vals) => `│ ${vals.map((v, i) => pad(v, widths[i])).join(' │ ')} │`;
  return [
    line('┌', '┬', '┐'),
    row(columns.map((c) => c.label)),
    line('├', '┼', '┤'),
    ...cells.map(row),
    line('└', '┴', '┘'),
  ].join('\n');
}
