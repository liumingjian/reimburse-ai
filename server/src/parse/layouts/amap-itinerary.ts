import { cents, money } from '../../money-date';
import { allJoinedRows, compact, matchSpan, type TextObservation } from '../doc';
import { evidenceRef, ruleSource, type Candidate, type Finding, type Layout } from '../layout';
import { cellRaw, cellText, itineraryTable } from './itinerary-table';

// `ride_itinerary/amap`: the 高德行程单 (Amap ride itinerary), a reference material listing each ride leg. PDF and image
// alike: both arrive as positioned text observations. Ported from 50931a3:kernel/src/parse.mjs (`ride_itinerary`,
// `itinerarySegments`, `itineraryRouteLayout`): the leg rows are trusted only when their count equals the count the
// itinerary declares (`共计N单行程`); origin and destination cells are merged by coordinates within each leg's row band,
// so an address wrapped onto a second line is joined, never cut on spaces.
//
// Leg candidates are keyed `segments[i].<field>` with a 0-based `i` (ADR-0017); fields: date, time, carType, city,
// origin, destination, amount.

const KIND = 'ride_itinerary';
const NAME = 'amap';
const VERSION = '4';
const SOURCE = ruleSource(KIND, NAME);

const BRAND = /高德地图|AMAPITINERARY/;
// The label over the date the itinerary was asked for: real 高德 itineraries print 申请时间, others print 申请日期.
// Both spellings are a face's own label, so the anchor names both rather than falling back from one to the other; it
// stays fully anchored on the date, and a header that prints neither leaves `applyDate` missing (ADR-0017).
const APPLY_DATE = /^申请(?:日期|时间):(\d{4}-\d{2}-\d{2})$/;
const SUMMARY = /^共计(\d+)单行程,合计([\d,]+\.\d{2})元$/;
// Matched against the 上车时间 cell read as one compacted string, so a date and an `HH:MM` printed on two lines join.
const TIME = /^(\d{4}-\d{2}-\d{2})(\d{2}:\d{2})$/;
// Real itineraries print the amount with its unit in the cell: `26.69元`. `cents()` takes `¥` and thousands
// separators already, so only the suffix has to come off before it parses.
const AMOUNT_UNIT = /元$/;

const COLUMNS: readonly [RegExp, Column][] = [
  [/^车型$/, 'carType'],
  [/^上车时间$/, 'time'],
  [/^城市$/, 'city'],
  [/^起点$/, 'origin'],
  [/^终点$/, 'destination'],
  [/^金额/, 'amount'],
];
type Column = 'carType' | 'time' | 'city' | 'origin' | 'destination' | 'amount';
// The leg table, read by the shared 行程单 table reader. The per-column policy says whether a cell may absorb text from
// the lines below it, within its leg's row band: real itineraries wrap a long address, and they wrap 上车时间 between
// its date and its `HH:MM`. The remaining columns stay on the leg's own baseline, so a neighbouring row's text can never
// drift into them.
const TABLE = itineraryTable<Column>({
  columns: COLUMNS,
  required: ['time', 'origin', 'destination', 'amount'],
  wrapping: new Set(['time', 'origin', 'destination', 'amount']),
});

export const amapItinerary: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '高德行程单',

  recognise(doc) {
    const texts = doc.observations.map((o) => compact(o.text));
    return texts.some((t) => t.includes('行程单')) && texts.some((t) => BRAND.test(t)) && TABLE.hasHeader(doc);
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, evidence: readonly TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: evidenceRef(evidence) });
    };

    // The 申请时间 header field and the 共计N单行程 summary are matched against row spans, not against one text run and
    // not against the whole row: a real itinerary prints several fields on one baseline and splits a label from its
    // value, so the narrowest contiguous run of a row is the only haystack that holds exactly one field (ADR-0017:
    // the haystack narrows, the patterns stay fully anchored).
    const lines = allJoinedRows(doc);
    const apply = matchSpan(lines, APPLY_DATE);
    if (apply) add('applyDate', apply.match[1], apply.span.observations);

    const summary = matchSpan(lines, SUMMARY);
    const total = summary?.match[2] ? cents(summary.match[2]) : null;
    if (summary) {
      add('segmentCount', String(Number(summary.match[1])), summary.span.observations);
      if (total !== null) add('itineraryTotal', money(total), summary.span.observations);
    }

    const parsed = TABLE.legs(doc).map(({ index, cells }) => {
      const time = TIME.exec(cellText(cells.time));
      const amount = cents(cellText(cells.amount).replace(AMOUNT_UNIT, ''));
      return { index, cells, date: time?.[1] ?? null, time: time?.[2] ?? null, amount: amount !== null && amount > 0 ? money(amount) : null };
    });

    // Leg rows are trusted only as a whole: indexes 1..n in order, n = the declared count, each with a date and an
    // amount. Otherwise a row was not read completely (wrapped tables are the known trap) and all of them are dropped.
    // Each clause is judged on its own and reports itself, so the refusal names the cause the user can check against
    // the original: a count message is emitted only when the counts really differ.
    const declaredCount = summary ? Number(summary.match[1]) : null;
    const refusals: Finding[] = [];
    const refuse = (code: string, message: string) => refusals.push({ kind: 'validation', code, message });
    if (declaredCount === null) refuse('segment_rows_incomplete', `行程单声明的段数没读到，逐段明细读到 ${parsed.length} 行；整块不采用。`);
    else if (parsed.length !== declaredCount) refuse('segment_rows_incomplete', `逐段明细读到 ${parsed.length} 行，行程单声明 ${declaredCount} 段，对不上；整块不采用。`);
    parsed.forEach((leg, i) => {
      const no = i + 1;
      if (leg.index !== no) refuse(`segment_index_unexpected.${no}`, `第 ${no} 段的序号读成了 ${leg.index}；整块不采用。`);
      if (leg.date === null) refuse(`segment_field_unreadable.${no}.date`, `第 ${no} 段的上车时间没读到；整块不采用。`);
      if (leg.amount === null) refuse(`segment_field_unreadable.${no}.amount`, `第 ${no} 段的金额没读到；整块不采用。`);
    });
    if (refusals.length > 0) {
      findings.push(...refusals);
      return { kindLabel: '高德行程单', candidates, findings };
    }

    parsed.forEach((leg, i) => {
      const at = (field: string) => `segments[${i}].${field}`;
      add(at('date'), leg.date, leg.cells.time ?? []);
      add(at('time'), leg.time, leg.cells.time ?? []);
      add(at('carType'), cellRaw(leg.cells.carType), leg.cells.carType ?? []);
      add(at('city'), cellRaw(leg.cells.city), leg.cells.city ?? []);
      add(at('origin'), cellRaw(leg.cells.origin), leg.cells.origin ?? []);
      add(at('destination'), cellRaw(leg.cells.destination), leg.cells.destination ?? []);
      add(at('amount'), leg.amount, leg.cells.amount ?? []);
    });
    const unrouted = parsed.filter((leg) => !cellRaw(leg.cells.origin) || !cellRaw(leg.cells.destination)).map((leg) => leg.index);
    if (unrouted.length > 0) {
      findings.push({ kind: 'validation', code: 'route_incomplete', message: `第 ${unrouted.join('、')} 段的起点或终点没有完整读到，不能用半截路线。` });
    }
    return { kindLabel: '高德行程单', candidates, findings };
  },
};
