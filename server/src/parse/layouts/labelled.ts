import { cents, daysBetween, money } from '../../money-date';
import { compact, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type Finding, type Layout } from '../layout';
import { dateOf, labelReader, ref } from './labels';

// `hotel_folio/labelled`: a hotel 结账单 or 水单 (folio) of any hotel, read through its field labels, from a PDF text
// layer or a photo. A folio is reference material: it proves the stay dates of a hotel invoice and is never an
// invoice itself (kernel `parse.mjs` hotel_folio rules).
//
// Recognition does not look at the chain name (#211) or the title: on a photo the name is never one contiguous text
// observation, many a 水单 prints no 结账单 title at all, and neither is what a folio proves. Values are read through
// their labels (`labels.ts`): in the label's own run on a PDF, by position from the label on a photo (as
// `taxi_receipt/machine_printed` does).
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

// Every label of a stay field: a document that carries any of them is a hotel's, never a restaurant's 餐饮小票
// (`dining_receipt/labelled` refuses it, so the two layouts never both match).
export const STAY_LABELS: readonly string[] = [...LABELS.checkIn, ...LABELS.checkOut, ...LABELS.roomNumber];

// A hotel's name as a folio heads it: ending in a generic lodging word, optionally with its branch in parentheses.
// Not a chain list; it is only read above the 入住日期 label, where the folio header is.
const HOTEL_NAME = /^[^:]{2,}(?:酒店|宾馆|饭店|旅馆|客栈)(?:\(.+\))?$/;
const NIGHTS = /^(\d+)$/;
const RATE = /^([\d,]+\.\d{2})/;
const CHARGE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A room number printed with words after it (`1426入住2天`) is its leading number; one that starts with words (`A栋1208`)
// is kept whole.
const ROOM = /^[A-Za-z]?\d[\dA-Za-z-]*/;

const { carries, labelOf, valueOf } = labelReader(LABELS);

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
