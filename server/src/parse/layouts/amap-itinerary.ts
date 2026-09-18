import { cents, compact, money, rows, type ParseDoc, type TextObservation } from '../doc';
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
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);

const BRAND = /高德地图|AMAPITINERARY/;
const APPLY_DATE = /^申请日期:(\d{4}-\d{2}-\d{2})$/;
const SUMMARY = /^共计(\d+)单行程,合计([\d,]+\.\d{2})元$/;
const TIME = /^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2})$/;

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
// Only these columns may wrap onto more lines within a row.
const WRAPPING: ReadonlySet<Column> = new Set(['origin', 'destination']);

const center = (o: TextObservation) => o.x + o.width / 2;
const ref = (observations: TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join('') }] : [];

type Header = { y: number; page: number; columns: { key: Column; center: number }[] };

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
    for (const list of Object.values(cells)) list.sort((a, b) => b.y - a.y || a.x - b.x);
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
    const add = (key: string, value: string | null | undefined, evidence: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(evidence) });
    };

    const apply = doc.observations.find((o) => APPLY_DATE.test(compact(o.text)));
    if (apply) add('applyDate', APPLY_DATE.exec(compact(apply.text))?.[1], [apply]);

    const summary = doc.observations.find((o) => SUMMARY.test(compact(o.text)));
    const declared = summary ? SUMMARY.exec(compact(summary.text)) : null;
    const total = declared?.[2] ? cents(declared[2]) : null;
    if (summary && declared) {
      add('segmentCount', String(Number(declared[1])), [summary]);
      if (total !== null) add('itineraryTotal', money(total), [summary]);
    }

    const head = header(doc);
    const legs = head ? legRows(doc, head) : [];
    const text = (list: TextObservation[] | undefined) => (list ?? []).map((o) => compact(o.raw)).join('') || null;
    const parsed = legs.map(({ index, cells }) => {
      const time = TIME.exec(compact(cells.time?.map((o) => o.text).join(' ') ?? '').replace(/^(\d{4}-\d{2}-\d{2})(\d{2}:)/, '$1 $2'));
      const amount = cells.amount?.[0] ? cents(cells.amount[0].text) : null;
      return { index, cells, date: time?.[1] ?? null, time: time?.[2] ?? null, amount: amount !== null && amount > 0 ? money(amount) : null };
    });

    // Leg rows are trusted only as a whole: indexes 1..n in order, n = the declared count, each with a date and an
    // amount. Otherwise a row was not read completely (wrapped tables are the known trap) and all of them are dropped.
    const complete =
      declared !== null &&
      parsed.length === Number(declared[1]) &&
      parsed.every((leg, i) => leg.index === i + 1 && leg.date !== null && leg.amount !== null);
    if (!complete) {
      findings.push({
        kind: 'validation',
        code: 'segment_rows_incomplete',
        message: `逐段明细读到 ${parsed.length} 行，行程单声明 ${declared ? `${declared[1]} 段` : '的段数没读到'}，对不上；整块不采用。`,
      });
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
      add(at('amount'), leg.amount, leg.cells.amount?.slice(0, 1) ?? []);
    });
    const unrouted = parsed.filter((leg) => !text(leg.cells.origin) || !text(leg.cells.destination)).map((leg) => leg.index);
    if (unrouted.length > 0) {
      findings.push({ kind: 'validation', code: 'route_incomplete', message: `第 ${unrouted.join('、')} 段的起点或终点没有完整读到，不能用半截路线。` });
    }
    return { kindLabel: '高德行程单', candidates, findings };
  },
};
