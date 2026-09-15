import { cents, compact, money, rows, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Layout } from '../layout';

// `rail_ticket/12306`: the 铁路电子客票 (rail e-ticket) face from the PDF text layer. Ported from the rail rules of
// 50931a3:kernel/src/parse.mjs (`rail_eticket`): the face carries only the fare, so no net amount or tax is read — they are
// absent as a face fact, not a parse failure. The travel date (乘车日期), not the issue date, is the expense date.

const KIND = 'rail_ticket';
const NAME = '12306';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);

// Hard anchors, on NFKC text without whitespace (`电 子 发 票 （…）` reads `电子发票(…)`).
const TITLE = /^电子发票\(铁路电子客票\)$/;
const NUMBER = /^发票号码:(\d{20})$/;
const ISSUE_DATE = /^开票日期:(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const TRAVEL_DATE = /^乘车日期:(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const DEPART_TIME = /^开车时间:(\d{1,2}):(\d{2})$/;
// The 12306 wording the kernel parsed: `2026年08月22日07:05开` (date and departure time in one run).
const DEPART_RUN = /(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})开/;
const SEAT_CLASS = /^席别:(.+)$/;
const PASSENGER = /^乘车人:(.+)$/;
const FARE = /^票价:(¥?\d+\.\d{2})$/;
const TRAIN = /^[A-Z]?\d{1,4}$/;
// The kernel's one-line trip: `合肥南站 G1234 上海虹桥站`, matched on the line as printed (spaces kept), never on
// the flattened page (a flattened `…日合肥南站` would swallow the text before the station).
const TRIP_LINE = /^(\S+?)站?\s+([A-Z]?\d{1,4})\s+(\S+?)站?$/;

const pad = (n: string | undefined) => (n ?? '').padStart(2, '0');
const station = (text: string) => text.replace(/站$/, '');
const find = (doc: ParseDoc, pattern: RegExp) => doc.observations.find((o) => pattern.test(compact(o.text)));
const ref = (...observations: TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

type Trip = { from: string; train: string; to: string; evidence: TextObservation[] };

// The trip row: `<from> <train> <to>`, either as three cells on one visual row or as one printed line.
function trip(doc: ParseDoc): Trip | null {
  for (let page = 1; page <= doc.pageCount; page += 1) {
    for (const row of rows(doc, page)) {
      const [from, train, to] = row;
      if (row.length === 3 && from && train && to && TRAIN.test(compact(train.text)) && !TRAIN.test(compact(from.text)) && !TRAIN.test(compact(to.text))) {
        return { from: station(compact(from.raw)), train: compact(train.text), to: station(compact(to.raw)), evidence: [from, train, to] };
      }
    }
  }
  for (const o of doc.observations) {
    const match = TRIP_LINE.exec(o.text);
    if (match?.[1] && match[2] && match[3] && /站$/.test(o.text.split(/\s+/)[0] ?? '')) return { from: station(match[1]), train: match[2], to: station(match[3]), evidence: [o] };
  }
  return null;
}

export const rail12306: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '铁路电子客票',

  recognise(doc) {
    return Boolean(find(doc, TITLE) && find(doc, NUMBER));
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const add = (key: string, value: string | null | undefined, ...evidence: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(...evidence) });
    };
    const read = (pattern: RegExp) => {
      const o = find(doc, pattern);
      return o ? { o, m: pattern.exec(compact(o.text)) } : null;
    };

    const number = read(NUMBER);
    if (number) add('invoiceNumber', number.m?.[1], number.o);
    const issued = read(ISSUE_DATE);
    if (issued?.m) add('issueDate', `${issued.m[1]}-${pad(issued.m[2])}-${pad(issued.m[3])}`, issued.o);

    const route = trip(doc);
    if (route) {
      add('trainNumber', route.train, ...route.evidence);
      add('departStation', route.from, ...route.evidence);
      add('arriveStation', route.to, ...route.evidence);
    }

    const travel = read(TRAVEL_DATE);
    const time = read(DEPART_TIME);
    const run = doc.observations.find((o) => DEPART_RUN.test(compact(o.text)));
    const runMatch = run ? DEPART_RUN.exec(compact(run.text)) : null;
    if (travel?.m) add('travelDate', `${travel.m[1]}-${pad(travel.m[2])}-${pad(travel.m[3])}`, travel.o);
    else if (run && runMatch) add('travelDate', `${runMatch[1]}-${pad(runMatch[2])}-${pad(runMatch[3])}`, run);
    if (time?.m) add('departTime', `${pad(time.m[1])}:${time.m[2]}`, time.o);
    else if (run && runMatch) add('departTime', `${pad(runMatch[4])}:${runMatch[5]}`, run);

    const seat = read(SEAT_CLASS);
    if (seat) add('seatClass', compact(seat.o.raw).replace(/^席别[:：]/, ''), seat.o);
    const passenger = read(PASSENGER);
    if (passenger) add('passengerName', compact(passenger.o.raw).replace(/^乘车人[:：]/, ''), passenger.o);

    const fare = read(FARE);
    const fareCents = fare?.m?.[1] ? cents(fare.m[1]) : null;
    if (fare && fareCents !== null) add('totalAmount', money(fareCents), fare.o);

    return { kindLabel: '铁路电子客票', candidates, findings: [] };
  },
};
