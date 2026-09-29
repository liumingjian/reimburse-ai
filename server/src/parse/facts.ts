import type { MaterialKind } from '@baox/contract';
import { ruleSource, type Candidate } from './layout';

// The one place that decides which candidate is a material's read value (#311). The inventory view shows it and the
// private-corpus gate scores it, so the UI and the accuracy gate cannot disagree about what was read.
//
// Precedence per key, first non-empty value wins:
//   1. the layout's own face read (`rule:<kind>/<layout>`);
//   2. a value the layout derived from other face facts (`rule:<kind>/<layout>.<derivation>`);
//   3. any other source — a second evidence source such as the QR code of a fully-digitalised VAT e-invoice
//      (全电发票) — which only fills what the face lacks.
// Ties keep candidate order. A manual fill (`layout: null`) has only `user` candidates, so order alone decides.
//
// A conflict is a key the layout itself reads two ways (face and derivation, or two face reads, disagreeing): no value
// of it is a correct read. A second source disagreeing with the face is not a conflict — the face wins, and the layout
// reports the disagreement as an advisory (ADR-0017, amended).

export type FactsInput = { kind: MaterialKind; layout: string | null; candidates: readonly Candidate[] };
// Which precedence rank supplied a value: the layout's face read, its derivation, or another source (the QR, a user).
export type FactOrigin = 'face' | 'derived' | 'other';
export type Facts = {
  values: Record<string, string>;
  // The source of each value in `values`.
  sources: Record<string, string>;
  // The rank each value in `values` won at. The private-corpus gate scores only the layout's own reads (`face`,
  // `derived`): a value the QR filled in is shown to the employee, but it is not the layout reading the face.
  origins: Record<string, FactOrigin>;
  conflicts: string[];
};

const ORIGINS: readonly FactOrigin[] = ['face', 'derived', 'other'];

export function factsOf(outcome: FactsInput): Facts {
  const face = outcome.layout === null ? null : ruleSource(outcome.kind, outcome.layout);
  const rank = (source: string) => (face === null ? 2 : source === face ? 0 : source.startsWith(`${face}.`) ? 1 : 2);
  const winners = new Map<string, { candidate: Candidate; rank: number }>();
  const ownReads = new Map<string, Set<string>>();
  for (const candidate of outcome.candidates) {
    if (candidate.value === '') continue;
    const r = rank(candidate.source);
    const best = winners.get(candidate.key);
    if (!best || r < best.rank) winners.set(candidate.key, { candidate, rank: r });
    if (r < 2) ownReads.set(candidate.key, (ownReads.get(candidate.key) ?? new Set()).add(candidate.value));
  }
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const origins: Record<string, FactOrigin> = {};
  for (const [key, { candidate, rank: r }] of winners) {
    values[key] = candidate.value;
    sources[key] = candidate.source;
    origins[key] = ORIGINS[r] ?? 'other';
  }
  const conflicts = [...ownReads].filter(([, read]) => read.size > 1).map(([key]) => key);
  return { values, sources, origins, conflicts };
}

// Whether a source is a value the layout derived rather than read off the face (`rule:<kind>/<layout>.<derivation>`).
export const isDerivedSource = (source: string): boolean => /^rule:[^/]+\/[^.]+\./.test(source);
