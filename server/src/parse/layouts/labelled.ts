import { cents, compact, money, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `hotel_folio/labelled`: a hotel 结账单 (folio) of any chain, read through the field labels every folio prints, from a
// PDF text layer or a photo. A folio is reference material: it proves the stay dates of a hotel invoice and is never an
// invoice itself (kernel `parse.mjs` hotel_folio rules).
//
// Recognition does not look at the chain name (#211): on a photo the name is never one contiguous text observation,
// and the brand is incidental to what a folio proves. On a PDF a label and its value usually arrive as one text run;
// on a photo they are separate boxes, so each value is read by position from its label (as `taxi_receipt/
// machine_printed` does). A value that cannot be read stays missing: nothing is back-calculated (ADR-0017).

const KIND = 'hotel_folio';
const NAME = 'labelled';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);

// Hard anchors, on NFKC text without whitespace: the folio title and all four accommodation labels. The title alone
// is generic (restaurants print 结账单 too), so it never recognises on its own.
const TITLE = /^结账单/;
const LABELS = {
  checkIn: '入住日期',
  checkOut: '离店日期',
  roomNumber: '房号',
  folioTotal: '消费合计',
  guestName: '入住人',
  nights: '天数',
  roomRate: '房价',
  paidAmount: '已付款(预授权结算)',
} as const;
const ANCHOR_LABELS = [LABELS.checkIn, LABELS.checkOut, LABELS.roomNumber, LABELS.folioTotal] as const;

// Where a value may sit relative to its label, as multiples of the label's own text height (a photo's pixel scale
// depends on the camera, a PDF's on the font): right of the label with its vertical centre within this band, else the
// box directly below the label with at most this gap. A folio's rows are about 1.1 text heights apart, so half a
// height keeps a value from binding to the label on the neighbouring row.
const ROW_BAND = 0.5;
const BELOW_GAP = 1;

// The date shapes a folio value may take. Each is fully anchored; a value matching none leaves the date missing — no
// looser pattern is tried after these, and the matched digits must still be a calendar date.
const DATE_SHAPES: readonly RegExp[] = [
  // ISO, as the PDF text layer prints it: 2026-08-09.
  /^(\d{4})-(\d{2})-(\d{2})$/,
  // Slashed: 2026/08/09 or 2026/8/9.
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  // Dotted: 2026.08.09 or 2026.8.9.
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/,
  // Chinese: 2026年08月09日 or 2026年8月9日.
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  // Compact digits: 20260809. Also how OCR returns an ISO date whose hyphens it did not see.
  /^(\d{4})(\d{2})(\d{2})$/,
  // An ISO date with the second hyphen unseen by OCR: 2026-0809.
  /^(\d{4})-(\d{2})(\d{2})$/,
  // An ISO date with the first hyphen unseen by OCR: 202608-09.
  /^(\d{4})(\d{2})-(\d{2})$/,
];

// A hotel's name as a folio heads it: ending in a generic lodging word, optionally with its branch in parentheses.
// Not a chain list; it is only read above the 入住日期 label, where the folio header is.
const HOTEL_NAME = /^[^:]{2,}(?:酒店|宾馆|饭店|旅馆|客栈)(?:\(.+\))?$/;
const NIGHTS = /^(\d+)$/;
const RATE = /^([\d,]+\.\d{2})/;
const CHARGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const find = (doc: ParseDoc, pattern: RegExp) => doc.observations.find((o) => pattern.test(compact(o.text)));
const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

const centre = (o: TextObservation) => o.y + o.height / 2;
const allLabels = Object.values(LABELS);
const stripLabel = (text: string, label: string) => compact(text).slice(label.length).replace(/^[:：]/, '');

// The box that carries a label: the label alone (with or without its colon), or the label and its value in one run.
function labelOf(doc: ParseDoc, label: string): TextObservation | undefined {
  return doc.observations.find((o) => compact(o.text).startsWith(label));
}

type Read = { text: string; raw: string; observations: TextObservation[] };

