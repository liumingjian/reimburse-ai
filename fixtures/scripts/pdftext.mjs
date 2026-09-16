// Origin: 50931a3:kernel/src/pdftext.mjs, rehomed by #197 for fixtures/scripts/verify.mjs only; the app parses PDFs with unpdf.
import zlib from 'node:zlib';

// Zero-dependency PDF text extraction. The kernel was not allowed npm dependencies (installing had to degrade to a
// plain file copy), so it decodes the PDF itself: Node's own zlib covers FlateDecode, the rest is parsing.
//
// Text only: no rendering and no OCR. A scan or a photographed invoice yields nothing, and that **is** the fact of a
// failed parse — it goes up as a 待确认项 (pending item); it is never guessed at.
//
// Everything here works on latin1 strings: latin1 maps bytes to characters one to one, so a string index is a byte
// offset and regexes and Buffer offsets can be mixed freely.

const WS = ' \t\r\n\f\0';
const DELIM = '()<>[]{}/%';
const isWs = (c) => WS.includes(c);
const isDelim = (c) => DELIM.includes(c);

class Lexer {
  constructor(s, pos = 0) { this.s = s; this.pos = pos; }

  skip() {
    const { s } = this;
    for (;;) {
      while (this.pos < s.length && isWs(s[this.pos])) this.pos++;
      if (s[this.pos] === '%') {           // A comment runs to the end of the line.
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else return;
    }
  }

  /** 读一个裸 token（关键字、数字、运算符）。 */
  token() {
    this.skip();
    const { s } = this;
    if (this.pos >= s.length) return null;
    const start = this.pos;
    if (isDelim(s[this.pos])) { this.pos++; return s.slice(start, this.pos); }
    while (this.pos < s.length && !isWs(s[this.pos]) && !isDelim(s[this.pos])) this.pos++;
    return s.slice(start, this.pos);
  }

  peek() { const p = this.pos; const t = this.token(); this.pos = p; return t; }

  /** 读一个 PDF 对象。引用返回 {ref}，名字返回 {name}，字符串返回 {str}（latin1 原始字节）。 */
  value() {
    this.skip();
    const { s } = this;
    const c = s[this.pos];
    if (c === undefined) return null;

    if (c === '/') { this.pos++; return { name: this.readName() }; }
    if (c === '(') { this.pos++; return { str: this.readLiteral() }; }
    if (c === '[') {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (s[this.pos] === ']') { this.pos++; return arr; }
        if (this.pos >= s.length) return arr;
        arr.push(this.value());
      }
    }
    if (c === '<') {
      if (s[this.pos + 1] === '<') { this.pos += 2; return this.readDict(); }
      this.pos++;
      return { str: this.readHex() };
    }
    if (c === ']' || c === '>' || c === '}') { this.pos++; return null; }

    const t = this.token();
    if (t === null) return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^[+-]?[\d.]+$/.test(t)) {
      // `12 0 R` is an indirect reference: it takes two more tokens to tell.
      const save = this.pos;
      const t2 = this.token();
      if (t2 !== null && /^\d+$/.test(t2)) {
        const t3 = this.token();
        if (t3 === 'R') return { ref: Number(t) };
      }
      this.pos = save;
      return Number(t);
    }
    return { op: t };
  }

  readName() {
    const { s } = this;
    const start = this.pos;
    while (this.pos < s.length && !isWs(s[this.pos]) && !isDelim(s[this.pos])) this.pos++;
    return s.slice(start, this.pos).replace(/#([0-9a-fA-F]{2})/g,
      (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  readLiteral() {
    const { s } = this;
    let out = '', depth = 1;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === '\\') {
        const e = s[this.pos++];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (map[e]) out += map[e];
        else if (e >= '0' && e <= '7') {          // An octal escape, three digits at most.
          let oct = e;
          while (oct.length < 3 && s[this.pos] >= '0' && s[this.pos] <= '7') oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (e === '\n') { /* 续行 */ }
        else out += e;
      } else if (c === '(') { depth++; out += c; }
      else if (c === ')') { if (--depth === 0) return out; out += c; }
      else out += c;
    }
    return out;
  }

  readHex() {
    const { s } = this;
    let hex = '';
    while (this.pos < s.length && s[this.pos] !== '>') {
      const c = s[this.pos++];
      if (/[0-9a-fA-F]/.test(c)) hex += c;
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  readDict() {
    const { s } = this;
    const dict = {};
    for (;;) {
      this.skip();
      if (this.pos >= s.length) return dict;
      if (s[this.pos] === '>' && s[this.pos + 1] === '>') { this.pos += 2; return dict; }
      if (s[this.pos] !== '/') { this.value(); continue; }   // A key has to be a name; skip anything else.
      this.pos++;
      const key = this.readName();
      dict[key] = this.value();
    }
  }
}

/** PDF 文档。不读 xref 表：直接全文扫描 `N G obj`，对损坏或增量更新的文件更耐受。 */
class Pdf {
  constructor(buf) {
    this.s = buf.toString('latin1');
    this.objs = new Map();
    this.scan();
    this.expandObjectStreams();
  }

  scan() {
    const re = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(this.s))) {
      // Under an incremental update the later object of a number overrides the earlier one: last write wins.
      this.objs.set(Number(m[1]), { bodyAt: re.lastIndex, parsed: undefined });
      re.lastIndex = re.lastIndex;
    }
  }

  get(v) {
    let seen = 0;
    while (v && typeof v === 'object' && 'ref' in v) {
      if (++seen > 32) return null;                 // A reference cycle: cut the losses.
      v = this.object(v.ref);
    }
    return v;
  }

  object(num) {
    const rec = this.objs.get(num);
    if (!rec) return null;
    if (rec.parsed !== undefined) return rec.parsed;
    rec.parsed = null;                              // A placeholder first, so a self-reference cannot recurse.
    const lx = new Lexer(this.s, rec.bodyAt);
    const val = lx.value();
    if (val && typeof val === 'object' && !Array.isArray(val) && lx.peek() === 'stream') {
      lx.token();
      let p = lx.pos;
      if (this.s[p] === '\r') p++;
      if (this.s[p] === '\n') p++;
      let len = this.get(val.Length);
      if (typeof len !== 'number' || len < 0 || p + len > this.s.length
          || !/^\s*endstream/.test(this.s.slice(p + len, p + len + 20))) {
        const e = this.s.indexOf('endstream', p);   // When /Length cannot be trusted, fall back to endstream.
        len = e < 0 ? 0 : e - p;
      }
      val.__stream = { at: p, len };
    }
    rec.parsed = val;
    return val;
  }

  /** 取出并解码流内容；解不开就返回 null，不抛。 */
  stream(dict) {
    if (!dict || !dict.__stream) return null;
    const raw = Buffer.from(this.s.slice(dict.__stream.at, dict.__stream.at + dict.__stream.len), 'latin1');
    let filters = this.get(dict.Filter);
    if (!filters) return raw;
    if (!Array.isArray(filters)) filters = [filters];
    let data = raw;
    for (const f of filters) {
      const name = this.get(f)?.name;
      if (name === 'FlateDecode') {
        try { data = zlib.inflateSync(data); }
        catch { try { data = zlib.inflateRawSync(data.subarray(1)); } catch { return null; } }
      } else if (name === 'ASCIIHexDecode') {
        const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
        data = Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), 'hex');
      } else {
        return null;                                // DCTDecode (an image) and friends: this is not text, so give up.
      }
    }
    const parms = this.get(dict.DecodeParms);
    const pred = this.get(parms?.Predictor);
    if (typeof pred === 'number' && pred >= 10) {
      data = unpredict(data, this.get(parms.Columns) ?? 1, this.get(parms.Colors) ?? 1,
        this.get(parms.BitsPerComponent) ?? 8);
    }
    return data;
  }

  /** 对象流（/Type /ObjStm）里还压着一批对象，展开后才找得到字体和页面。 */
  expandObjectStreams() {
    for (const num of [...this.objs.keys()]) {
      const d = this.object(num);
      if (!d || typeof d !== 'object' || this.get(d.Type)?.name !== 'ObjStm') continue;
      const data = this.stream(d);
      if (!data) continue;
      const s = data.toString('latin1');
      const n = this.get(d.N) ?? 0;
      const first = this.get(d.First) ?? 0;
      const head = new Lexer(s, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const objNum = Number(head.token());
        const off = Number(head.token());
        if (!Number.isFinite(objNum) || !Number.isFinite(off)) break;
        pairs.push([objNum, off]);
      }
      for (const [objNum, off] of pairs) {
        if (this.objs.has(objNum)) continue;        // The version that appears in the file itself wins.
        this.objs.set(objNum, { bodyAt: 0, parsed: new Lexer(s, first + off).value() });
      }
    }
  }

  pages() {
    const out = [];
    const root = [...this.objs.keys()].map((n) => this.object(n))
      .find((o) => o && typeof o === 'object' && this.get(o?.Type)?.name === 'Catalog');
    const visit = (node, inherited, depth) => {
      node = this.get(node);
      if (!node || typeof node !== 'object' || depth > 32) return;
      const inh = {
        Resources: node.Resources ?? inherited.Resources,
        MediaBox: node.MediaBox ?? inherited.MediaBox,
      };
      const kids = this.get(node.Kids);
      if (Array.isArray(kids)) { for (const k of kids) visit(k, inh, depth + 1); return; }
      if (this.get(node.Type)?.name === 'Page') out.push({ ...node, Resources: inh.Resources });
    };
    if (root) visit(root.Pages, {}, 0);
    if (out.length) return out;
    // No Catalog (rare, but it happens): fall back to scanning object numbers in order for /Type /Page.
    return [...this.objs.keys()].sort((a, b) => a - b)
      .map((n) => this.object(n))
      .filter((o) => o && typeof o === 'object' && this.get(o.Type)?.name === 'Page');
  }
}

