import { cents, daysBetween, money } from '../../money-date';
import { compact, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `hotel_folio/labelled`: a hotel 结账单 or 水单 (folio) of any hotel, read through its field labels, from a PDF text
// layer or a photo. A folio is reference material: it proves the stay dates of a hotel invoice and is never an
// invoice itself (kernel `parse.mjs` hotel_folio rules).
//
// Recognition does not look at the chain name (#211) or the title: on a photo the name is never one contiguous text
// observation, many a 水单 prints no 结账单 title at all, and neither is what a folio proves. On a PDF a label
// and its value usually arrive as one text run, sometimes several fields to a run (`入住日期:…,房号:…`); on a photo
// they are separate boxes, so each value is read by position from its label (as `taxi_receipt/machine_printed` does).
// A value that cannot be read stays missing: no amount is back-calculated (ADR-0017), and no date or 天数 (nights) is
// derived from the others (#212).

const KIND = 'hotel_folio';
const NAME = 'labelled';
const VERSION = '2';
const SOURCE = ruleSource(KIND, NAME);
const LABEL = '酒店结账单';

// Each field under the labels hotels print for it, on NFKC text without whitespace; the first that a document carries
// is the one read. Hard anchors: the three fields a folio exists to prove — check-in, check-out and the total — each
// under one of its labels. A restaurant's 结账单 prints a total but no stay dates, so it never recognises.
const LABELS = {
  checkIn: ['入住日期', '到店日期', '抵店日期'],
  checkOut: ['离店日期', '退房日期'],
  roomNumber: ['房号', '房间号'],
  folioTotal: ['消费合计', '收费', '费用合计'],
  guestName: ['入住人', '姓名', '宾客姓名'],
  nights: ['天数'],
  roomRate: ['房价'],
  paidAmount: ['已付款(预授权结算)'],
} as const satisfies Record<string, readonly string[]>;
type Field = keyof typeof LABELS;
const ANCHORS: readonly Field[] = ['checkIn', 'checkOut', 'folioTotal'];

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
  // Hyphen then dot, with or without 日: 2026-9.16, 2026-9.16日.
  /^(\d{4})-(\d{1,2})\.(\d{1,2})日?$/,
];

// A hotel's name as a folio heads it: ending in a generic lodging word, optionally with its branch in parentheses.
// Not a chain list; it is only read above the 入住日期 label, where the folio header is.
const HOTEL_NAME = /^[^:]{2,}(?:酒店|宾馆|饭店|旅馆|客栈)(?:\(.+\))?$/;
const NIGHTS = /^(\d+)$/;
const RATE = /^([\d,]+\.\d{2})/;
const CHARGE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A room number printed with words after it (`1426入住2天`) is its leading number; one that starts with words (`A栋1208`)
// is kept whole.
const ROOM = /^[A-Za-z]?\d[\dA-Za-z-]*/;

const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

const centre = (o: TextObservation) => o.y + o.height / 2;
const allLabels: readonly string[] = Object.values(LABELS).flat();

// A run's `label:value` fields. It splits at a comma or semicolon that a label follows, so `入住日期:…,房号:1426` is two
// fields and `消费合计:3,640.00` stays one.
function fields(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (/[,;，；]/.test(text[i] ?? '') && allLabels.some((label) => text.startsWith(label, i + 1))) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, text.slice(start)];
}

// What a run carries under `label`: '' for the label alone, the value for the label, its colon and a value in one
// field; null when the run does not carry it. A longer word that only starts with the label (`房号类型`) is not that
// label.
function carried(text: string, label: string): string | null {
  for (const field of fields(compact(text))) {
    if (field === label) return '';
    if (field.startsWith(label) && /^[:：]/.test(field.slice(label.length))) return field.slice(label.length + 1);
  }
  return null;
}
const carries = (o: TextObservation, label: string) => carried(o.text, label) !== null;
const labelOf = (doc: ParseDoc, field: Field): { box: TextObservation; label: string } | undefined => {
  for (const label of LABELS[field]) {
    const box = doc.observations.find((o) => carries(o, label));
    if (box) return { box, label };
  }
  return undefined;
};

type Read = { text: string; raw: string; observations: TextObservation[] };

// A field's value: in the label's own run when OCR or the text layer kept them together; else the nearest box right of
// the label within its row band; else the box directly below it within the gap. A box that is itself a label is never
// a value.
function valueOf(doc: ParseDoc, field: Field): Read | null {
  const found = labelOf(doc, field);
  if (!found) return null;
  const { box, label } = found;
  const rest = carried(box.text, label);
  if (rest) return { text: rest, raw: carried(box.raw, label) || rest, observations: [box] };
  const others = doc.observations.filter((o) => o !== box && o.page === box.page && !allLabels.some((l) => carries(o, l)));
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

// The charge rows: each row between the 日期/项目/金额 header and 消费合计 that starts with a date, its amount right-most.
// PDF only: per-night charge rows are not read from a photo (#211 non-goal). Null when the table is not there.
function charges(doc: ParseDoc): number[] | null {
  if (doc.mediaType !== 'pdf') return null;
  const all = rows(doc);
  const headerAt = all.findIndex((row) => row.some((o) => compact(o.text) === '项目') && row.some((o) => compact(o.text) === '金额'));
  if (headerAt < 0) return null;
  const out: number[] = [];
  for (const row of all.slice(headerAt + 1)) {
    if (row.some((o) => LABELS.folioTotal.some((label) => carries(o, label)))) break;
    const amount = cents(row.at(-1)?.text ?? '');
    if (CHARGE_DATE.test(compact(row[0]?.text ?? '')) && amount !== null) out.push(amount);
  }
  return out;
}

export const labelled: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: LABEL,

  recognise(doc) {
    return ANCHORS.every((field) => labelOf(doc, field) !== undefined);
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, observations: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(observations) });
      return value ?? null;
    };
    const read = (key: Field) => valueOf(doc, key);
    const amount = (key: 'folioTotal' | 'paidAmount') => {
      const value = read(key);
      const parsed = value ? cents(value.text.replace(/元$/, '')) : null;
      if (value && parsed !== null) add(key, money(parsed), value.observations);
      return parsed;
    };

    const checkInLabel = labelOf(doc, 'checkIn')?.box;
    const hotel = doc.observations.find((o) => HOTEL_NAME.test(compact(o.text)) && checkInLabel && o.page === checkInLabel.page && o.y > checkInLabel.y);
    if (hotel) add('hotelName', compact(hotel.raw), [hotel]);
    const guest = read('guestName');
    if (guest) add('guestName', guest.raw, guest.observations);
    const room = read('roomNumber');
    if (room) add('roomNumber', ROOM.exec(room.raw)?.[0] ?? room.raw, room.observations);
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

    return { kindLabel: LABEL, candidates, findings };
  },
};
