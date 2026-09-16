import { cents, compact, money, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `vat_invoice/einvoice`: the 全电发票 (fully digital e-invoice) face, from the PDF text layer (or, with #186, OCR),
// with the QR code as a second evidence source `rule:vat_invoice/einvoice_qr` (ADR-0017).

const KIND = 'vat_invoice';
const NAME = 'einvoice';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
export const QR_SOURCE = ruleSource(KIND, 'einvoice_qr');

// Hard anchors. Text is NFKC-normalised, so the face's full-width `（）：` read as `():`.
const TITLE = /^电子发票\((增值税专用发票|普通发票)\)$/;
const NUMBER = /^发票号码:(\d{20})$/;
const ISSUE_DATE = /^开票日期:(\d{4})年(\d{2})月(\d{2})日$/;
const ITEM_ROW = /^\*[^*]+\*/;
// v1 kinds cover lodging and ride-hailing only; an e-invoice for anything else (e.g. 餐饮) is not this layout.
// One such row is enough: real ride-hailing invoices bundle unrelated fee rows (服务费, 经纪代理服务) beside it.
const V1_ITEM = /^\*(住宿服务|运输服务)\*/;
const PARTY_NAME = /^名称:(.+)$/;
const TAX_ID = /^(?:统一社会信用代码\/纳税人识别号:)?([0-9A-Z]{15,20})$/;

const TYPE_OF_TITLE: Readonly<Record<string, string>> = { 增值税专用发票: '专票', 普通发票: '普票' };
// 全电 QR 发票类型 codes: 31 电子发票（增值税专用发票）, 32 电子发票（普通发票）.
const TYPE_OF_QR: Readonly<Record<string, string>> = { '31': '专票', '32': '普票' };

const COLUMNS: Readonly<Record<string, string>> = { 项目名称: 'name', 单位: 'unit', 数量: 'qty', 单价: 'price', 金额: 'net', '税率/征收率': 'rate', 税额: 'tax' };

const FIELD_LABELS: Readonly<Record<string, string>> = { invoiceNumber: '发票号码', issueDate: '开票日期', totalAmount: '价税合计', invoiceType: '票种' };

const find = (doc: ParseDoc, pattern: RegExp) => doc.observations.find((o) => pattern.test(compact(o.text)));
// Wording is presented as printed (full-width brackets and all); only anchors and numbers use the normalised text.
const visible = (o: TextObservation) => compact(o.raw);
const ref = (...observations: TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

function itemNames(doc: ParseDoc): string[] {
  return doc.observations.map((o) => compact(o.text)).filter((text) => ITEM_ROW.test(text));
}

type Row = { cells: Record<string, TextObservation>; first: TextObservation };

// The goods table: columns come from the header row; each cell belongs to the right-most header starting at or left of
// it (amounts are right-aligned past their header). Item rows run from the header down to the 合计 row.
function table(doc: ParseDoc): { items: Row[]; total: Row | null } {
  const all = rows(doc);
  const headerAt = all.findIndex((row) => row.some((o) => compact(o.text) === '项目名称'));
  if (headerAt < 0) return { items: [], total: null };
  const headers = (all[headerAt] ?? []).flatMap((o) => (COLUMNS[compact(o.text)] ? [{ key: COLUMNS[compact(o.text)] ?? '', x: o.x }] : []));
  const toRow = (row: TextObservation[]): Row => {
    const cells: Record<string, TextObservation> = {};
    for (const o of row) {
      const column = headers.filter((h) => h.x <= o.x + 2).at(-1);
      if (column && !cells[column.key]) cells[column.key] = o;
    }
    return { cells, first: row[0] as TextObservation };
  };
  const items: Row[] = [];
  for (const row of all.slice(headerAt + 1)) {
    const head = compact(row[0]?.text ?? '');
    if (head === '合计') return { items, total: toRow(row) };
    if (ITEM_ROW.test(head)) items.push(toRow(row));
  }
  return { items, total: null };
}

function parties(doc: ParseDoc) {
  const names = doc.observations.filter((o) => PARTY_NAME.test(compact(o.text))).sort((a, b) => a.x - b.x);
  const ids = doc.observations.filter((o) => TAX_ID.test(compact(o.text)));
  // The tax id printed nearest below a party's 名称 line belongs to that party.
  const idOf = (name: TextObservation) =>
    ids.filter((o) => o.y < name.y && name.y - o.y < 60).sort((a, b) => Math.abs(a.x - name.x) + (name.y - a.y) - (Math.abs(b.x - name.x) + (name.y - b.y)))[0];
  const party = (name: TextObservation | undefined) => (name ? { name, id: idOf(name) } : null);
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
    const items = itemNames(doc);
    return Boolean(find(doc, TITLE) && find(doc, NUMBER)) && items.some((item) => V1_ITEM.test(item));
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, ...evidence: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(...evidence) });
    };

    const title = find(doc, TITLE);
    const type = title ? TYPE_OF_TITLE[TITLE.exec(compact(title.text))?.[1] ?? ''] : undefined;
    const number = find(doc, NUMBER);
    const date = find(doc, ISSUE_DATE);
    const dateParts = date ? ISSUE_DATE.exec(compact(date.text)) : null;
    add('invoiceNumber', number ? NUMBER.exec(compact(number.text))?.[1] : null, ...(number ? [number] : []));
    add('issueDate', dateParts ? `${dateParts[1]}-${dateParts[2]}-${dateParts[3]}` : null, ...(date ? [date] : []));
    add('invoiceType', type, ...(title ? [title] : []));

    const { buyer, seller } = parties(doc);
    for (const [prefix, party] of [['buyer', buyer], ['seller', seller]] as const) {
      if (!party) continue;
      add(`${prefix}Name`, visible(party.name).replace(/^名称[:：]/, ''), party.name);
      if (party.id) add(`${prefix}TaxId`, TAX_ID.exec(compact(party.id.text))?.[1], party.id);
    }

    const { items, total } = table(doc);
    const first = items[0];
    if (first) add('itemName', visible(first.first), first.first);
    const netCell = total?.cells['net'];
    const taxCell = total?.cells['tax'];
    const net = netCell ? cents(netCell.text) : null;
    const tax = taxCell ? cents(taxCell.text) : null;
    if (net !== null && netCell) add('netAmount', money(net), netCell);
    if (tax !== null && taxCell) add('taxAmount', money(tax), taxCell);

    // 价税合计: the amount after （小写） on the same row.
    const words = rows(doc).find((row) => row.some((o) => compact(o.text) === '(小写)'));
    const grossCell = words?.find((o, i) => i > words.findIndex((w) => compact(w.text) === '(小写)') && cents(o.text) !== null);
    const gross = grossCell ? cents(grossCell.text) : null;
    if (gross !== null && grossCell) add('totalAmount', money(gross), grossCell);

    // Deterministic checks: the rows sum to the 合计 row, and net + tax = 价税合计, to the cent.
    const sum = (key: string) => items.reduce((acc, row) => acc + (cents(row.cells[key]?.text ?? '') ?? 0), 0);
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
