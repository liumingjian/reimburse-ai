import type { MaterialKind } from '@baox/contract';
import type { ParseDoc } from './doc';
import { KINDS } from './kinds';
import { layoutId, type Candidate, type Finding, type Layout } from './layout';

// Hard-anchor dispatch (ADR-0017): exactly one recognising layout parses; none → unrecognised; several → ambiguous,
// which the inventory view turns into a blocking 待确认项. First match never wins.
//
// The parser outcome is `recognised | unrecognised | failed{retryable}`; `ambiguous` is the dispatch result for
// several matches. Outcomes are stored as JSON facts (`parse_result.detail`), so keep them plain data.

export type Recognised = {
  outcome: 'recognised';
  kind: MaterialKind;
  layout: string;
  parserVersion: string;
  kindLabel: string;
  candidates: Candidate[];
  findings: Finding[];
  // Required slots of the kind that no candidate fills: `missing_required`.
  missing: string[];
};
export type Unrecognised = { outcome: 'unrecognised'; reason: 'no_layout' | 'unreadable_document' };
export type Ambiguous = { outcome: 'ambiguous'; layouts: { id: string; label: string }[] };
// `retryable`: a re-run may succeed (worker crash, OCR runtime failure); otherwise the material itself is the problem.
export type Failed = { outcome: 'failed'; retryable: boolean; reason: string };
export type ParseOutcome = Recognised | Unrecognised | Ambiguous | Failed;

export function dispatch(doc: ParseDoc, layouts: readonly Layout[]): ParseOutcome {
  const matches = layouts.filter((layout) => layout.recognise(doc));
  const [layout] = matches;
  if (!layout) return { outcome: 'unrecognised', reason: 'no_layout' };
  if (matches.length > 1) return { outcome: 'ambiguous', layouts: matches.map((match) => ({ id: layoutId(match), label: match.label })) };
  const result = layout.parse(doc);
  const filled = new Set(result.candidates.filter((c) => c.value !== '').map((c) => c.key));
  return {
    outcome: 'recognised',
    kind: layout.kind,
    layout: layout.name,
    parserVersion: layout.version,
    kindLabel: result.kindLabel,
    candidates: result.candidates,
    findings: result.findings,
    missing: KINDS[layout.kind].slots.filter((slot) => slot.required && !filled.has(slot.key)).map((slot) => slot.key),
  };
}