/** PNG 预测器还原。压缩过的对象流/交叉引用流会用到。 */
function unpredict(data, columns, colors, bpc) {
  const bpp = Math.max(1, (colors * bpc) >> 3);
  const rowLen = ((columns * colors * bpc) + 7) >> 3;
  const out = [];
  let prev = Buffer.alloc(rowLen);
  for (let p = 0; p + 1 <= data.length; p += rowLen + 1) {
    const ft = data[p];
    const row = Buffer.from(data.subarray(p + 1, p + 1 + rowLen));
    if (row.length < rowLen) break;
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) row[i] = (row[i] + a) & 0xff;
      else if (ft === 2) row[i] = (row[i] + b) & 0xff;
      else if (ft === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    out.push(row);
    prev = row;
  }
  return Buffer.concat(out);
}

/**
 * 解析 /ToUnicode CMap：字形编码 -> Unicode。
 * 没有它就认不出中文 —— 嵌入子集字体的编码是每份文件自己一套，不能猜。
 */
function parseCMap(text) {
  const map = new Map();
  let codeLen = 2;
  const hex = (h) => parseInt(h, 16);
  const toStr = (h) => {
    let s = '';
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(hex(h.slice(i, i + 4)));
    return s;
  };
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      codeLen = e[1].length / 2;
      map.set(hex(e[1]), toStr(e[2]));
    }
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = m[1];
    for (const e of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      codeLen = e[1].length / 2;
      const lo = hex(e[1]), hi = hex(e[2]), dst = toStr(e[3]);
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        const last = dst.charCodeAt(dst.length - 1) + (c - lo);
        map.set(c, dst.slice(0, -1) + String.fromCharCode(last));
      }
    }
    for (const e of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      codeLen = e[1].length / 2;
      const lo = hex(e[1]);
      let i = 0;
      for (const d of e[3].matchAll(/<([0-9a-fA-F]+)>/g)) map.set(lo + i++, toStr(d[1]));
    }
  }
  return { map, codeLen };
}

