import type { EvidenceState, MaterialKind } from '@baox/contract';
import type { ParseDoc } from './doc';

// The contract of a 版式 (layout) parser (ADR-0017). A layout belongs to one 材料种类 (material kind), recognises on
// hard anchors only, and extracts candidates. It never decides roles, events or pending items: the kind and the
// inventory view do. Adding a layout = one module exporting a `Layout` + one line in `layouts/index.ts`.

export type EvidenceRef = { page: number; observationIds: string[]; text: string };

export type Candidate = {
  // A slot key of the kind (`slots.ts`); segment slots are keyed `segments[i].<field>`.
  key: string;
  value: string;
  // `rule:<kind>/<layout>` (see `ruleSource`), optionally `.<derivation>` for a derived value.
  source: string;
  parserVersion: string;
  evidence: EvidenceState;
  refs: EvidenceRef[];
};

// What a layout found besides candidates. `validation` (a deterministic check failed) becomes a blocking 待确认项;
// `advisory` only shows in the material's check text.
//
// There is no longer a `conflict` kind for two sources disagreeing (#20). Its only producer was the 全电发票 QR
// check, and the QR no longer judges the face (ADR-0017, amended): a disagreement between them is an advisory.
export type Finding =
  | { kind: 'validation'; code: string; message: string }
  | { kind: 'advisory'; code: string; message: string };

export type LayoutResult = {
  // The 识别为 (recognised as) label shown per material, e.g. 全电发票（专票）.
  kindLabel: string;
  candidates: Candidate[];
  findings: Finding[];
};

export type Layout = {
  kind: MaterialKind;
  // Unique within the kind; `[a-z0-9_]+` (contract LAYOUT_NAME_PATTERN).
  name: string;
  // Bump on any change to what `parse` extracts; stored with every candidate as `parserVersion`.
  version: string;
  // Shown when several layouts match one material.
  label: string;
  // Hard anchors only: fixed titles, number formats, table headers. No scoring, no fallbacks.
  recognise(doc: ParseDoc): boolean;
  parse(doc: ParseDoc): LayoutResult;
};

export const layoutId = (layout: Pick<Layout, 'kind' | 'name'>): string => `${layout.kind}/${layout.name}`;

export function ruleSource(kind: MaterialKind, layout: string, derivation?: string): string {
  return `rule:${kind}/${layout}${derivation ? `.${derivation}` : ''}`;
}
