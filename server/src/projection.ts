import type { Blocker, Step, TaskStage } from '@baox/contract';
import type { TaskLifecycle } from './db/schema';

// The pure projection of ADR-0014: stored facts in, `{stage, step, blockers}` out. No stage is ever stored.
// Later slices add facts (jobs, pending answers, confirmation, ERP attempts) and grow this function; keep it pure so
// the state machine stays testable without a database.

export type TaskFacts = {
  taskId: string;
  revision: number;
  lifecycle: TaskLifecycle;
  // Current 盘点版本 (inventory version): the number of upload batches that added at least one material. 0 = none.
  versionNo: number;
  // Uploaded materials that are not excluded.
  includedMaterialCount: number;
  // The latest start-inventory run, and the revision it was accepted at.
  lastRun: { versionNo: number; revision: number } | null;
  // Revision of the latest reopen-upload, or null.
  lastReopenRevision: number | null;
};

export type Projection = { stage: TaskStage; step: Step; blockers: Blocker[] };

// stepToken is per task: taskId + the revision bumped on every accepted fact change (ADR-0014).
export function stepToken(taskId: string, revision: number): string {
  return `${taskId}.${revision}`;
}

// The current version has been inventoried and upload was not reopened since.
export function inventoried(facts: TaskFacts): boolean {
  const run = facts.lastRun;
  if (!run || run.versionNo !== facts.versionNo) return false;
  return facts.lastReopenRevision === null || facts.lastReopenRevision < run.revision;
}

export function project(facts: TaskFacts): Projection {
  const at = (stage: TaskStage, kind: Step['kind']): Projection => ({ stage, step: { kind, stepToken: stepToken(facts.taskId, facts.revision) }, blockers: [] });
  if (facts.lifecycle === 'voided') return at('voided', 'none');
  // 转人工 (handed off to a human) projects to reconcile, read-only (ADR-0014).
  if (facts.lifecycle === 'handed_off') return at('reconcile', 'none');
  // Parsing lands in #183; until then an inventoried version rests in stage inventory with nothing left to do.
  if (inventoried(facts)) return at('inventory', 'none');
  return at('upload', facts.includedMaterialCount > 0 ? 'start_inventory' : 'upload_materials');
}

// At most one non-terminal task per account (ADR-0018). The derived terminal 草稿已交接 (draft handed over) joins
// this rule when the ERP job lands (#192).
export function isNonTerminal(lifecycle: TaskLifecycle): boolean {
  return lifecycle === 'open';
}