// A label's value: in the label's own box when OCR or the text layer kept them together; else the nearest box right of
// the label within its row band; else the box directly below it within the gap. A box that is itself a label is never
// a value.
function valueOf(doc: ParseDoc, label: string): Read | null {
  const box = labelOf(doc, label);
  if (!box) return null;
  const rest = stripLabel(box.text, label);
  if (rest) return { text: rest, raw: stripLabel(box.raw, label), observations: [box] };
  const others = doc.observations.filter((o) => o !== box && o.page === box.page && !allLabels.some((l) => compact(o.text).startsWith(l)));
  const right = others
    .filter((o) => o.x >= box.x + box.width && Math.abs(centre(o) - centre(box)) <= box.height * ROW_BAND)
    .sort((a, b) => a.x - b.x)[0];
  const below = others
    .filter((o) => {
      const gap = box.y - (o.y + o.height);
      return gap >= -box.height * ROW_BAND && gap <= box.height * BELOW_GAP && o.y < box.y && o.x < box.x + box.width && o.x + o.width > box.x;
    })
    .sort((a, b) => b.y - a.y)[0];
  const value = right ?? below;
  return value ? { text: compact(value.text), raw: compact(value.raw), observations: [box, value] } : null;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// A value in one of `DATE_SHAPES` that is a calendar date, as `YYYY-MM-DD`; null otherwise.
function dateOf(text: string): string | null {
  for (const shape of DATE_SHAPES) {
    const match = shape.exec(text);
    if (!match) continue;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    return validDate(year, month, day) ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
  }
  return null;
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// The charge rows: each row between the 日期/项目/金额 header and 消费合计 that starts with a date, its amount right-most.
// PDF only: per-night charge rows are not read from a photo (#211 non-goal). Null when the table is not there.
function charges(doc: ParseDoc): number[] | null {
  if (doc.mediaType !== 'pdf') return null;
  const all = rows(doc);
  const headerAt = all.findIndex((row) => row.some((o) => compact(o.text) === '项目') && row.some((o) => compact(o.text) === '金额'));
  if (headerAt < 0) return null;
  const out: number[] = [];
  for (const row of all.slice(headerAt + 1)) {
    if (row.some((o) => compact(o.text) === LABELS.folioTotal)) break;
    const amount = cents(row.at(-1)?.text ?? '');
    if (CHARGE_DATE.test(compact(row[0]?.text ?? '')) && amount !== null) out.push(amount);
  }
  return out;
}

export const labelled: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '酒店结账单',

  recognise(doc) {
    return Boolean(find(doc, TITLE)) && ANCHOR_LABELS.every((label) => labelOf(doc, label) !== undefined);
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, observations: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(observations) });
      return value ?? null;
    };
    const read = (key: keyof typeof LABELS) => valueOf(doc, LABELS[key]);
    const amount = (key: 'folioTotal' | 'paidAmount') => {
      const value = read(key);
      const parsed = value ? cents(value.text) : null;
      if (value && parsed !== null) add(key, money(parsed), value.observations);
      return parsed;
    };

    const checkInLabel = labelOf(doc, LABELS.checkIn);
    const hotel = doc.observations.find((o) => HOTEL_NAME.test(compact(o.text)) && checkInLabel && o.page === checkInLabel.page && o.y > checkInLabel.y);
    if (hotel) add('hotelName', compact(hotel.raw), [hotel]);
    for (const key of ['guestName', 'roomNumber'] as const) {
      const value = read(key);
      if (value) add(key, value.raw, value.observations);
    }
    const dates: Record<'checkIn' | 'checkOut', string | null> = { checkIn: null, checkOut: null };
    for (const key of ['checkIn', 'checkOut'] as const) {
      const value = read(key);
      if (value) dates[key] = add(key, dateOf(value.text), value.observations);
    }
    const nightsValue = read('nights');
    const nightsText = nightsValue ? add('nights', NIGHTS.exec(nightsValue.text)?.[1], nightsValue.observations) : null;
    const rateValue = read('roomRate');
    const rate = rateValue ? cents(RATE.exec(rateValue.text)?.[1] ?? '') : null;
    if (rateValue && rate !== null) add('roomRate', money(rate), rateValue.observations);
    const total = amount('folioTotal');
    amount('paidAmount');

    // Deterministic checks: the dates span the printed nights; the charge rows add up to 消费合计, to the cent.
    const { checkIn, checkOut } = dates;
    const nights = nightsText ? Number(nightsText) : null;
    if (checkIn && checkOut && nights !== null && daysBetween(checkIn, checkOut) !== nights) {
      findings.push({ kind: 'validation', code: 'nights_mismatch', message: `入住 ${checkIn} 到离店 ${checkOut} 是 ${daysBetween(checkIn, checkOut)} 晚，结账单写的是 ${nights} 晚。` });
    }
    const rowAmounts = charges(doc);
    const rowsTotal = rowAmounts?.reduce((acc, value) => acc + value, 0) ?? null;
    if (total !== null && rowsTotal !== null && rowsTotal !== total) {
      findings.push({ kind: 'validation', code: 'charges_not_conserved', message: `消费明细加起来是 ${money(rowsTotal)}，和消费合计 ${money(total)} 对不上。` });
    }

    return { kindLabel: '酒店结账单', candidates, findings };
  },
};
