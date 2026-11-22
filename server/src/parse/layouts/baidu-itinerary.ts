import { cents } from '../../money-date';
import { allJoinedRows, matchSpan } from '../doc';
import type { Layout } from '../layout';
import { parseDatedItinerary, type DatedColumn } from './dated-itinerary';
import { itineraryTable } from './itinerary-table';

const TABLE = itineraryTable<DatedColumn>({
  columns: [[/^用车时间$/, 'time'], [/^服务方$/, 'carrier'], [/^车型$/, 'carType'], [/^城市$/, 'city'], [/^起点$/, 'origin'], [/^终点$/, 'destination'], [/^可开票金额$/, 'amount']],
  required: ['time', 'carrier', 'carType', 'city', 'origin', 'destination', 'amount'],
  wrapping: new Set(['time', 'carrier', 'carType', 'city', 'origin', 'destination', 'amount']),
  repeatedHeader: true,
});

export const baiduItinerary: Layout = {
  kind: 'ride_itinerary', name: 'baidu', version: '1', label: '百度地图行程单',
  recognise: (doc) => doc.mediaType === 'pdf' && !!matchSpan(allJoinedRows(doc), /^百度地图打车行程单$/) && TABLE.hasHeader(doc),
  parse(doc) {
    const lines = allJoinedRows(doc);
    const apply = matchSpan(lines, /^申请日期:(\d{4}-\d{2}-\d{2})$/);
    const summary = matchSpan(lines, /^共(\d+)笔行程,合计([\d,]+\.\d{2})元(?:\(不含附加费、已减免优惠金额\))?$/);
    const total = summary?.match[2] ? cents(summary.match[2]) : null;
    return parseDatedItinerary(doc, {
      name: this.name, label: this.label, version: this.version, table: TABLE,
      apply: apply ? { value: apply.match[1]!, observations: apply.span.observations } : null,
      summary: summary && total !== null ? { count: Number(summary.match[1]), total, observations: summary.span.observations } : null,
    });
  },
};
