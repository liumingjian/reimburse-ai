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
  // The parser job on the current run (#183): included materials still waiting for an outcome, and the open
  // 待确认项 derived from the outcomes. null while the current version is not inventoried.
  // `blockers`: invoices of this inventory held by another task (发票占用); any stops the whole batch.
  parse: { waiting: number; openPendingItems: number; blockers: Blocker[] } | null;
  // 项目归属 (#188) once the inventory is clean: candidate lines, selectable projects in the books, lines in the working
  // draft, and whether a submission still stands on the current lines. null before that.
  project: { lineCount: number; selectableCount: number; workingCount: number; submitted: boolean } | null;
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

// The background parser job is working on the current run. While it runs the step is none and every mutation other
// than the job's own gets 409 (ADR-0014).
export function parseRunning(facts: TaskFacts): boolean {
  return inventoried(facts) && (facts.parse?.waiting ?? 0) > 0;
}

export function project(facts: TaskFacts): Projection {
  const at = (stage: TaskStage, kind: Step['kind']): Projection => ({ stage, step: { kind, stepToken: stepToken(facts.taskId, facts.revision) }, blockers: [] });
  if (facts.lifecycle === 'voided') return at('voided', 'none');
  // 转人工 (handed off to a human) projects to reconcile, read-only (ADR-0014).
  if (facts.lifecycle === 'handed_off') return at('reconcile', 'none');
  if (inventoried(facts)) {
    if (parseRunning(facts)) return at('inventory', 'none');
    // A cross-task duplicate stops the batch: no events, no pending items; the way out is excluding the material.
    const blockers = facts.parse?.blockers ?? [];
    if (blockers.length > 0) return { ...at('inventory', 'none'), blockers };
    if ((facts.parse?.openPendingItems ?? 0) > 0) return at('pending', 'answer_pending');
    const project = facts.project;
    // A clean inventory without any candidate line has nothing to assign.
    if (!project || project.lineCount === 0) return at('inventory', 'none');
    // #189 owns what follows the submission (confirm-review); reassigning stays open under confirm_review.
    if (project.submitted) return at('review', 'confirm_review');
    // Kernel project_book_empty: nothing selectable and nothing drafted yet → maintain the book first.
    if (project.selectableCount === 0 && project.workingCount === 0) return at('project', 'maintain_project_book');
    return at('project', 'assign_projects');
  }
  return at('upload', facts.includedMaterialCount > 0 ? 'start_inventory' : 'upload_materials');
}

// At most one non-terminal task per account (ADR-0018). The derived terminal 草稿已交接 (draft handed over) joins
// this rule when the ERP job lands (#192).
export function isNonTerminal(lifecycle: TaskLifecycle): boolean {
  return lifecycle === 'open';
}
