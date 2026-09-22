import type { ParseOutcome } from '../dispatch';
import type { ParseExecutor } from '../executor';
import type { ParseInput } from '../material';

const MATCHING_NAME = 'uncertain-invoice-type.pdf';

function outcome(_input: ParseInput): ParseOutcome {
  const values = {
    invoiceNumber: '26312000000101557402',
    issueDate: '2026-08-22',
    invoiceType: '定额发票',
    sellerName: '上海某某酒店管理有限公司',
    itemName: '*住宿服务*住宿费',
    netAmount: '100.00',
    taxAmount: '6.00',
    totalAmount: '106.00',
  };
  return {
    outcome: 'recognised',
    kind: 'vat_invoice',
    layout: 'fixture',
    parserVersion: 'fixture',
    kindLabel: '全电发票',
    candidates: Object.entries(values).map(([key, value]) => ({ key, value, source: 'rule:vat_invoice/fixture', parserVersion: 'fixture', evidence: 'explicit' as const, refs: [] })),
    findings: [],
    missing: [],
  };
}

// This parser is only selected by the e2e entry's BAOX_PARSE_FIXTURE switch.
export function uncertainInvoiceTypeFixtureParser(): ParseExecutor {
  return {
    parse: async (input) => (input.fileName === MATCHING_NAME ? outcome(input) : { outcome: 'unrecognised', reason: 'no_layout' }),
    close: async () => {},
  };
}
