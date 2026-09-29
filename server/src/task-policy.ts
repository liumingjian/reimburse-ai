import { CONFIRM_REVIEW_ERRORS, ERP_ACTION_ERRORS, PROJECT_ASSIGNMENT_ERRORS, type Blocker, type Step, type TaskStage } from '@baox/contract';
import type { TaskLifecycle, TaskOrigin } from './db/schema';
import type { ErpRecord } from './erp/fill-state';

// The task policy: the one owner of task-state rules. Pure: loaded 任务事实 (task facts, `task-facts.ts`) in,
// `{stage, step, blockers}` and the write admission of every action out. No stage is ever stored (ADR-0014), so a
// "wrong stage", "stuck" or "why was this refused" bug is a row in `task-policy.test.ts`, not a database fixture.
// The ERP phase and allowed-action rules (erp/fill-state.ts) and the void gate (tasks.ts `voidOne`) are not here yet.

export type TaskFacts = {
  taskId: string;
  revision: number;
  lifecycle: TaskLifecycle;
  // `legacy`: imported by #195; it has no materials, so not even print reaches it.
  origin: TaskOrigin;
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
  // An imported legacy task (#195, lifecycle `handed_off`): its terminal, ERP 单据已交接 or 转人工.
  legacyOutcome?: 'draft_handed_over' | 'handed_off';
  // 整单明细确认 (#189): derived by digest comparison (`confirmation.ts`); only `confirmed` moves past review.
  confirmation: 'unconfirmed' | 'confirmed' | 'invalidated';
  // 去报销 (#191): the latest fill job of the task (`erp/fill-state.ts`); absent or null before the first one.
  erp?: ErpFacts | null;
};

// The phase of a task's latest fill job, derived from its result (none yet = running) and a cancel of its login pause.
// `handed_over`: the filled, unsaved form passed the strict read-back, ERP 单据已交接 (terminal, ADR-0028).
// `saved`: a 对账 (reconcile) proved the employee's own save, or a legacy import recorded one — also terminal.
// `unknown`: ERP 写入结果未知 after an attempt, reconcile. `aborted` / `catalog_mismatch` / `cancelled`: nothing
// was written.
export type ErpPhase = 'running' | 'waiting_login' | 'cancelled' | 'catalog_mismatch' | 'aborted' | 'handed_over' | 'saved' | 'unknown';

export type ErpFacts = {
  jobId: string;
  trigger: 'start' | 'confirm_login' | 'refill';
  // The revision the job was accepted at.
  revision: number;
  phase: ErpPhase;
  // A catalog mismatch that no later project submission answered yet: back to project assignment.
  reassign: boolean;
  // A read-only 对账 (reconcile) job runs on this fill (#192): like a running job, only its own writes pass.
  reconciling: boolean;
};

export const ACTION_COPY = {
  taskClosed: '这个报销任务已作废或已结束，不能再改动。',
  notReadyToStart: '现在还不能开始材料盘点：没有未盘点的材料。',
  notReopenable: '还没有开始材料盘点，不需要重新打开上传。',
  materialNotFound: '这个任务里没有这份材料。',
  alreadyExcluded: '这份材料已经排除。',
  notAnswering: '现在没有可以答复的待确认项。',
  itemNotFound: '这次盘点没有这个待确认项。',
} as const;

export type Refusal = { code: string; message: string };

// Every write the task service accepts, by name. `job` is the ERP job's own write and the book-change revision bump;
// `record_parse` is the parser job's.
export type ActionName =
  | 'upload'
  | 'start_inventory'
  | 'reopen_upload'
  | 'confirm_review'
  | 'exclude_material'
  | 'answer_pending'
  | 'set_home_city'
  | 'assign_project_lines'
  | 'submit_project_assignment'
  | 'start_erp_write'
  | 'confirm_login'
  | 'refill'
  | 'cancel_erp_write'
  | 'reconcile'
  | 'hand_off'
  | 'print'
  | 'job'
  | 'record_parse';

// 'stale' is the HTTP 409 of ADR-0014 (a stale stepToken, or any foreign write while a job runs); a Refusal is a 400.
export type Admission = 'ok' | 'stale' | Refusal;

export type Projection = { stage: TaskStage; step: Step; blockers: Blocker[] };

export type TaskPolicy = Projection & {
  // `stepToken` null: the action carries none (upload, the jobs' writes, print, which commits on the revision it read).
  admit(action: ActionName, stepToken: string | null): Admission;
};

// What sets an action apart at the gate.
// `job`: the parser or ERP job's own write, allowed while a job runs. `loginPause`: accepted during an ERP login
// pause. `erpAction`: accepted after an ERP action attempt (reconcile, hand-off, the refill of ADR-0027).
// `printOnly`: a 去打印 adjustment. Print never touches ERP (stories 57 and 63), so it stays open after 转人工 and
// after the draft was handed over; it still stops at 任务作废, at an imported legacy task, and while a job runs.
// `ownsFreeze`: this action refuses a frozen task itself, with a reason of its own (修改常驻城市 says the home city is
// locked, 追加材料 says why it cannot reopen). The central freeze would otherwise answer first and replace those with
// the generic one.
// `ready`: the action's own precondition on the task's facts, checked once the gate let it through.
type Traits = {
  job?: boolean;
  loginPause?: boolean;
  erpAction?: boolean;
  printOnly?: boolean;
  ownsFreeze?: boolean;
  ready?: (facts: TaskFacts, step: Step['kind']) => Refusal | null;
};

