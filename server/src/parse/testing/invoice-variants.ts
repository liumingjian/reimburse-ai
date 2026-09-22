import type { ParseOutcome } from '../dispatch';
import type { ParseExecutor } from '../executor';
import type { ParseInput } from '../material';

const MATCHING_NAMES = new Set(['variant-match.pdf', 'variant-match.jpg', 'variant-conflict.pdf', 'variant-conflict.jpg']);

function railOutcome(input: ParseInput): ParseOutcome {
  const totalAmount = input.fileName === 'variant-conflict.jpg' ? '183.00' : '182.00';
  const values = {
    invoiceNumber: '26202609000000002811',
    issueDate: '2026-09-01',
    trainNumber: 'G281',
    departStation: '杭州东',
    arriveStation: '上海虹桥',
    travelDate: '2026-09-02',
    totalAmount,
  };
  return {
    outcome: 'recognised',
    kind: 'rail_ticket',
    layout: 'fixture',
    parserVersion: 'fixture',
    kindLabel: '铁路电子客票',
    candidates: Object.entries(values).map(([key, value]) => ({ key, value, source: 'rule:rail_ticket/fixture', parserVersion: 'fixture', evidence: 'explicit' as const, refs: [] })),
    findings: [],
    missing: [],
  };
}

// This parser is only selected by the e2e entry's BAOX_PARSE_FIXTURE switch and by focused service tests.
export function invoiceVariantFixtureParser(): ParseExecutor {
  return {
    parse: async (input) => (MATCHING_NAMES.has(input.fileName) ? railOutcome(input) : { outcome: 'unrecognised', reason: 'no_layout' }),
    close: async () => {},
  };
}
