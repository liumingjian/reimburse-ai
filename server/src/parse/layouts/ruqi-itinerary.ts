import { cents } from '../../money-date';
import { allJoinedRows, compact, matchSpan, type ParseDoc } from '../doc';
import type { Layout } from '../layout';
import { parseDatedItinerary, type DatedColumn, type ItinerarySummary } from './dated-itinerary';
import { itineraryTable } from './itinerary-table';

const TABLE = itineraryTable<DatedColumn>({
  columns: [[/^车型$/, 'carType'], [/^用车时间$/, 'time'], [/^起点$/, 'origin'], [/^终点$/, 'destination'], [/^里程$/, 'distance'], [/^金额$/, 'amount']],
  required: ['carType', 'time', 'origin', 'destination', 'distance', 'amount'],
  wrapping: new Set(['carType', 'time', 'origin', 'destination', 'distance', 'amount']),
  repeatedHeader: true,
  headerTolerance: 6,
});

function summaryOf(doc: ParseDoc): ItinerarySummary | null {
  for (const row of allJoinedRows(doc)) {
    // The label is one run with holes; the count and total are painted over those holes as separate runs.
    const label = row.observations.find((o) => compact(o.text) === '行程总计:共次行程,合计');
    if (!label || !row.observations.some((o) => compact(o.text) === '元')) continue;
    const counts = row.observations.filter((o) => /^\d+$/.test(compact(o.text)));
    const totals = row.observations.filter((o) => cents(compact(o.text)) !== null);
    if (counts.length === 1 && totals.length === 1) {
      return { count: Number(compact(counts[0]!.text)), total: cents(compact(totals[0]!.text))!, observations: row.observations };
    }
  }
  return null;
}

export const ruqiItinerary: Layout = {
  kind: 'ride_itinerary', name: 'ruqi', version: '1', label: '如祺出行行程单',
  recognise: (doc) => doc.mediaType === 'pdf' && !!matchSpan(allJoinedRows(doc), /^如祺出行--行程单$/) && TABLE.hasHeader(doc),
  parse(doc) {
    const apply = matchSpan(allJoinedRows(doc), /^申请日期:(\d{4}-\d{2}-\d{2})$/);
    return parseDatedItinerary(doc, {
      name: this.name, label: this.label, version: this.version, table: TABLE, cityFromRoute: true,
      apply: apply ? { value: apply.match[1]!, observations: apply.span.observations } : null,
      summary: summaryOf(doc),
    });
  },
};
