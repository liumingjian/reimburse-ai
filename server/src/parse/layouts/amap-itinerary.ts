import { cents, compact, joinedRows, matchSpan, money, rows, type JoinedRow, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

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
  [/^序号$/, 'no'],
  [/^车型$/, 'carType'],
  [/^上车时间$/, 'time'],
  [/^城市$/, 'city'],
  [/^起点$/, 'origin'],
  [/^终点$/, 'destination'],
  [/^金额/, 'amount'],
];
type Column = 'no' | 'carType' | 'time' | 'city' | 'origin' | 'destination' | 'amount';
// The per-column policy: may a cell absorb text from the lines below it, within its leg's row band? Real itineraries
// wrap a long address, and they wrap 上车时间 between its date and its `HH:MM`. The remaining columns stay on the leg's
// own baseline, so a neighbouring row's text can never drift into them.
const WRAPPING: ReadonlySet<Column> = new Set(['time', 'origin', 'destination', 'amount']);
// How far below the line above it a wrapped line may sit, as a multiple of the text height. A continuation line
// follows within about one line height; a wider gap is not a continuation.
const CONTINUATION_GAP = 1.8;

const center = (o: TextObservation) => o.x + o.width / 2;
const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join('') }] : [];

type Header = { y: number; page: number; columns: { key: Column; center: number }[] };

// Every page's joined rows in reading order. A layout anchor is matched against these: the pattern stays fully
// anchored, only the haystack widens from one text run to the whole visual row (ADR-0017).
function allRows(doc: ParseDoc): JoinedRow[] {
  const out: JoinedRow[] = [];
  for (let page = 1; page <= doc.pageCount; page += 1) out.push(...joinedRows(doc, page));
  return out;
}

function header(doc: ParseDoc): Header | null {
  for (let page = 1; page <= doc.pageCount; page += 1) {
    for (const row of rows(doc, page)) {
      const columns = row.flatMap((o) => {
        const key = COLUMNS.find(([pattern]) => pattern.test(compact(o.text)))?.[1];
        return key ? [{ key, center: center(o) }] : [];
      });
      if (['no', 'time', 'origin', 'destination', 'amount'].every((key) => columns.some((c) => c.key === key))) return { y: row[0]?.y ?? 0, page, columns };
    }
  }
  return null;
}

// The column an observation belongs to: the header whose centre is nearest, within the midpoints to its neighbours.
function columnOf(head: Header, o: TextObservation): Column | null {
  const sorted = [...head.columns].sort((a, b) => a.center - b.center);
  const x = center(o);
  for (let i = 0; i < sorted.length; i += 1) {
    const col = sorted[i];
    if (!col) continue;
    const left = i === 0 ? -Infinity : ((sorted[i - 1]?.center ?? 0) + col.center) / 2;
    const right = i === sorted.length - 1 ? Infinity : (col.center + (sorted[i + 1]?.center ?? 0)) / 2;
    if (x >= left && x < right) return col.key;
  }
  return null;
}

type LegCells = { index: number; cells: Partial<Record<Column, TextObservation[]>> };

// A cell read top to bottom, cut where the text stops being continuous. A wrapped cell's lines follow each other about
// one line height apart; anything separated by a wider gap is not part of it. The last leg has no next row to bound
// its band, and the right-most column (amount) has no right bound either, so without this cut a table total or a
// right-aligned note printed under the table joins that leg's amount cell — and, reading as no amount at all, refuses
// the whole block.
function continuous(list: readonly TextObservation[]): TextObservation[] {
  const out: TextObservation[] = [];
  for (const o of list) {
    const previous = out.at(-1);
    if (previous && previous.y - o.y > Math.max(previous.height, o.height) * CONTINUATION_GAP) break;
    out.push(o);
  }
  return out;
}