function loadFonts(pdf, page) {
  const fonts = new Map();
  const res = pdf.get(page.Resources);
  const fdict = pdf.get(res?.Font);
  if (!fdict || typeof fdict !== 'object') return fonts;
  for (const [name, ref] of Object.entries(fdict)) {
    if (name.startsWith('__')) continue;
    const font = pdf.get(ref);
    if (!font || typeof font !== 'object') continue;
    const tu = pdf.get(font.ToUnicode);
    const data = tu ? pdf.stream(tu) : null;
    if (data) { fonts.set(name, parseCMap(data.toString('latin1'))); continue; }
    // Without a ToUnicode map, only /Encoding says how the bytes are encoded. Two real invoices were measured, one of
    // each: a 铁路电子客票 uses GBK-EUC-H (GBK bytes), a ride-hailing 全电发票 uses UniGB-UCS2-H (UTF-16BE code points).
    // An encoding this does not know is not forced into Chinese: latin1 mojibake is preferable, because mojibake is
    // recognisable upstream and a wrong guess is not.
    const enc = pdf.get(font.Encoding)?.name ?? '';
    const charset = /UCS2|UTF16|Identity/i.test(enc) ? 'utf-16be'
      : /GBK|GB-EUC|GB2312|GBpc|GBK2K/i.test(enc) ? 'gbk'
      : null;
    const sub = pdf.get(font.Subtype)?.name;
    fonts.set(name, { map: null, charset, codeLen: sub === 'Type0' ? 2 : 1 });
  }
  return fonts;
}

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

