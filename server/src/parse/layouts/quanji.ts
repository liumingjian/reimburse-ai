import { cents, compact, money, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `hotel_folio/quanji`: the 全季酒店 结账单 (Quanji hotel folio), from the PDF text layer. A folio is reference material:
// it proves the stay dates of a hotel invoice and is never an invoice itself (kernel `parse.mjs` hotel_folio rules).
// Other chains' folios match no layout and go to 手工补填 (manual fill), ADR-0017.

const KIND = 'hotel_folio';
const NAME = 'quanji';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
const FROM_NIGHTS = ruleSource(KIND, NAME, 'checkout_from_nights');

// Hard anchors, on NFKC text without whitespace: the folio title, the chain name, the stay-date label.
const TITLE = /^结账单/;
const CHAIN = /^全季酒店/;
const CHECK_IN = /^入住日期:(\d{4}-\d{2}-\d{2})$/;
const CHECK_OUT = /^离店日期:(\d{4}-\d{2}-\d{2})$/;
const GUEST = /^入住人:(.+)$/;
const ROOM = /^房号:(.+)$/;
const NIGHTS = /^天数:(\d+)$/;
const RATE = /^房价:([\d,]+\.\d{2})/;
const CHARGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const find = (doc: ParseDoc, pattern: RegExp) => doc.observations.find((o) => pattern.test(compact(o.text)));
const ref = (o: TextObservation): EvidenceRef[] => [{ page: o.page, observationIds: [o.id], text: o.raw }];

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// The amount printed right of a label on the same row, e.g. 消费合计 … 3640.00.
function amountAfter(doc: ParseDoc, label: string): TextObservation | undefined {
  const row = rows(doc).find((r) => r.some((o) => compact(o.text) === label));
  return row?.find((o) => cents(o.text) !== null);
}

// The charge rows: each row between the 日期/项目/金额 header and 消费合计 that starts with a date, its amount right-most.
function charges(doc: ParseDoc): number[] {
  const all = rows(doc);
  const headerAt = all.findIndex((row) => row.some((o) => compact(o.text) === '项目') && row.some((o) => compact(o.text) === '金额'));
  if (headerAt < 0) return [];
  const out: number[] = [];
  for (const row of all.slice(headerAt + 1)) {
    if (row.some((o) => compact(o.text) === '消费合计')) break;
    const amount = cents(row.at(-1)?.text ?? '');
    if (CHARGE_DATE.test(compact(row[0]?.text ?? '')) && amount !== null) out.push(amount);
  }
  return out;
}

export const quanji: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '全季酒店结账单',

  recognise(doc) {
    return Boolean(find(doc, TITLE) && find(doc, CHAIN) && find(doc, CHECK_IN));
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, pattern: RegExp, display = false) => {
      const o = find(doc, pattern);
      const value = o ? (display ? compact(o.raw).replace(/^[^:：]+[:：]/, '') : pattern.exec(compact(o.text))?.[1]) : undefined;
      if (o && value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(o) });
      return value;
    };
    const addAmount = (key: string, o: TextObservation | undefined) => {
      const value = o ? cents(o.text) : null;
      if (o && value !== null) candidates.push({ key, value: money(value), source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(o) });
      return value;
    };

    const chain = find(doc, CHAIN);
    if (chain) candidates.push({ key: 'hotelName', value: compact(chain.raw), source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(chain) });
    add('guestName', GUEST, true);
    add('roomNumber', ROOM, true);
    const checkIn = add('checkIn', CHECK_IN);
    const checkOut = add('checkOut', CHECK_OUT);
    const nightsText = add('nights', NIGHTS);
    const rateObservation = find(doc, RATE);
    const rate = rateObservation ? cents(RATE.exec(compact(rateObservation.text))?.[1] ?? '') : null;
    if (rateObservation && rate !== null) candidates.push({ key: 'roomRate', value: money(rate), source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(rateObservation) });
    const total = addAmount('folioTotal', amountAfter(doc, '消费合计'));
    addAmount('paidAmount', amountAfter(doc, '已付款(预授权结算)'));

    // A check-out date the folio does not print is traceable from 入住日期 + 天数; never from the invoice date.
    const nights = nightsText ? Number(nightsText) : null;
    if (!checkOut && checkIn && nights !== null) {
      const nightsObservation = find(doc, NIGHTS);
      const checkInObservation = find(doc, CHECK_IN);
      candidates.push({
        key: 'checkOut',
        value: addDays(checkIn, nights),
        source: FROM_NIGHTS,
        parserVersion: VERSION,
        evidence: 'derived',
        refs: [...(checkInObservation ? ref(checkInObservation) : []), ...(nightsObservation ? ref(nightsObservation) : [])],
      });
    }

    // Deterministic checks: the dates span the printed nights; the charge rows add up to 消费合计, to the cent.
    if (checkIn && checkOut && nights !== null && daysBetween(checkIn, checkOut) !== nights) {
      findings.push({ kind: 'validation', code: 'nights_mismatch', message: `入住 ${checkIn} 到离店 ${checkOut} 是 ${daysBetween(checkIn, checkOut)} 晚，结账单写的是 ${nights} 晚。` });
    }
    const rowsTotal = charges(doc).reduce((acc, amount) => acc + amount, 0);
    if (total !== null && rowsTotal !== total) {
      findings.push({ kind: 'validation', code: 'charges_not_conserved', message: `消费明细加起来是 ${money(rowsTotal)}，和消费合计 ${money(total)} 对不上。` });
    }

    return { kindLabel: '全季酒店结账单', candidates, findings };
  },
};
