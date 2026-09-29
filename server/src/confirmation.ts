import { createHash } from 'node:crypto';
import type { Confirmation, Line } from '@baox/contract';
import type { PinnedProject } from './assignment';
import { contentHash, type CompanyRules } from './rules/company-rules';

// 整单明细确认 (whole-list detail confirmation), ADR-0014: the stored fact is `{digest, confirmedAt}`; the status is
// derived by comparing the latest stored digest with the digest of the current facts, so reverting a change revives
// the confirmation. A `reopen-upload` after the confirmation voids it for good (a new version is on its way).
//
// The digest covers everything that reaches ERP or the print sheet: the lines as listed (with project, expense item,
// presentation values), the standing project submission and purpose, the pinned company rules and project catalog,
// and the task's home city. #190 (print) and #191 (ERP) act on `snapshot.lines` only while the status is `confirmed`.
// The snapshot's `confirmation` section is worded in `task-snapshot/confirmation.ts`.

// What a confirmation is made over. `lines` are the lines as the snapshot lists them (after `enrichLines`).
export type ConfirmationInput = {
  lines: readonly Line[];
  purpose: string;
  selection: Readonly<Record<string, PinnedProject>>;
  // `<source>:<number>` of every project the books offer now (#194). A pinned project that is no longer offered (a
  // deactivated public project) changes the project half, so a confirmation made over it is invalidated.
  selectable: ReadonlySet<string>;
  rules: CompanyRules;
  catalogHash: string;
  homeCity: string;
};

// The digest, and its two halves: which half moved picks the invalidation notice.
export type ConfirmationDigest = { digest: string; detail: string; project: string };

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

export function confirmationDigest(input: ConfirmationInput): ConfirmationDigest {
  // Project fields ride on the lines, but they belong to the project half.
  const lines = input.lines.map(({ projectCode: _code, projectName: _name, ...line }) => line);
  const detail = sha({ lines, rules: contentHash(input.rules), homeCity: input.homeCity });
  const selection = input.lines.map((line) => {
    const pin = input.selection[line.lineId] ?? null;
    return [line.lineId, pin, pin !== null && input.selectable.has(`${pin.source}:${pin.number}`)];
  });
  const project = sha({ purpose: input.purpose, selection, catalog: input.catalogHash });
  return { digest: sha([detail, project]), detail, project };
}

// A stored confirmation (`review_confirmation` row).
export type ConfirmationFact = { digest: string; detail: string; project: string; confirmedAt: string; revision: number };

export type ConfirmationStatus = Confirmation['status'];

// `current` is null while there is nothing to confirm (no standing submission, or upload reopened).
export function confirmationStatus(current: ConfirmationDigest | null, latest: ConfirmationFact | null, lastReopenRevision: number | null): ConfirmationStatus {
  if (!latest) return 'unconfirmed';
  if (lastReopenRevision !== null && lastReopenRevision > latest.revision) return 'invalidated';
  return current?.digest === latest.digest ? 'confirmed' : 'invalidated';
}