function legRows(doc: ParseDoc, head: Header): LegCells[] {
  const below = doc.observations.filter((o) => o.page === head.page && o.y < head.y - 2);
  const anchors = below.filter((o) => /^\d+$/.test(compact(o.text)) && columnOf(head, o) === 'no').sort((a, b) => b.y - a.y);
  return anchors.map((anchor, i) => {
    const previous = anchors[i - 1];
    const next = anchors[i + 1];
    const pitch = previous ? previous.y - anchor.y : head.y - anchor.y;
    const top = previous ? (previous.y + anchor.y) / 2 : (head.y + anchor.y) / 2;
    const bottom = next ? (anchor.y + next.y) / 2 : anchor.y - pitch / 2;
    const cells: LegCells['cells'] = {};
    for (const o of below) {
      const column = columnOf(head, o);
      if (!column || column === 'no') continue;
      const inRow = WRAPPING.has(column) ? o.y <= top && o.y > bottom : Math.abs(o.y - anchor.y) <= 3;
      if (inRow) (cells[column] ??= []).push(o);
    }
    for (const column of Object.keys(cells) as Column[]) {
      const list = cells[column];
      if (!list) continue;
      list.sort((a, b) => b.y - a.y || a.x - b.x);
      cells[column] = continuous(list);
    }
    return { index: Number(compact(anchor.text)), cells };
  });
}

export const amapItinerary: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '高德行程单',

  recognise(doc) {
    const texts = doc.observations.map((o) => compact(o.text));
    return texts.some((t) => t.includes('行程单')) && texts.some((t) => BRAND.test(t)) && header(doc) !== null;
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string | null | undefined, evidence: readonly TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(evidence) });
    };

    // The 申请时间 header field and the 共计N单行程 summary are matched against row spans, not against one text run and
    // not against the whole row: a real itinerary prints several fields on one baseline and splits a label from its
    // value, so the narrowest contiguous run of a row is the only haystack that holds exactly one field (ADR-0017:
    // the haystack narrows, the patterns stay fully anchored).
    const lines = allRows(doc);
    const apply = matchSpan(lines, APPLY_DATE);
    if (apply) add('applyDate', apply.match[1], apply.span.observations);

    const summary = matchSpan(lines, SUMMARY);
    const total = summary?.match[2] ? cents(summary.match[2]) : null;
    if (summary) {
      add('segmentCount', String(Number(summary.match[1])), summary.span.observations);
      if (total !== null) add('itineraryTotal', money(total), summary.span.observations);
    }

    const head = header(doc);
    const legs = head ? legRows(doc, head) : [];
    const text = (list: TextObservation[] | undefined) => (list ?? []).map((o) => compact(o.raw)).join('') || null;
    // A cell read as one string: its observations top to bottom, left to right, joined and compacted the way anchors
    // are matched everywhere else. A cell that wrapped onto a second line therefore reads as a single value.
    const cell = (list: TextObservation[] | undefined) => compact((list ?? []).map((o) => o.text).join(''));
    const parsed = legs.map(({ index, cells }) => {
      const time = TIME.exec(cell(cells.time));
      const amount = cents(cell(cells.amount).replace(AMOUNT_UNIT, ''));
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
      add(at('carType'), text(leg.cells.carType), leg.cells.carType ?? []);
      add(at('city'), text(leg.cells.city), leg.cells.city ?? []);
      add(at('origin'), text(leg.cells.origin), leg.cells.origin ?? []);
      add(at('destination'), text(leg.cells.destination), leg.cells.destination ?? []);
      add(at('amount'), leg.amount, leg.cells.amount ?? []);
    });
    const unrouted = parsed.filter((leg) => !text(leg.cells.origin) || !text(leg.cells.destination)).map((leg) => leg.index);
    if (unrouted.length > 0) {
      findings.push({ kind: 'validation', code: 'route_incomplete', message: `第 ${unrouted.join('、')} 段的起点或终点没有完整读到，不能用半截路线。` });
    }
    return { kindLabel: '高德行程单', candidates, findings };
  },
};
