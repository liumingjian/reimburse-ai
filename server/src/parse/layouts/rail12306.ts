import { cents, compact, joinedRows, matchSpan, matchWidestSpan, money, spans, type JoinedRow, type ParseDoc, type RowSpan, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Layout } from '../layout';

// `rail_ticket/12306`: the 铁路电子客票 (rail e-ticket) face from the PDF text layer. Ported from the rail rules of
// 50931a3:kernel/src/parse.mjs (`rail_eticket`): the face carries only the fare, so no net amount or tax is read — they are
// absent as a face fact, not a parse failure. The travel date (乘车日期), not the issue date, is the expense date.
//
// Anchors match spans of a visual row (#204). A real ticket draws its face as a two-column box, so 乘车日期 sits beside
// 开车时间 and 票价 beside 购买方 on one row, and a label and its value are often separate text runs. The patterns stay
// fully anchored (ADR-0017); only the haystack moves.

const KIND = 'rail_ticket';
const NAME = '12306';
const VERSION = '2';
const SOURCE = ruleSource(KIND, NAME);

// Hard anchors, on NFKC text without whitespace (`电 子 发 票 （…）` reads `电子发票(…)`).
const TITLE = /^电子发票\(铁路电子客票\)$/;
const NUMBER = /^发票号码:(\d{20})$/;
const ISSUE_DATE = /^开票日期:(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const TRAVEL_DATE = /^乘车日期:(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const DEPART_TIME = /^开车时间:(\d{1,2}):(\d{2})$/;
// The 12306 wording the kernel parsed: `2026年08月22日07:05开` (date and departure time in one run). Anchored like
// every other pattern here — `matchSpan` narrows the haystack, it never takes a substring.
const DEPART_RUN = /^(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})开$/;
// Label plus free text: read widest first, so a value drawn glyph by glyph is the value and not its first glyph. A
// colon can only begin the next label printed beside it (座位:, 证件号:), so excluding it bounds the widest reading.
const SEAT_CLASS = /^席别:([^:]+)$/;
const PASSENGER = /^乘车人:([^:]+)$/;
const FARE = /^票价:(¥?\d+\.\d{2})$/;
// The trip as printed: `杭州东 G7522 上海虹桥`, or the kernel's one-line `合肥南站 G1234 上海虹桥站`. Station names are
// CJK, two characters or more; the 站 suffix is optional but is captured, because on a trip printed as one text run it
// is the only thing that tells a trip from any other CJK-digits-CJK line (`检票口12候车室` — a gate and a waiting room).
const TRIP = /^([\u4e00-\u9fa5]{2,}?)(站)?([A-Z]?\d{1,4})([\u4e00-\u9fa5]{2,}?)(站)?$/;

const pad = (n: string | undefined) => (n ?? '').padStart(2, '0');
// Wording is presented as printed; only anchors and numbers use the normalised text.
const visible = (span: RowSpan) => compact(span.observations.map((o) => o.raw).join(''));
const ref = (...observations: TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

// The whole document as visual rows: unlike an invoice, a ticket's face fields are not confined to page 1.
function lines(doc: ParseDoc): JoinedRow[] {
  const out: JoinedRow[] = [];
  for (let page = 1; page <= doc.pageCount; page += 1) out.push(...joinedRows(doc, page));
  return out;
}

type Trip = { from: string; train: string; to: string; evidence: TextObservation[] };

function trip(rows: readonly JoinedRow[]): Trip | null {
  for (const row of rows) {
    for (const span of spans(row)) {
      const match = TRIP.exec(span.text);
      const [, from, fromSuffix, train, to, toSuffix] = match ?? [];
      if (!from || !train || !to) continue;
      // Two structural guards, and a trip satisfies one of them. On a ticket that draws the trip as cells the 车次 is a
      // text run of its own. On a ticket that prints the whole trip as one run there is no cell to check, and both
      // stations carry their 站 suffix. Digits inside a longer run are otherwise not a 车次 — the route line simply
      // being printed first is not what may decide three required, locked face facts.
      const ownRun = span.observations.some((o) => compact(o.text) === train);
      if (!ownRun && !(fromSuffix && toSuffix)) continue;
      return { from, train, to, evidence: [...span.observations] };
    }
  }
  return null;
}

export const rail12306: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '铁路电子客票',

  recognise(doc) {
    const rows = lines(doc);
    return Boolean(matchSpan(rows, TITLE) && matchSpan(rows, NUMBER));
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const add = (key: string, value: string | null | undefined, ...evidence: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(...evidence) });
    };
    const rows = lines(doc);
    const read = (pattern: RegExp) => matchSpan(rows, pattern);
    const runs = (found: { span: RowSpan } | null) => (found ? [...found.span.observations] : []);

    const number = read(NUMBER);
    if (number) add('invoiceNumber', number.match[1], ...runs(number));
    const issued = read(ISSUE_DATE);
    if (issued) add('issueDate', `${issued.match[1]}-${pad(issued.match[2])}-${pad(issued.match[3])}`, ...runs(issued));

    const route = trip(rows);
    if (route) {
      add('trainNumber', route.train, ...route.evidence);
      add('departStation', route.from, ...route.evidence);
      add('arriveStation', route.to, ...route.evidence);
    }

    const travel = read(TRAVEL_DATE);
    const time = read(DEPART_TIME);
    const run = read(DEPART_RUN);
    if (travel) add('travelDate', `${travel.match[1]}-${pad(travel.match[2])}-${pad(travel.match[3])}`, ...runs(travel));
    else if (run) add('travelDate', `${run.match[1]}-${pad(run.match[2])}-${pad(run.match[3])}`, ...runs(run));
    if (time) add('departTime', `${pad(time.match[1])}:${time.match[2]}`, ...runs(time));
    else if (run) add('departTime', `${pad(run.match[4])}:${run.match[5]}`, ...runs(run));

    const seat = matchWidestSpan(rows, SEAT_CLASS);
    if (seat) add('seatClass', visible(seat.span).replace(/^席别[:：]/, ''), ...runs(seat));
    const passenger = matchWidestSpan(rows, PASSENGER);
    if (passenger) add('passengerName', visible(passenger.span).replace(/^乘车人[:：]/, ''), ...runs(passenger));

    const fare = read(FARE);
    const fareCents = fare?.match[1] ? cents(fare.match[1]) : null;
    if (fare && fareCents !== null) add('totalAmount', money(fareCents), ...runs(fare));

    return { kindLabel: '铁路电子客票', candidates, findings: [] };
  },
};
