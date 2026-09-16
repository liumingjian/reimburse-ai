import { cents, compact, joinedRows, matchSpan, money, rows, spans, type JoinedRow, type ParseDoc, type TextObservation } from '../doc';
import { vatItemCategory } from '../kinds';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `vat_invoice/einvoice`: the 全电发票 (fully digital e-invoice) face, from the PDF text layer (or, with #186, OCR),
// with the QR code as a second evidence source `rule:vat_invoice/einvoice_qr` (ADR-0017).

const KIND = 'vat_invoice';
const NAME = 'einvoice';
const VERSION = '2';
const SOURCE = ruleSource(KIND, NAME);
export const QR_SOURCE = ruleSource(KIND, 'einvoice_qr');

// Hard anchors. Text is NFKC-normalised, so the face's full-width `（）：` read as `():`.
const TITLE = /^电子发票\((增值税专用发票|普通发票)\)$/;
const NUMBER = /^发票号码:(\d{20})$/;
const ISSUE_DATE = /^开票日期:(\d{4})年(\d{2})月(\d{2})日$/;
const ITEM_ROW = /^\*[^*]+\*/;
const PARTY_NAME = /^名称:(.+)$/;
const TAX_ID = /^(?:统一社会信用代码\/纳税人识别号:)?([0-9A-Z]{15,20})$/;

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

type Row = { cells: Record<string, TextObservation[]>; name: string };

const line = (observations: readonly TextObservation[]): JoinedRow => ({ page: observations[0]?.page ?? 1, y: observations[0]?.y ?? 0, text: cell(observations), observations });
// The table's columns, from the header row: each header's key and where it starts. A header label is matched against a
// span of that row, not against one text run — real faces draw `单位` and `税额` glyph by glyph, which used to leave
// the table with two columns out of seven.
function columns(header: readonly TextObservation[]): { key: string; x: number }[] {
  const out: { key: string; x: number }[] = [];
  for (const span of spans(line(header))) {
    const key = COLUMNS[span.text];
    const first = span.observations[0];
    if (key && first && !out.some((c) => c.key === key)) out.push({ key, x: first.x });
  }
  return out.sort((a, b) => a.x - b.x);
}

// The column a cell belongs to: the right-most header starting at or left of the cell's centre, and the first column
// for whatever is printed left of every header. An amount is right-aligned under its header — it starts left of the
// header's own left edge and ends right of it — while a wide label such as 税率/征收率 reaches past the narrow `3%`
// printed under it, so the cell's centre against the headers' left edges is the boundary both faces agree on.
const columnOf = (headers: readonly { key: string; x: number }[], o: TextObservation) =>
  headers.filter((h) => h.x <= o.x + o.width / 2).at(-1)?.key ?? headers[0]?.key ?? null;

// The goods table: each cell keeps every observation that lands in its column. Item rows run from the header down to
// the 合计 row.
function table(doc: ParseDoc): { items: Row[]; total: Row | null } {
  const all = rows(doc, 1, ROW_TOLERANCE);
  const headerAt = all.findIndex((row) => row.some((o) => compact(o.text) === '项目名称'));
  if (headerAt < 0) return { items: [], total: null };
  const headers = columns(all[headerAt] ?? []);
  const toRow = (row: TextObservation[]): Row => {
    const cells: Record<string, TextObservation[]> = {};
    for (const o of row) {
      const key = columnOf(headers, o);
      if (key) (cells[key] ??= []).push(o);
    }
    return { cells, name: cell(cells['name']) };
  };
  const items: Row[] = [];
  for (const row of all.slice(headerAt + 1)) {
    const entry = toRow(row);
    if (entry.name === '合计') return { items, total: entry };
    if (ITEM_ROW.test(entry.name)) items.push(entry);
  }
  return { items, total: null };
}

// The narrowest run of text after （小写） that reads as an amount. `spans()` is shortest-first, so a glyph-by-glyph
// `¥26.69` binds as one amount and never swallows what is printed beside it.
function amountAfter(row: readonly TextObservation[], at: number): { value: number; observations: readonly TextObservation[] } | null {
  for (const span of spans(line(row.slice(at + 1)))) {
    const value = cents(span.text);
    if (value !== null) return { value, observations: span.observations };
  }
  return null;
}

type PartyName = { observations: readonly TextObservation[]; x: number; y: number };

// A party's 名称 is a span: real faces draw the label and the company name as separate text runs, and print the
// buyer's pair and the seller's pair on one baseline, so neither a single observation nor the whole row is the label's
// haystack. Spans are shortest first, so the label binds to the run of text right after it.
function partyNames(lines: readonly JoinedRow[]): PartyName[] {
  const found = new Map<string, PartyName>();
  for (const row of lines) {
    for (const span of spans(row)) {
      const first = span.observations[0];
      if (!first || found.has(first.id) || !PARTY_NAME.test(span.text)) continue;
      found.set(first.id, { observations: span.observations, x: first.x, y: first.y });
    }
  }
  return [...found.values()].sort((a, b) => a.x - b.x);
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
    // is for. Without a v1 row at all (manual fill, a face this layout no longer recognises) the first row still names
    // the goods.
    const priced = items.find((row) => vatItemCategory(row.name)) ?? items[0];
    if (priced) add('itemName', visible(priced.cells['name']), priced.cells['name'] ?? []);
    const netCell = total?.cells['net'];
    const taxCell = total?.cells['tax'];
    const net = netCell ? cents(cell(netCell)) : null;
    const tax = taxCell ? cents(cell(taxCell)) : null;
    if (net !== null && netCell) add('netAmount', money(net), netCell);
    if (tax !== null && taxCell) add('taxAmount', money(tax), taxCell);

    // 价税合计: the amount after （小写） on the same row.
    const words = rows(doc, 1, ROW_TOLERANCE).find((row) => row.some((o) => compact(o.text) === '(小写)'));
    const grossAt = words ? amountAfter(words, words.findIndex((w) => compact(w.text) === '(小写)')) : null;
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
