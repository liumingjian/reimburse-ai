// DESIGN.md front matter 的最小 YAML 子集解析：嵌套映射、标量、由映射或标量组成的列表。
// 只为 token 生成服务，不追求通用 YAML；遇到不认识的写法直接报错，避免悄悄生成错 token。

export function extractFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error('DESIGN.md 缺少 front matter（文件开头的两道 --- 之间）');
  return match[1];
}

export function parseYamlSubset(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ n: index + 1, raw }))
    .filter(({ raw }) => raw.trim() !== '' && !raw.trim().startsWith('#'))
    .map(({ n, raw }) => ({ n, indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  if (lines.length === 0) return {};
  const [value, next] = parseNode(lines, 0, lines[0].indent);
  if (next !== lines.length) throw new Error(`第 ${lines[next].n} 行无法解析`);
  return value;
}

function parseNode(lines, i, indent) {
  return lines[i].text.startsWith('- ') ? parseList(lines, i, indent) : parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const out = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent || line.text.startsWith('- ')) break;
    if (line.indent > indent) throw new Error(`第 ${line.n} 行缩进不合法`);
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(line.text);
    if (!match) throw new Error(`第 ${line.n} 行不是 key: value`);
    const key = match[1].trim();
    const rest = (match[2] ?? '').trim();
    if (rest !== '') {
      out[key] = scalar(rest, line.n);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, j] = parseNode(lines, i + 1, next.indent);
      out[key] = value;
      i = j;
    } else {
      out[key] = null;
      i += 1;
    }
  }
  return [out, i];
}

function parseList(lines, i, indent) {
  const out = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent || !line.text.startsWith('- ')) break;
    if (line.indent > indent) throw new Error(`第 ${line.n} 行缩进不合法`);
    const body = line.text.slice(2).trim();
    if (/^[^:]+:(\s|$)/.test(body)) {
      // 列表项本身是映射：把 "- key: v" 视作缩进 +2 的 "key: v"，后续同缩进的行归入同一映射。
      const copy = lines.slice();
      copy[i] = { n: line.n, indent: indent + 2, text: body };
      const [value, j] = parseMap(copy, i, indent + 2);
      out.push(value);
      i = j;
    } else {
      out.push(scalar(body, line.n));
      i += 1;
    }
  }
  return [out, i];
}

function scalar(raw, n) {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new Error(`第 ${n} 行双引号未闭合`);
    return JSON.parse(raw);
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`第 ${n} 行单引号未闭合`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}
