import type { ParseOutcome } from '../dispatch';
import type { ParseExecutor } from '../executor';
import type { ParseInput } from '../material';

const MATCHING_NAME = 'uncertain-invoice-type.pdf';
// The invoice's 结账单: a 住宿 invoice without one blocks at 待确认项.
const FOLIO_NAME = 'uncertain-invoice-type-folio.pdf';

const INVOICE = {
  invoiceNumber: '26312000000101557402',
  issueDate: '2026-08-22',
  invoiceType: '定额发票',
  sellerName: '上海某某酒店管理有限公司',
  itemName: '*住宿服务*住宿费',
  netAmount: '100.00',
  taxAmount: '6.00',
  totalAmount: '106.00',
};
const FOLIO = { checkIn: '2026-08-21', checkOut: '2026-08-22', folioTotal: '106.00' };

function outcome(kind: 'vat_invoice' | 'hotel_folio', kindLabel: string, values: Record<string, string>): ParseOutcome {
  return {
    outcome: 'recognised',
    kind,
    layout: 'fixture',
    parserVersion: 'fixture',
    kindLabel,
    candidates: Object.entries(values).map(([key, value]) => ({ key, value, source: `rule:${kind}/fixture`, parserVersion: 'fixture', evidence: 'explicit' as const, refs: [] })),
    findings: [],
    missing: [],
  };
}

function parse(input: ParseInput): ParseOutcome {
  if (input.fileName === MATCHING_NAME) return outcome('vat_invoice', '全电发票', INVOICE);
  if (input.fileName === FOLIO_NAME) return outcome('hotel_folio', '酒店结账单', FOLIO);
  return { outcome: 'unrecognised', reason: 'no_layout' };
}

// This parser is only selected by the e2e entry's BAOX_PARSE_FIXTURE switch.
export function uncertainInvoiceTypeFixtureParser(): ParseExecutor {
  return {
    parse: async (input) => parse(input),
    close: async () => {},
  };
}
