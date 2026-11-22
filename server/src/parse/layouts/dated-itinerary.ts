import { cents, isoDate, money } from '../../money-date';
import type { ParseDoc, TextObservation } from '../doc';
import { evidenceRef, ruleSource, type Candidate, type Finding, type LayoutResult } from '../layout';
import { cellRaw, cellText, type ItineraryTable } from './itinerary-table';

// Baidu and Ruqi print full dates in wrapped trip cells. Their layouts own titles, headers and summary extraction;
// this reader adopts the table only when every declared trip has a valid date, positive amount and exact total.
export type DatedColumn = 'time' | 'carrier' | 'carType' | 'city' | 'origin' | 'destination' | 'distance' | 'amount';
export type ItinerarySummary = { count: number; total: number; observations: readonly TextObservation[] };

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/;

// Only an explicit municipal prefix counts; an address containing a city name later is not city evidence.
function sameRouteCity(origin: string | null, destination: string | null): string | null {
  const prefix = (value: string | null) => /^([\p{Script=Han}]{2,8}?市)/u.exec(value ?? '')?.[1] ?? null;
  const from = prefix(origin);
  return from && !/(省|自治区|自治州|地区)/.test(from) && from === prefix(destination) ? from : null;
}

export function parseDatedItinerary(doc: ParseDoc, options: {
  name: string;
  label: string;
  version: string;
  table: ItineraryTable<DatedColumn>;
  summary: ItinerarySummary | null;
  apply: { value: string; observations: readonly TextObservation[] } | null;
  cityFromRoute?: boolean;
}): LayoutResult {
  const { name, label: kindLabel, version, table, summary, apply } = options;
  const source = ruleSource('ride_itinerary', name);
  const candidates: Candidate[] = [];
  const findings: Finding[] = [];
  const add = (key: string, value: string | null | undefined, observations: readonly TextObservation[], derived = false) => {
    if (value) candidates.push({ key, value, source: derived ? ruleSource('ride_itinerary', name, 'city_from_endpoints') : source, parserVersion: version, evidence: derived ? 'derived' : 'explicit', refs: evidenceRef(observations) });
  };
  if (apply) add('applyDate', apply.value, apply.observations);
  if (summary) {
    add('segmentCount', String(summary.count), summary.observations);
    add('itineraryTotal', money(summary.total), summary.observations);
  }
  const legs = table.legs(doc).map(({ index, cells }) => {
    const time = DATE_TIME.exec(cellText(cells.time));
    const date = time ? isoDate(Number(time[1]), Number(time[2]), Number(time[3])) : null;
    const amount = cents(cellText(cells.amount).replace(/元$/, ''));
    return { index, cells, date, time: time?.[4], amount: amount !== null && amount > 0 ? amount : null };
  });
  const refuse = (code: string, message: string) => findings.push({ kind: 'validation', code, message });
  if (!summary || summary.count <= 0 || legs.length !== summary.count) {
    refuse('segment_rows_incomplete', `逐段明细读到 ${legs.length} 行，行程单声明${summary ? ` ${summary.count} 笔` : '的笔数没读到'}；整块不采用。`);
  }
  legs.forEach((leg, i) => {
    const no = i + 1;
    if (leg.index !== no) refuse(`segment_index_unexpected.${no}`, `第 ${no} 段的序号读成了 ${leg.index}；整块不采用。`);
    if (!leg.date) refuse(`segment_field_unreadable.${no}.date`, `第 ${no} 段的用车日期没读到有效值；整块不采用。`);
    if (leg.amount === null) refuse(`segment_field_unreadable.${no}.amount`, `第 ${no} 段的金额没读到；整块不采用。`);
  });
  if (summary && legs.length > 0 && legs.every((leg) => leg.amount !== null)) {
    const sum = legs.reduce((acc, leg) => acc + (leg.amount ?? 0), 0);
    if (sum !== summary.total) refuse('segment_total_mismatch', `逐段金额合计 ${money(sum)}，行程单合计 ${money(summary.total)}，对不上；整块不采用。`);
  }
  if (findings.length > 0) return { kindLabel, candidates, findings };

  legs.forEach((leg, i) => {
    const at = (field: string) => `segments[${i}].${field}`;
    const origin = cellRaw(leg.cells.origin);
    const destination = cellRaw(leg.cells.destination);
    add(at('date'), leg.date, leg.cells.time ?? []);
    add(at('time'), leg.time, leg.cells.time ?? []);
    for (const field of ['carrier', 'carType', 'origin', 'destination'] as const) add(at(field), cellRaw(leg.cells[field]), leg.cells[field] ?? []);
    if (options.cityFromRoute) {
      add(at('city'), sameRouteCity(origin, destination), [...(leg.cells.origin ?? []), ...(leg.cells.destination ?? [])], true);
    } else add(at('city'), cellRaw(leg.cells.city), leg.cells.city ?? []);
    add(at('amount'), leg.amount === null ? null : money(leg.amount), leg.cells.amount ?? []);
    if (!origin || !destination) refuse(`route_incomplete.${i + 1}`, `第 ${i + 1} 段的起点或终点没有完整读到，不能用半截路线。`);
  });
  return { kindLabel, candidates, findings };
}
