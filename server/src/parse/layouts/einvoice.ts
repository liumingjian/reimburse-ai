import { cents, compact, joinedRows, matchSpan, money, spans, spansAt, type JoinedRow, type ParseDoc, type TextObservation } from '../doc';
import { vatItemCategory } from '../kinds';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `vat_invoice/einvoice`: the 全电发票 (fully digital e-invoice) face, from the PDF text layer (or, with #186, OCR),
// with the QR code as a second evidence source `rule:vat_invoice/einvoice_qr` (ADR-0017).

const KIND = 'vat_invoice';
const NAME = 'einvoice';
const VERSION = '3';
const SOURCE = ruleSource(KIND, NAME);
export const QR_SOURCE = ruleSource(KIND, 'einvoice_qr');

// Hard anchors. Text is NFKC-normalised, so the face's full-width `（）：` read as `():`.
const TITLE = /^电子发票\((增值税专用发票|普通发票)\)$/;
const NUMBER = /^发票号码:(\d{20})$/;
const ISSUE_DATE = /^开票日期:(\d{4})年(\d{2})月(\d{2})日$/;
const ITEM_ROW = /^\*[^*]+\*/;
// The value is free text, so its span is read widest first: the narrowest match is the name's first text run, one
// character on a face that draws a company name glyph by glyph. A colon can only begin the next label on the same
// baseline — the buyer's 名称 and the seller's are printed side by side — so excluding it bounds the widest reading.
const PARTY_NAME = /^名称:([^:]+)$/;
const TAX_ID = /^(?:统一社会信用代码\/纳税人识别号:)?([0-9A-Z]{15,20})$/;
// The goods table's header cell, and the 价税合计 label that the amount follows. Both are matched against a span of
// their row, never against one text run: a real face draws either of them glyph by glyph.
const HEADER_CELL = /^项目名称$/;
const LOWER_LABEL = /^\(小写\)$/;

// Baselines drift on a real face: the 合计 label and its two amounts are printed 5 points apart, and the buyer's and
// the seller's 名称 differ by one and a half. Line pitch on these invoices is 12 points and more, so a row tolerance
// wider than the default still cannot swallow the line below.
const ROW_TOLERANCE = 5;

const TYPE_OF_TITLE: Readonly<Record<string, string>> = { 增值税专用发票: '专票', 普通发票: '普票' };
// 全电 QR 发票类型 codes: 31 电子发票（增值税专用发票）, 32 电子发票（普通发票）.
const TYPE_OF_QR: Readonly<Record<string, string>> = { '31': '专票', '32': '普票' };

const COLUMNS: Readonly<Record<string, string>> = { 项目名称: 'name', 单位: 'unit', 数量: 'qty', 单价: 'price', 金额: 'net', '税率/征收率': 'rate', 税额: 'tax' };

const FIELD_LABELS: Readonly<Record<string, string>> = { invoiceNumber: '发票号码', issueDate: '开票日期', totalAmount: '价税合计', invoiceType: '票种' };

// Wording is presented as printed (full-width brackets and all); only anchors and numbers use the normalised text.
const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

// A cell read as one string: its observations left to right, joined and compacted the way anchors are matched. Real
// faces draw an item name, a 合计 label and an amount glyph by glyph, so a cell is several observations, never one.
const cell = (list: readonly TextObservation[] | undefined) => compact((list ?? []).map((o) => o.text).join(''));
const visible = (list: readonly TextObservation[] | undefined) => compact((list ?? []).map((o) => o.raw).join(''));

// Item rows read off the joined rows: `*交通运输服务*客运服务费` is one row even when it is a dozen text runs.
function itemNames(lines: readonly JoinedRow[]): string[] {
  return lines.map((row) => row.text).filter((text) => ITEM_ROW.test(text));
}

type Row = { cells: Record<string, TextObservation[]>; name: string; y: number; height: number };

// How far below an item row the rest of its 项目名称 may be printed, as a multiple of the row's text height. An item
// name too long for its column is wrapped by the issuer, and the tail becomes a row of its own — text in the
// 项目名称 column and nothing in any other. It sits one line pitch under its item row; the 合计 row and the boxes
// below the table are several pitches away, so this bound keeps a name from swallowing them.
const WRAP_PITCH = 2;

const line = (observations: readonly TextObservation[]): JoinedRow => ({ page: observations[0]?.page ?? 1, y: observations[0]?.y ?? 0, text: cell(observations), observations });

// The table's columns, from the header row: each header's key and the x range its label is printed over. A header
// label is matched against a span of that row, not against one text run — real faces draw `单位` and `税额` glyph by
// glyph, which used to leave the table with two columns out of seven.
type Column = { key: string; x: number; right: number };
function columns(header: readonly TextObservation[]): Column[] {
  const out: Column[] = [];
  for (const span of spans(line(header))) {
    const key = COLUMNS[span.text];
    const first = span.observations[0];
    const last = span.observations.at(-1);
    if (key && first && last && !out.some((c) => c.key === key)) out.push({ key, x: first.x, right: last.x + last.width });
  }
  return out.sort((a, b) => a.x - b.x);
}

// One printed cell of a row: contiguous observations with no visible gap between them. A cell has to be assigned to its
// column as a whole. Assigning each observation on its own splits a right-aligned amount drawn glyph by glyph — the
// leading glyph's centre falls left of its own header while the rest fall right, so `264.15` reads as 数量 `2` and
// 单价 `64.15`, and the truncated remainder still parses as money.
function cellsOf(row: readonly TextObservation[]): TextObservation[][] {
  const out: TextObservation[][] = [];
  for (const o of row) {
    const group = out.at(-1);
    const previous = group?.at(-1);
    // Glyphs of one cell are drawn edge to edge; two cells are a cell padding apart. That gap is tighter than the one
    // between two fields of a form (`doc.ts`), which is why the table measures its own.
    const joined = previous ? o.x - (previous.x + previous.width) <= Math.max(previous.height, o.height) / 2 : false;
    if (group && joined) group.push(o);
    else out.push([o]);
  }
  return out;
}

// The column a cell belongs to.
//
// First, the header the cell shares ink with: a cell is printed under its own header, and a cell too wide for its
// column spills out of it rather than moving — a 单价 printed to thirteen decimals reaches back under 项目名称, and
// its centre is no longer anywhere near its own header. Overlap says where it belongs; the centre does not.
//
// Failing that, the right-most header starting at or left of the cell's centre: a narrow cell that shares ink with no
// header at all (one glyph of a 合计 label drawn apart from the other) belongs to the column it sits in. An amount is
// right-aligned under its header and a wide label such as 税率/征收率 reaches past the narrow `3%` printed under it,
// so the centre against the headers' left edges is the boundary both faces agree on.
//
// Failing that too, the leftmost column, but only for a cell that begins left of its header. A header label is centred
// over a column far wider than the label while the cell under it is left-aligned at the column's border: measured on
// the real corpus, the 项目名称 cell and the 合计 label of a ride-hailing face are drawn 10 to 60 points left of the
// 项目名称 header's own left edge, and leaving them in no column is what left `项目名称`, `不含税金额` and `税额`
// unread. Beginning at the border is what tells them apart from a cell that merely overflows to the left.
function columnOf(headers: readonly Column[], group: readonly TextObservation[]): string | null {
  const first = group[0];
  const last = group.at(-1);
  if (!first || !last) return null;
  const left = first.x;
  const right = last.x + last.width;
  let shared: Column | null = null;
  let widest = 0;
  for (const header of headers) {
    const overlap = Math.min(right, header.right) - Math.max(left, header.x);
    if (overlap > widest) {
      shared = header;
      widest = overlap;
    }
  }
  if (shared) return shared.key;
  const centre = (left + right) / 2;
  const under = headers.filter((h) => h.x <= centre).at(-1);
  if (under) return under.key;
  const leftmost = headers[0];
  return leftmost && left < leftmost.x ? leftmost.key : null;
}

// The goods table: each cell keeps every observation that lands in its column. Item rows run from the header down to
// the 合计 row. The header row is found by a span match, not by one text run carrying 项目名称: on a face that draws
// the header glyph by glyph there is no such run, and the whole table would go unread.
function table(doc: ParseDoc): { items: Row[]; total: Row | null } {
  const all = joinedRows(doc, 1, ROW_TOLERANCE);
  const headerAt = all.findIndex((row) => matchSpan([row], HEADER_CELL) !== null);
  if (headerAt < 0) return { items: [], total: null };
  const headers = columns(all[headerAt]?.observations ?? []);
  const toRow = (row: JoinedRow): Row => {
    const cells: Record<string, TextObservation[]> = {};
    for (const group of cellsOf(row.observations)) {
      const key = columnOf(headers, group);
      if (key) (cells[key] ??= []).push(...group);
    }
    return { cells, name: cell(cells['name']), y: row.y, height: Math.max(...row.observations.map((o) => o.height), 0) };
  };
  // The second line of a wrapped 项目名称: nothing outside the name column, and printed just under the item row it
  // belongs to. Its observations join that row's name cell, so the item is named as the face prints it.
  const wraps = (item: Row, entry: Row) => {
    const keys = Object.keys(entry.cells);
    const below = item.y - entry.y;
    return keys.length === 1 && keys[0] === 'name' && entry.name.length > 0 && below > 0 && below <= item.height * WRAP_PITCH;
  };
  const items: Row[] = [];
  for (const row of all.slice(headerAt + 1)) {
    const entry = toRow(row);
    if (entry.name === '合计') return { items, total: entry };
    if (ITEM_ROW.test(entry.name)) {
      items.push(entry);
      continue;
    }
    const item = items.at(-1);
    if (item && wraps(item, entry)) {
      (item.cells['name'] ??= []).push(...(entry.cells['name'] ?? []));
      item.name = cell(item.cells['name']);
    }
  }
  return { items, total: null };
}

// The widest run of text after （小写） that reads as an amount. The start is pinned to the first observation after the
// label and the widest reading wins: on a face that draws `¥560.00` glyph by glyph the narrowest reading is `0.00`, a
// fragment of the value dressed as a value. Nothing parseable there means the amount was not read, and the slot stays
// missing (ADR-0017: never back-calculated, never guessed).
function amountAfter(row: readonly TextObservation[], at: number): { value: number; observations: readonly TextObservation[] } | null {
  const rest = row.slice(at + 1);
  if (rest.length === 0) return null;
  for (const span of spansAt(line(rest), 0)) {
    const value = cents(span.text);
    if (value !== null) return { value, observations: span.observations };
  }
  return null;
}

// 价税合计: the widest amount printed after （小写） on that row. The label itself is a span too — it is drawn
// `(`,`小`,`写`,`)` on a real face — so the amount starts at the observation after the span, not after one text run.
function grossAmount(lines: readonly JoinedRow[]): { value: number; observations: readonly TextObservation[] } | null {
  for (const row of lines) {
    const label = matchSpan([row], LOWER_LABEL);
    const last = label?.span.observations.at(-1);
    const at = last ? row.observations.indexOf(last) : -1;
    if (at >= 0) return amountAfter(row.observations, at);
  }
  return null;
}

type PartyName = { observations: readonly TextObservation[]; x: number; y: number };

// A party's 名称 is a span: real faces draw the label and the company name as separate text runs, and print the
// buyer's pair and the seller's pair on one baseline, so neither a single observation nor the whole row is the label's
// haystack. Each start on the row is tried once and takes its widest match, so the label binds to the whole name drawn
// after it and stops where the seller's box begins.
function partyNames(lines: readonly JoinedRow[]): PartyName[] {
  const found: PartyName[] = [];
  for (const row of lines) {
    for (let start = 0; start < row.observations.length; start += 1) {
      for (const span of spansAt(row, start)) {
        const first = span.observations[0];
        if (!first || !PARTY_NAME.test(span.text)) continue;
        found.push({ observations: span.observations, x: first.x, y: first.y });
        break;
      }
    }
  }
  return found.sort((a, b) => a.x - b.x);
}

function parties(doc: ParseDoc, lines: readonly JoinedRow[]) {
  const names = partyNames(lines);
  const ids = doc.observations.filter((o) => TAX_ID.test(compact(o.text)));
  // The tax id printed nearest below a party's 名称 line belongs to that party.
  const idOf = (name: PartyName) =>
    ids.filter((o) => o.y < name.y && name.y - o.y < 60).sort((a, b) => Math.abs(a.x - name.x) + (name.y - a.y) - (Math.abs(b.x - name.x) + (name.y - b.y)))[0];
  const party = (name: PartyName | undefined) => (name ? { name, id: idOf(name) } : null);
  return names.length === 2 ? { buyer: party(names[0]), seller: party(names[1]) } : { buyer: null, seller: null };
}

// 全电 QR payload: `01,<发票类型>,<发票代码>,<发票号码>,<金额>,<开票日期 YYYYMMDD>,<校验码>,<CRC>`; for a 全电发票
// the amount is the 价税合计.
export function readQr(payload: string): Record<string, string> | null {
  const match = /^01,(\d{2}),[^,]*,(\d{20}),(\d+(?:\.\d{1,2})?),(\d{4})(\d{2})(\d{2}),/.exec(payload.trim());
  if (!match) return null;
  const amount = cents(Number(match[3]).toFixed(2));
  const values: Record<string, string> = { invoiceNumber: match[2] ?? '', issueDate: `${match[4]}-${match[5]}-${match[6]}` };
  if (amount !== null) values['totalAmount'] = money(amount);
  const type = TYPE_OF_QR[match[1] ?? ''];
  if (type) values['invoiceType'] = type;
  return values;
}

export const einvoice: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '全电发票',

  recognise(doc) {
    const lines = joinedRows(doc, 1, ROW_TOLERANCE);
    // v1 kinds cover lodging and ride-hailing only; an e-invoice for anything else (e.g. 餐饮) is not this layout. One
    // such row is enough: real ride-hailing invoices bundle unrelated fee rows (服务费, 经纪代理服务) beside it.
    return Boolean(matchSpan(lines, TITLE) && matchSpan(lines, NUMBER)) && itemNames(lines).some((item) => vatItemCategory(item) !== null);
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, evidence: readonly TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(evidence) });
    };

    // Title, 发票号码 and 开票日期 read from row spans: a letter-spaced title, or a label and its value drawn as
    // separate text runs, are one span even though they are several observations — and a span, unlike the whole row,
    // does not have to swallow the field printed beside it on the same baseline.
    const lines = joinedRows(doc, 1, ROW_TOLERANCE);
    const title = matchSpan(lines, TITLE);
    const type = title ? TYPE_OF_TITLE[title.match[1] ?? ''] : undefined;
    const number = matchSpan(lines, NUMBER);
    const date = matchSpan(lines, ISSUE_DATE);
    add('invoiceNumber', number?.match[1], number?.span.observations ?? []);
    add('issueDate', date ? `${date.match[1]}-${date.match[2]}-${date.match[3]}` : null, date?.span.observations ?? []);
    add('invoiceType', type, title?.span.observations ?? []);

    const { buyer, seller } = parties(doc, lines);
    for (const [prefix, party] of [['buyer', buyer], ['seller', seller]] as const) {
      if (!party) continue;
      add(`${prefix}Name`, visible(party.name.observations).replace(/^名称[:：]/, ''), party.name.observations);
      if (party.id) add(`${prefix}TaxId`, TAX_ID.exec(compact(party.id.text))?.[1], [party.id]);
    }

    const { items, total } = table(doc);
    // The item row that decides the category: a bundled fee row may be printed first, and it is not what this invoice
    // is for. With no v1 row among the cells there is nothing to name — recognition read the joined rows, the table
    // reads the name column, and when the two disagree the honest outcome is a missing 项目名称, not the row that
    // happens to be printed first.
    const priced = items.find((row) => vatItemCategory(row.name));
    if (priced) add('itemName', visible(priced.cells['name']), priced.cells['name'] ?? []);
    // A recognised invoice may bundle a row outside the v1 kinds (#201): a 服务费 or 经纪代理服务 line printed beside
    // the ride. The 合计 row covers both, so the reimbursed 价税合计 includes it — advisory, so the user sees it
    // instead of the silence. No kind, category or amount changes.
    const bundled = items.filter((row) => !vatItemCategory(row.name)).map((row) => visible(row.cells['name'])).filter(Boolean);
    if (priced && bundled.length > 0) {
      findings.push({ kind: 'advisory', code: 'bundled_items', message: `这张发票还开了：${bundled.join('、')}，价税合计把它们一起算了。` });
    }
    const netCell = total?.cells['net'];
    const taxCell = total?.cells['tax'];
    const net = netCell ? cents(cell(netCell)) : null;
    const tax = taxCell ? cents(cell(taxCell)) : null;
    if (net !== null && netCell) add('netAmount', money(net), netCell);
    if (tax !== null && taxCell) add('taxAmount', money(tax), taxCell);

    const grossAt = grossAmount(lines);
    const gross = grossAt?.value ?? null;
    if (gross !== null && grossAt) add('totalAmount', money(gross), grossAt.observations);

    // Deterministic checks: the rows sum to the 合计 row, and net + tax = 价税合计, to the cent.
    const sum = (key: string) => items.reduce((acc, row) => acc + (cents(cell(row.cells[key])) ?? 0), 0);
    if (net !== null && tax !== null && (sum('net') !== net || sum('tax') !== tax)) {
      findings.push({ kind: 'validation', code: 'rows_not_conserved', message: `明细行加起来是 ${money(sum('net'))} + ${money(sum('tax'))}，和合计行 ${money(net)} + ${money(tax)} 对不上。` });
    }
    if (net !== null && tax !== null && gross !== null && net + tax !== gross) {
      findings.push({ kind: 'validation', code: 'total_not_conserved', message: `不含税金额 ${money(net)} + 税额 ${money(tax)} ≠ 价税合计 ${money(gross)}。` });
    }

    // The QR code: a second source for number, date, 价税合计 and 票种. Undecodable is advisory only.
    const qr = doc.codes.map(readQr).find((values) => values !== null) ?? null;
    if (!qr) {
      findings.push({ kind: 'advisory', code: 'qr_unreadable', message: '二维码无法识读，仅作提示：以 PDF 文本层为准' });
    } else {
      const face = new Map(candidates.map((c) => [c.key, c.value]));
      const agreed: string[] = [];
      for (const [key, value] of Object.entries(qr)) {
        candidates.push({ key, value, source: QR_SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: [] });
        const text = face.get(key);
        if (text === undefined) continue;
        if (text === value) agreed.push(FIELD_LABELS[key] ?? key);
        else findings.push({ kind: 'conflict', key, values: [{ source: SOURCE, value: text }, { source: QR_SOURCE, value }] });
      }
      if (!findings.some((f) => f.kind === 'conflict')) findings.push({ kind: 'advisory', code: 'qr_match', message: `二维码核对一致：${agreed.join('、')}` });
    }

    return { kindLabel: type ? `全电发票（${type}）` : '全电发票', candidates, findings };
  },
};
