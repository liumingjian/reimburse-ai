import { cents, money } from '../../money-date';
import { compact, joinedRows, matchSpan, type JoinedRow, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';
import { cellRaw, cellText, itineraryTable } from './itinerary-table';

// `ride_itinerary/didi`: the 行程单 the 滴滴 platform issues (#445). Same slots as the 高德 行程单 (`amap-itinerary.ts`),
// so pairing by 合计 and the per-leg lines work unchanged: `applyDate`, `segmentCount`, `itineraryTotal`, and per leg
// `segments[i].<field>` (date, time, carType, city, origin, destination, amount). 里程 and 备注 are printed but not read.
//
// The table prints a leg's 上车时间 as `MM-DD HH:MM` plus a weekday, without the year. The year is derived from the header's
// 行程起止日期 (`year_from_range`): the one year that puts the date inside the range. None or several: no date.
//
// Trust rule, stricter than 高德: the legs are adopted only as a whole, when their 序号 run 1..n, n is the declared
// 共N笔, every leg has a date and an amount, and the amounts sum to the declared 合计 to the cent. Otherwise no leg is
// emitted and a `validation` finding names each cause.

const KIND = 'ride_itinerary';
const NAME = 'didi';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
export const YEAR_SOURCE = ruleSource(KIND, NAME, 'year_from_range');

// The faces this 版式 reads, by their title: the carrier named on the face gives the display name. #451 adds the
// 第三方网约车服务提供方<carrier>—行程单 title here, with the carrier taken from the title.
const FACES: readonly { title: RegExp; carrier: (match: RegExpExecArray) => string }[] = [{ title: /^滴滴出行-行程单$/, carrier: () => '滴滴' }];

// Header fields, each printed as one bulleted line (`· 申请日期：2026-10-13`); matched against row spans, fully anchored.
const BULLET = '[·•]?';
const APPLY_DATE = new RegExp(`^${BULLET}申请日期:(\\d{4}-\\d{2}-\\d{2})$`);
const RANGE = new RegExp(`^${BULLET}行程起止日期:(\\d{4}-\\d{2}-\\d{2})至(\\d{4}-\\d{2}-\\d{2})$`);
const SUMMARY = new RegExp(`^${BULLET}共(\\d+)笔行程,合计([\\d,]+\\.\\d{2})元$`);
// The 上车时间 cell read as one compacted string: `07-0223:20周四`. The weekday is optional, as a wrapped cell may cut it.
const TIME = /^(\d{2})-(\d{2})(\d{2}:\d{2})(?:周[一二三四五六日天])?$/;
const AMOUNT_UNIT = /元$/;

type Column = 'no' | 'carType' | 'time' | 'city' | 'origin' | 'destination' | 'distance' | 'amount' | 'note';
// 里程 and 备注 get columns of their own so their text never lands in a neighbouring column; nothing reads them.
// Every column may wrap (车型, 上车时间 with its weekday, 城市, addresses). A long 行程单 runs over several pages, the
// header repeated on each and the 序号 continuing; the trust rule below judges the joined list (#450).
const TABLE = itineraryTable<Column>({
  columns: [
    [/^序号$/, 'no'],
    [/^车型$/, 'carType'],
    [/^上车时间$/, 'time'],
    [/^城市$/, 'city'],
    [/^起点$/, 'origin'],
    [/^终点$/, 'destination'],
    [/^里程/, 'distance'],
    [/^金额/, 'amount'],
    [/^备注$/, 'note'],
  ],
  required: ['no', 'time', 'origin', 'destination', 'amount'],
  index: 'no',
  wrapping: new Set(['carType', 'time', 'city', 'origin', 'destination', 'distance', 'amount', 'note']),
  repeatedHeader: true,
});

const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join('') }] : [];

function allRows(doc: ParseDoc): JoinedRow[] {
  const out: JoinedRow[] = [];
  for (let page = 1; page <= doc.pageCount; page += 1) out.push(...joinedRows(doc, page));
  return out;
}

// The carrier named by the face's title, or null when the document carries no title this 版式 reads.
function carrierOf(doc: ParseDoc): string | null {
  for (const o of doc.observations) {
    const text = compact(o.text);
    for (const face of FACES) {
      const match = face.title.exec(text);
      if (match) return face.carrier(match);
    }
  }
  return null;
}

type YearRange = { from: string; to: string };
type LegDate = { date: string } | { date: null; reason: 'no_range' | 'outside' | 'ambiguous' };

const validDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// `year_from_range`: the one year that puts `MM-DD` inside 行程起止日期 (ISO dates compare as strings).
function yearFromRange(monthDay: string, range: YearRange | null): LegDate {
  if (!range) return { date: null, reason: 'no_range' };
  const fits: string[] = [];
  for (let year = Number(range.from.slice(0, 4)); year <= Number(range.to.slice(0, 4)); year += 1) {
    const date = `${year}-${monthDay}`;
    if (validDate(date) && date >= range.from && date <= range.to) fits.push(date);
  }
  const [only] = fits;
  if (fits.length === 1 && only) return { date: only };
  return { date: null, reason: fits.length === 0 ? 'outside' : 'ambiguous' };
}