const decoderCache = new Map();
const decoders = (charset) => {
  if (!decoderCache.has(charset)) decoderCache.set(charset, new TextDecoder(charset));
  return decoderCache.get(charset);
};

/** 走一遍内容流，把 Tj/TJ 显示出来的文字连同位置收集起来。 */
function extractItems(pdf, content, fonts) {
  const items = [];
  const lx = new Lexer(content, 0);
  let tm = [1, 0, 0, 1, 0, 0], lm = tm, leading = 0, font = null, size = 1;
  // The graphics state matrix has to be tracked too: the real position is tm × ctm.
  // Ignoring cm was measured — every table cell is its own `q cm BT..ET Q`, so all three legs of an itinerary collapse
  // onto one line and the leg boundaries vanish on the spot.
  let ctm = [1, 0, 0, 1, 0, 0];
  const gs = [];
  const stack = [];

  const decode = (bytes) => {
    if (!font) return bytes;
    if (!font.map) {
      if (!font.charset) return bytes;
      try { return decoders(font.charset).decode(Buffer.from(bytes, 'latin1')); }
      catch { return bytes; }
    }
    let out = '';
    const step = font.codeLen;
    for (let i = 0; i + step <= bytes.length; i += step) {
      let code = 0;
      for (let k = 0; k < step; k++) code = (code << 8) | bytes.charCodeAt(i + k);
      out += font.map.get(code) ?? '';
    }
    return out;
  };
  // The font size counts the matrix scale in: joining a line later uses it to tell whether two pieces of text have a
  // space between them.
  const at = () => {
    const m = mul(tm, ctm);
    return { x: m[4], y: m[5], size: size * Math.hypot(m[0], m[1]) };
  };
  const show = (bytes) => {
    const text = decode(bytes);
    if (text) {
      const pos = at();
      items.push({ ...pos, width: advance(text, pos.size), text });
    }
  };
  const nextLine = (tx, ty) => { lm = mul([1, 0, 0, 1, tx, ty], lm); tm = lm; };

  for (;;) {
    const v = lx.value();
    if (v === null && lx.pos >= content.length) break;
    if (!v || typeof v !== 'object' || !('op' in v)) { stack.push(v); continue; }
    const op = v.op;
    const num = (i) => { const n = stack[stack.length - i]; return typeof n === 'number' ? n : 0; };
    switch (op) {
      case 'q': gs.push(ctm); break;
      case 'Q': ctm = gs.pop() ?? ctm; break;
      case 'cm': ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
      case 'BT': tm = lm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': {
        const n = stack[stack.length - 2];
        size = num(1);
        font = n && n.name ? fonts.get(n.name) ?? null : null;
        break;
      }
      case 'TL': leading = num(1); break;
      case 'Td': nextLine(num(2), num(1)); break;
      case 'TD': leading = -num(1); nextLine(num(2), num(1)); break;
      case 'Tm': tm = lm = [num(6), num(5), num(4), num(3), num(2), num(1)]; break;
      case 'T*': nextLine(0, -leading); break;
      case 'Tj': case '\'': case '"': {
        if (op !== 'Tj') nextLine(0, -leading);
        const s = stack[stack.length - 1];
        if (s && typeof s === 'object' && 'str' in s) show(s.str);
        break;
      }
      case 'TJ': {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          let out = '';
          for (const el of arr) {
            if (el && typeof el === 'object' && 'str' in el) out += decode(el.str);
            // A large enough negative kerning adjustment is a visible space; this decides where fields split later.
            else if (typeof el === 'number' && el <= -200) out += ' ';
          }
          if (out) {
            const pos = at();
            items.push({ ...pos, width: advance(out, pos.size), text: out });
          }
        }
        break;
      }
      default: break;
    }
    if (op) stack.length = 0;
    void size;
  }
  return items;
}