const TASK_CLOSED: Refusal = { code: 'task_closed', message: ACTION_COPY.taskClosed };
const ERP_STARTED: Refusal = { code: 'erp_started', message: ERP_ACTION_ERRORS.erpStarted };
// A refusal the parser job expects when the run moved on under it; never shown to anyone.
export const STALE_JOB: Refusal = { code: 'stale_job', message: 'the inventory run changed under the parser job' };

const atStep =
  (steps: readonly Step['kind'][], refusal: Refusal) =>
  (_facts: TaskFacts, step: Step['kind']): Refusal | null =>
    steps.includes(step) ? null : refusal;

// Steps under which the assignment draft and the submission may change: before confirmation and after it (a change
// invalidates the confirmation). The freeze stops every change once a fill job made an ERP action attempt.
const assigning = atStep(['assign_projects', 'confirm_review', 'choose_action'], { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady });

// The 去报销 actions (start, confirm_login, refill, cancel, reconcile, hand-off) still check their ERP phase and 对账
// verdict inside their own change, against the loaded ERP record: the ERP allowed-action rules are not folded in yet.
const ACTIONS: Record<ActionName, Traits> = {
  upload: {},
  start_inventory: { ready: atStep(['start_inventory'], { code: 'not_ready', message: ACTION_COPY.notReadyToStart }) },
  reopen_upload: { ownsFreeze: true, ready: (facts) => (inventoried(facts) ? null : { code: 'not_ready', message: ACTION_COPY.notReopenable }) },
  confirm_review: { ready: atStep(['confirm_review'], { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady }) },
  exclude_material: {},
  // A batch stopped by 发票占用 has no pending items to answer; excluding the held material is the way out.
  answer_pending: { ready: (facts) => (facts.parse && facts.parse.blockers.length === 0 ? null : { code: 'not_ready', message: ACTION_COPY.notAnswering }) },
  set_home_city: { ownsFreeze: true },
  assign_project_lines: { ready: assigning },
  submit_project_assignment: { ready: assigning },
  start_erp_write: {},
  confirm_login: { loginPause: true },
  refill: { erpAction: true },
  cancel_erp_write: { loginPause: true },
  reconcile: { erpAction: true },
  hand_off: { erpAction: true },
  print: { printOnly: true },
  job: { job: true },
  record_parse: { job: true, ready: (facts) => (parseRunning(facts) ? null : STALE_JOB) },
};

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

// `erp` is the task's loaded ERP record; only its ADR-0014 freeze flag (`attempted`) is read here. null = no ERP yet.
export function taskPolicy(facts: TaskFacts, erp: ErpRecord | null): TaskPolicy {
  const projection = project(facts);
  return { ...projection, admit: (action, token) => admit(facts, erp?.attempted ?? false, projection.step.kind, action, token) };
}

// The mutation gate, in the order its answers take precedence. A stale token beats everything; a closed task beats a
// running job; the action's own precondition comes last, so it never masks the gate's reason.
function admit(facts: TaskFacts, attempted: boolean, step: Step['kind'], action: ActionName, token: string | null): Admission {
  const { job = false, loginPause = false, erpAction = false, printOnly = false, ownsFreeze = false, ready } = ACTIONS[action];
  if (token !== null && token !== stepToken(facts.taskId, facts.revision)) return 'stale';
  // A print adjustment outlives the ERP write: only a voided task and an imported legacy one (which has no
  // materials at all) are out of reach.
  if (printOnly ? facts.lifecycle === 'voided' || facts.origin === 'legacy' : facts.lifecycle !== 'open') return TASK_CLOSED;
  if (!job) {
    if (parseRunning(facts)) return 'stale';
    const phase = facts.erp?.phase;
    if (phase === 'running' || facts.erp?.reconciling || (phase === 'waiting_login' && !loginPause)) return 'stale';
    if (!printOnly) {
      if (phase === 'handed_over' || phase === 'saved') return TASK_CLOSED;
      if (phase === 'unknown' && !erpAction) return ERP_STARTED;
      // ADR-0014: a task's materials freeze at its first ERP action attempt. The phase checks above catch the shapes
      // that freeze normally takes, but the rule is about the attempt existing at all, so it is stated once here
      // rather than left to upload, exclude, answer-pending and assign to each remember separately. ERP actions
      // and the jobs' own writes are what may still move a frozen task; print never changes facts; and an action
      // with a better reason of its own (`ownsFreeze`) gets to give it.
      if (attempted && !erpAction && !ownsFreeze) return ERP_STARTED;
    }
  }
  return ready?.(facts, step) ?? 'ok';
}

function project(facts: TaskFacts): Projection {
  const at = (stage: TaskStage, kind: Step['kind']): Projection => ({ stage, step: { kind, stepToken: stepToken(facts.taskId, facts.revision) }, blockers: [] });
  if (facts.lifecycle === 'voided') return at('voided', 'none');
  // A legacy task whose ERP draft was saved imports as ERP 单据已交接 (draft handed over): done, read-only.
  if (facts.legacyOutcome === 'draft_handed_over') return at('done', 'none');
  // 转人工 (handed off to a human) projects to reconcile, read-only (ADR-0014).
  if (facts.lifecycle === 'handed_off') return at('reconcile', 'none');
  // 去报销: a saved draft is ERP 单据已交接 (done); a write result unknown stops in reconcile; a running job or its
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
// derived ERP 单据已交接 (a saved fill job). A write result unknown is not terminal: reconcile still owns it.
export function isNonTerminal(lifecycle: TaskLifecycle, erpPhase: ErpPhase | null = null): boolean {
  return lifecycle === 'open' && erpPhase !== 'handed_over' && erpPhase !== 'saved';
}