export const didiItinerary: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '滴滴行程单',

  recognise(doc) {
    return carrierOf(doc) !== null && TABLE.hasHeader(doc);
  },

  parse(doc) {
    const kindLabel = `${carrierOf(doc) ?? '滴滴'}行程单`;
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, evidence: readonly TextObservation[], source = SOURCE) => {
      if (value) candidates.push({ key, value, source, parserVersion: VERSION, evidence: source === SOURCE ? 'explicit' : 'derived', refs: ref(evidence) });
    };

    const lines = allRows(doc);
    const apply = matchSpan(lines, APPLY_DATE);
    if (apply) add('applyDate', apply.match[1], apply.span.observations);

    const rangeMatch = matchSpan(lines, RANGE);
    const range = rangeMatch?.match[1] && rangeMatch.match[2] && rangeMatch.match[1] <= rangeMatch.match[2] ? { from: rangeMatch.match[1], to: rangeMatch.match[2] } : null;
    const rangeText = range ? `${range.from} 至 ${range.to}` : '';

    const summary = matchSpan(lines, SUMMARY);
    const total = summary?.match[2] ? cents(summary.match[2]) : null;
    if (summary) {
      add('segmentCount', String(Number(summary.match[1])), summary.span.observations);
      if (total !== null) add('itineraryTotal', money(total), summary.span.observations);
    }

    const parsed = TABLE.legs(doc).map(({ index, cells }) => {
      const time = TIME.exec(cellText(cells.time));
      const monthDay = time ? `${time[1]}-${time[2]}` : null;
      const date = monthDay ? yearFromRange(monthDay, range) : null;
      const amount = cents(cellText(cells.amount).replace(AMOUNT_UNIT, ''));
      return { index, cells, monthDay, date, time: time?.[3] ?? null, amount: amount !== null && amount > 0 ? amount : null };
    });

    const declaredCount = summary ? Number(summary.match[1]) : null;
    const refusals: Finding[] = [];
    const refuse = (code: string, message: string) => refusals.push({ kind: 'validation', code, message });
    if (declaredCount === null) refuse('segment_rows_incomplete', `行程单声明的笔数没读到，逐段明细读到 ${parsed.length} 行；整块不采用。`);
    else if (parsed.length !== declaredCount) refuse('segment_rows_incomplete', `逐段明细读到 ${parsed.length} 行，行程单声明 ${declaredCount} 笔，对不上；整块不采用。`);
    parsed.forEach((leg, i) => {
      const no = i + 1;
      if (leg.index !== no) refuse(`segment_index_unexpected.${no}`, `第 ${no} 段的序号读成了 ${leg.index}；整块不采用。`);
      if (!leg.date) refuse(`segment_field_unreadable.${no}.date`, `第 ${no} 段的上车时间没读到；整块不采用。`);
      else if (leg.date.date === null) {
        const why =
          leg.date.reason === 'no_range'
            ? `定不了年份：行程起止日期没读到`
            : leg.date.reason === 'outside'
              ? `不在行程起止日期 ${rangeText} 内，定不了年份`
              : `在行程起止日期 ${rangeText} 内对得上不止一个年份，没有采用`;
        refuse(`segment_year_undecided.${no}`, `第 ${no} 段的上车日期 ${leg.monthDay} ${why}；整块不采用。`);
      }
      if (leg.amount === null) refuse(`segment_field_unreadable.${no}.amount`, `第 ${no} 段的金额没读到；整块不采用。`);
    });
    // The sum is judged only when every amount was read: a missing amount is already named above.
    if (total !== null && parsed.length > 0 && parsed.every((leg) => leg.amount !== null)) {
      const sum = parsed.reduce((acc, leg) => acc + (leg.amount ?? 0), 0);
      if (sum !== total) refuse('segment_total_mismatch', `逐段金额合计 ${money(sum)}，行程单合计 ${money(total)}，差一分也对不上；整块不采用。`);
    }
    if (refusals.length > 0) {
      findings.push(...refusals);
      return { kindLabel, candidates, findings };
    }

    parsed.forEach((leg, i) => {
      const at = (field: string) => `segments[${i}].${field}`;
      add(at('date'), leg.date?.date, leg.cells.time ?? [], YEAR_SOURCE);
      add(at('time'), leg.time, leg.cells.time ?? []);
      add(at('carType'), cellRaw(leg.cells.carType), leg.cells.carType ?? []);
      add(at('city'), cellRaw(leg.cells.city), leg.cells.city ?? []);
      add(at('origin'), cellRaw(leg.cells.origin), leg.cells.origin ?? []);
      add(at('destination'), cellRaw(leg.cells.destination), leg.cells.destination ?? []);
      add(at('amount'), leg.amount === null ? null : money(leg.amount), leg.cells.amount ?? []);
    });
    const unrouted = parsed.filter((leg) => !cellRaw(leg.cells.origin) || !cellRaw(leg.cells.destination)).map((leg) => leg.index);
    if (unrouted.length > 0) {
      findings.push({ kind: 'validation', code: 'route_incomplete', message: `第 ${unrouted.join('、')} 段的起点或终点没有完整读到，不能用半截路线。` });
    }
    return { kindLabel, candidates, findings };
  },
};
