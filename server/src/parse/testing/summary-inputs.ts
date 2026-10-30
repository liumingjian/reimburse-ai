import type { ParseExecutor } from '../executor';
import type { Recognised } from '../dispatch';

function recognised(kind: Recognised['kind'], values: Record<string, string>): Recognised {
  return { outcome: 'recognised', kind, layout: 'fixture', parserVersion: 'fixture', kindLabel: kind,
    candidates: Object.entries(values).map(([key, value]) => ({ key, value, source: `rule:${kind}/fixture`, parserVersion: 'fixture', evidence: 'explicit', refs: [] })), findings: [], missing: [] };
}

// Synthetic evidence for the summary input journey; selected only by the e2e entry.
export function summaryInputsFixtureParser(): ParseExecutor {
  return { async parse(input) {
    const prefix = input.fileName.slice(0, 3);
    switch (prefix) {
      case 'm01': return recognised('vat_invoice', { invoiceNumber: '26312000000098127734', issueDate: '2026-08-09', invoiceType: '普票', sellerName: '测试酒店', itemName: '*住宿服务*住宿费', totalAmount: '123.45', netAmount: '123.45', taxAmount: '0.00' });
      case 'm02': return recognised('hotel_folio', { checkIn: '2026-08-09', checkOut: '2026-08-09', folioTotal: '123.45' });
      case 'm03': return recognised('vat_invoice', { invoiceNumber: '26312000000101557402', issueDate: '2026-08-13', invoiceType: '普票', sellerName: '测试出行公司', itemName: '*运输服务*客运服务费', totalAmount: '30.50', netAmount: '30.50', taxAmount: '0.00' });
      case 'm04': return recognised('ride_itinerary', { applyDate: '2026-08-13', segmentCount: '2', itineraryTotal: '30.50', 'segments[0].date': '2026-08-10', 'segments[0].city': '上海', 'segments[0].origin': '车站', 'segments[0].destination': '酒店', 'segments[0].amount': '10.20', 'segments[1].date': '2026-08-10', 'segments[1].city': '杭州', 'segments[1].origin': '车站', 'segments[1].destination': '酒店', 'segments[1].amount': '20.30' });
      default: return { outcome: 'unrecognised', reason: 'no_layout' };
    }
  }, async close() {} };
}
