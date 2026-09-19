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
  // An imported legacy task (#195, lifecycle `handed_off`): its terminal, ERP 草稿已交接 or 转人工.
  legacyOutcome?: 'draft_handed_over' | 'handed_off';
  // 整单明细确认 (#189): derived by digest comparison (`confirmation.ts`); only `confirmed` moves past review.
  confirmation: 'unconfirmed' | 'confirmed' | 'invalidated';
  // 去报销 (#191): the latest fill job of the task (`erp/fill-state.ts`); absent or null before the first one.
  erp?: ErpFacts | null;
};

// The phase of a task's latest fill job, derived from its result (none yet = running) and a cancel of its login pause.
// `handed_over`: the filled, unsaved form passed the strict read-back, ERP 草稿已交接 (terminal, ADR-0028).
// `saved`: a 对账 (reconcile) proved the employee's own save, or a legacy import recorded one — also terminal.
// `unknown`: ERP 写入结果未知 after an attempt, reconcile. `aborted` / `catalog_mismatch` / `cancelled`: nothing
// was written.
export type ErpPhase = 'running' | 'waiting_login' | 'cancelled' | 'catalog_mismatch' | 'aborted' | 'handed_over' | 'saved' | 'unknown';

export type ErpFacts = {
  jobId: string;
  trigger: 'start' | 'confirm_login';
  // The revision the job was accepted at.
  revision: number;
  phase: ErpPhase;
  // A catalog mismatch that no later project submission answered yet: back to project assignment.
  reassign: boolean;
  // A read-only 对账 (reconcile) job runs on this fill (#192): like a running job, only its own writes pass.
  reconciling: boolean;
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
  // A legacy task whose ERP draft was saved imports as ERP 草稿已交接 (draft handed over): done, read-only.
  if (facts.legacyOutcome === 'draft_handed_over') return at('done', 'none');
  // 转人工 (handed off to a human) projects to reconcile, read-only (ADR-0014).
  if (facts.lifecycle === 'handed_off') return at('reconcile', 'none');
  // 去报销: a saved draft is ERP 草稿已交接 (done); a write result unknown stops in reconcile; a running job or its
  // login pause is the erp stage. Everything else about the job leaves the task where its other facts put it.
  switch (facts.erp?.phase) {
    case 'handed_over':
    case 'saved':
      return at('done', 'none');
    case 'unknown':
      return at('reconcile', facts.erp.reconciling ? 'none' : 'reconcile');
    case 'running':
      return at('erp', 'none');
    case 'waiting_login':
      return at('erp', 'erp_login');
    default:
      break;
  }
  if (inventoried(facts)) {
    if (parseRunning(facts)) return at('inventory', 'none');
    // A cross-task duplicate stops the batch: no events, no pending items; the way out is excluding the material.
    const blockers = facts.parse?.blockers ?? [];
    if (blockers.length > 0) return { ...at('inventory', 'none'), blockers };
    if ((facts.parse?.openPendingItems ?? 0) > 0) return at('pending', 'answer_pending');
    const project = facts.project;
    // A clean inventory without any candidate line has nothing to assign.
    if (!project || project.lineCount === 0) return at('inventory', 'none');
    // A catalog mismatch found by the ERP job sends the task back to assignment until the next submission.
    if (project.submitted && facts.erp?.reassign) return at('project', 'assign_projects');
    // Reassigning stays open under confirm_review and choose_action, and invalidates a confirmation.
    if (project.submitted) return facts.confirmation === 'confirmed' ? at('actions', 'choose_action') : at('review', 'confirm_review');
    // Kernel project_book_empty: nothing selectable and nothing drafted yet → maintain the book first.
    if (project.selectableCount === 0 && project.workingCount === 0) return at('project', 'maintain_project_book');
    return at('project', 'assign_projects');
  }
  return at('upload', facts.includedMaterialCount > 0 ? 'start_inventory' : 'upload_materials');
}

// At most one non-terminal task per account (ADR-0018). Terminal: voided, handed off (转人工, a lifecycle), and the
// derived ERP 草稿已交接 (a saved fill job). A write result unknown is not terminal: reconcile still owns it.
export function isNonTerminal(lifecycle: TaskLifecycle, erpPhase: ErpPhase | null = null): boolean {
  return lifecycle === 'open' && erpPhase !== 'handed_over' && erpPhase !== 'saved';
}