// A half-width character is about half the font size wide, a CJK full-width one a whole size. An estimate for width
// only; precision is not the point.
const advance = (text, size) => {
  let w = 0;
  for (const ch of text) w += /[\u2e80-\ufaff\uff00-\uffef]/.test(ch) ? size : size * 0.5;
  return w;
};

/**
 * 把带坐标的碎片拼成行：同一行按 x 排序，行间按 y 从上到下。
 * 两块文字之间**按估算的水平间隙**决定要不要补空格 ——
 * 有的发票逐字发字（曹操样本就是），无脑用空格拼会把发票号码打散成一串单数字。
 */
function layoutLines(items) {
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < 3);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    const sorted = l.items.sort((a, b) => a.x - b.x);
    let out = '';
    let cursor = null;
    for (const it of sorted) {
      if (cursor !== null && it.x - cursor > it.size * 0.28) out += ' ';
      out += it.text;
      cursor = it.x + (it.width ?? advance(it.text, it.size));
    }
    return { y: l.y, items: sorted, text: out.replace(/[ \t]+/g, ' ').trim() };
  }).filter((line) => line.text.length);
}

function layout(items) {
  return layoutLines(items).map((line) => line.text).join('\n');
}

/**
 * 从 PDF 字节里取出文本。
 * 返回 `{ text, pageCount, hasText, pages }`；取不出字时 `hasText` 为 false，
 * **这是一个事实，不是可以绕过的失败** —— 上层据此形成解析失败的待确认项。
 */
export function extractPdfText(buf) {
  let pdf;
  try { pdf = new Pdf(buf); } catch (err) { return { text: '', pageCount: 0, hasText: false, error: err.message }; }
  const pages = pdf.pages();
  const pageLayouts = [];
  for (const page of pages) {
    let contents = pdf.get(page.Contents);
    if (!contents) { pageLayouts.push({ text: '', lines: [] }); continue; }
    if (!Array.isArray(contents)) contents = [contents];
    let content = '';
    for (const c of contents) {
      const data = pdf.stream(pdf.get(c));
      if (data) content += data.toString('latin1') + '\n';
    }
    if (!content) { pageLayouts.push({ text: '', lines: [] }); continue; }
    let lines = [];
    try {
      lines = layoutLines(extractItems(pdf, content, loadFonts(pdf, page)));
    } catch (err) {
      lines = [];
    }
    pageLayouts.push({ text: lines.map((line) => line.text).join('\n'), lines });
  }
  const text = pageLayouts.map((page) => page.text).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pageCount: pages.length, hasText: text.length > 0, pages: pageLayouts };
}
