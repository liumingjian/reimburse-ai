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

/**
 * 把一轮问题渲染成一整块文本，模型**原样贴进对话**。
 *
 * 为什么渲染在内核，和表格是同一个理由：这是给用户做判断的界面。
 * 选项少列一个、顺序换一换、把「其他」那一行吞掉，用户都察觉不到，
 * 而这几件事恰恰是模型之间差异最大的地方。
 *
 * **不依赖任何提问工具。** 1.0.0 一度打算走 Claude Code 的终端多选控件，
 * 后来定死不用：用户可以把它关掉，别的 Agent 也未必有它，而「在对话里问一句」
 * 是哪里都有的。问题的措辞、选项和编号都在这里定死，模型只负责搬运和誊回答案。
 *
 * `questions`：`{ id, header, question, options: [{ label, description? }], multiSelect? }[]`。
 */
export function renderQuestions(questions) {
  const blocks = (questions ?? []).map((q) => {
    // 表头单独一行，不和问句挤在一起 —— 发票文件名本身就常带括号，
    // 「【第 1 段】【曹操出行…】.pdf」这种撞在一起的开头，人是要读第二遍的。
    const head = q.header ? `${q.header}\n${q.question}` : q.question;
    const opts = (q.options ?? []).map((o, i) => {
      const line = `  ${i + 1}) ${o.label}`;
      return o.description ? `${line}\n     ${o.description}` : line;
    });
    const multi = q.multiSelect ? '  （这一题可以选多个）' : null;
    return [head, ...opts, multi].filter(Boolean).join('\n');
  });
  const one = (questions ?? []).length === 1;
  const how = one
    ? '答的时候说编号就行（比如「1」），也可以直接把你的答案告诉我。'
    : '答的时候一题一句，说编号就行（比如「第 1 段选 1」），也可以直接把答案告诉我。';
  return [...blocks, how].join('\n\n');
}
