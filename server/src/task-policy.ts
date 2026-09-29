import {
  CONFIRM_REVIEW_ERRORS,
  ERP_ACTION_ERRORS,
  ERP_IN_USE_CODE,
  HOME_CITY_ERRORS,
  PROJECT_ASSIGNMENT_ERRORS,
  REOPEN_UPLOAD_ERRORS,
  TASK_ACTIONS,
  type Blocker,
  type Erp,
  type Reconcile,
  type Step,
  type TaskAction,
  type TaskStage,
} from '@baox/contract';
import type { TaskLifecycle, TaskOrigin } from './db/schema';
import type { ErpRecord, ReconcileJudgement } from './erp/fill-state';

// The task policy: the one owner of task-state rules. Pure: loaded task facts (任务事实, `task-facts.ts`) and the ERP
// record in; `{stage, step, blockers}`, the write admission of every action, and the set of actions admitted right now
// out. That covers the ERP phase and reconcile (对账) verdict rules, the refill (重新去报销) path and voiding the task
// (任务作废). No stage is ever stored (ADR-0014), so a "wrong stage", "stuck", "why was this refused" or "this button
// should not be here" bug is a row in `task-policy.test.ts`, not a database fixture.

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
  // Who holds the account's in-memory ERP lease (`erp-lease.ts`, ADR-0019) as the task service read it: a job of this
  // task, or of another task of the same account. `loadFacts` cannot see the lease; the task service sets this for
  // the writes it guards and the task list and snapshot leave it unset, so their allowed actions do not flicker with
  // it. Two rules read it: 任务作废 treats `own` as a job in flight (the window between a job taking the lease and its
  // row becoming visible), and the actions that take the lease are refused `erp_in_use` on `other`.
  erpLease?: 'own' | 'other' | null;
  // Whether this server has an ERP to write to (an ERP config). Like `erpLease`, the task service sets it for the writes
  // it guards and the snapshot leaves it unset (read as configured): the actions that take the lease refuse
  // `not_ready` without one, before anything else about the ERP.
  erpConfigured?: boolean;
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

// What the policy reads from the task's ERP record beyond the phase: the ADR-0014 freeze flag (`attempted`), the 对账
// (reconcile) verdict and the fill's result, which carry the bill number (单据编号) read so far. The phase and the
// running 对账 job are `TaskFacts.erp`, never the record's copy of them.
export type ErpVerdict = Pick<ErpRecord, 'attempted' | 'reconcile' | 'result'>;

// Every write the task service accepts, by name: the contract's task actions (the ones a page can ask for, listed in
// the snapshot's `allowedActions`), plus the jobs' own writes. `job` is the ERP job's write and the book-change
// revision bump; `record_parse` is the parser job's.
export type ActionName = TaskAction | 'job' | 'record_parse';

// 'stale' is the HTTP 409 of ADR-0014 (a stale stepToken, or any foreign write while a job runs); a Refusal is a 400.
export type Admission = 'ok' | 'stale' | Refusal;

export type Projection = { stage: TaskStage; step: Step; blockers: Blocker[] };

export type TaskPolicy = Projection & {
  // The task actions `admit` answers 'ok' right now on the current stepToken. Input checks that need the request
  // (which material, which pending item, which project) are the action's own and are not part of this.
  allowedActions: ReadonlySet<TaskAction>;
  // `stepToken` null: the action carries none (upload, the jobs' writes, print, which commits on the revision it read,
  // and 任务作废, which is a list action). `request`: the action's refusal of its request input, where that input is
  // checked ahead of the action's own precondition (see `ready` below); null when the input is fine.
  admit(action: ActionName, stepToken: string | null, request?: Refusal | null): Admission;
};

// What sets an action apart at the gate.
// `job`: the parser or ERP job's own write, allowed while a job runs. `loginPause`: accepted during an ERP login
// pause. `erpAction`: accepted after an ERP action attempt (reconcile, hand-off, the refill of ADR-0027).
// `printOnly`: a 去打印 adjustment. Print never touches ERP (stories 57 and 63), so it stays open after 转人工 and
// after the draft was handed over; it still stops at 任务作废, at an imported legacy task, and while a job runs.
// `voids`: 任务作废 (ADR-0030). Every lifecycle and every ERP phase can be voided; the one refusal left is a job of
// this very task in flight, which clears itself.
// `ownsFreeze`: this action refuses a frozen task itself, with a reason of its own (修改常驻城市 says the home city is
// locked, 追加材料 says why it cannot reopen). The central freeze would otherwise answer first and replace those with
// the generic one.
// `takesLease`: the action starts a job that needs the account's ERP lease (a fill or a 对账 job); while another task's
// job holds it the answer is `erp_in_use` (HTTP 409, naming no task). It says where the `erp_in_use` refusal ranks against `ready`, as the task service always ranked it: a fill
// start (`before_ready`) is refused for the lease before its own step, a 对账 (`after_ready`) only once its verdict
// allows it. Either way an ERP that is not configured at all (`TaskFacts.erpConfigured`) answers `not_ready` first.
// `ready`: the action's own precondition on the task's facts and ERP record, checked once the gate let it through.
// Where an action's request input is refused ahead of that precondition (修改常驻城市 names an invalid city before a
// locked one), the task service passes that refusal to `admit`, which ranks it right before `ready`.
type Traits = {
  job?: boolean;
  loginPause?: boolean;
  erpAction?: boolean;
  printOnly?: boolean;
  voids?: boolean;
  ownsFreeze?: boolean;
  takesLease?: 'before_ready' | 'after_ready';
  ready?: (facts: TaskFacts, step: Step['kind'], erp: ErpVerdict | null) => Refusal | null;
};

const TASK_CLOSED: Refusal = { code: 'task_closed', message: ACTION_COPY.taskClosed };
const ERP_STARTED: Refusal = { code: 'erp_started', message: ERP_ACTION_ERRORS.erpStarted };
const ERP_NOT_READY: Refusal = { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady };
const NOT_WAITING_LOGIN: Refusal = { code: 'not_waiting_login', message: ERP_ACTION_ERRORS.notWaitingLogin };
const NOT_RECONCILING: Refusal = { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling };
const NOT_ALLOWED: Refusal = { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed };
export const ERP_IN_USE: Refusal = { code: ERP_IN_USE_CODE, message: ERP_ACTION_ERRORS.inUse };
// A refusal the parser job expects when the run moved on under it; never shown to anyone.
export const STALE_JOB: Refusal = { code: 'stale_job', message: 'the inventory run changed under the parser job' };

const atStep =
  (steps: readonly Step['kind'][], refusal: Refusal) =>
  (_facts: TaskFacts, step: Step['kind']): Refusal | null =>
    steps.includes(step) ? null : refusal;

// Steps under which the assignment draft and the submission may change: before confirmation and after it (a change
// invalidates the confirmation). The freeze stops every change once a fill job made an ERP action attempt.
const assigning = atStep(['assign_projects', 'confirm_review', 'choose_action'], { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady });

const waitingLogin = (facts: TaskFacts): Refusal | null => (facts.erp?.phase === 'waiting_login' ? null : NOT_WAITING_LOGIN);

// A 对账 disposition: the fill's write result is unknown, and the current verdict offers `offer`.
const offered =
  (offer: Reconcile['allowedActions'][number]) =>
  (facts: TaskFacts, _step: Step['kind'], erp: ErpVerdict | null): Refusal | null => {
    if (facts.erp?.phase !== 'unknown') return NOT_RECONCILING;
    return erp && reconcileActionsOf(facts.erp, erp).includes(offer) ? null : NOT_ALLOWED;
  };

const ACTIONS: Record<ActionName, Traits> = {
  upload: {},
  start_inventory: { ready: atStep(['start_inventory'], { code: 'not_ready', message: ACTION_COPY.notReadyToStart }) },
  reopen_upload: {
    ownsFreeze: true,
    ready: (facts, _step, erp) => {
      if (!inventoried(facts)) return { code: 'not_ready', message: ACTION_COPY.notReopenable };
      return erp?.attempted ? { code: 'erp_started', message: REOPEN_UPLOAD_ERRORS.erpStarted } : null;
    },
  },
  confirm_review: { ready: atStep(['confirm_review'], { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady }) },
  exclude_material: {},
  // A batch stopped by 发票占用 has no pending items to answer; excluding the held material is the way out.
  answer_pending: { ready: (facts) => (facts.parse && facts.parse.blockers.length === 0 ? null : { code: 'not_ready', message: ACTION_COPY.notAnswering }) },
  set_home_city: { ownsFreeze: true, ready: (_facts, _step, erp) => (erp?.attempted ? { code: 'home_city_locked', message: HOME_CITY_ERRORS.locked } : null) },
  assign_project_lines: { ready: assigning },
  submit_project_assignment: { ready: assigning },
  // 去报销 is taken from choose_action on a confirmed task; a task with an attempt already stopped at the freeze.
  start_erp_write: { takesLease: 'before_ready', ready: (facts, step) => (step === 'choose_action' && facts.confirmation === 'confirmed' ? null : ERP_NOT_READY) },
  confirm_login: { loginPause: true, takesLease: 'before_ready', ready: waitingLogin },
  cancel_erp_write: { loginPause: true, ready: waitingLogin },
  // 重新去报销 (ADR-0027) is an ERP action like 对账, so it passes the phase-unknown and freeze refusals 去报销 gets;
  // it earns that by the 对账 verdict offering it, which stands in for choose_action as the step it is taken from.
  // Nothing is re-confirmed: it rebuilds its plan from the same confirmation, and refuses as 去报销 does without one.
  refill: {
    erpAction: true,
    takesLease: 'before_ready',
    ready: (facts, step, erp) => offered('refill')(facts, step, erp) ?? (facts.confirmation === 'confirmed' ? null : ERP_NOT_READY),
  },
  reconcile: { erpAction: true, takesLease: 'after_ready', ready: offered('wait') },
  hand_off: { erpAction: true, ready: offered('hand_off') },
  print: { printOnly: true },
  void_task: { voids: true },
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

// A job of this task is in flight: the parser job, a fill job (or its login pause, unless the action is one the
// pause waits for), or a 对账 job. It ends by itself; until then only the job's own writes pass.
function jobInFlight(facts: TaskFacts, loginPause: boolean): boolean {
  const phase = facts.erp?.phase;
  return parseRunning(facts) || phase === 'running' || !!facts.erp?.reconciling || (phase === 'waiting_login' && !loginPause);
}

// The ERP page's own commands for the phase of the latest fill job. `refresh` only reads; confirm_login and cancel
// are the two writes the login pause waits for (their admission is `confirm_login` / `cancel_erp_write`).
export function erpActionsOf(phase: ErpPhase | null | undefined): Erp['allowedActions'] {
  switch (phase) {
    case 'waiting_login':
      return ['refresh', 'confirm_login', 'cancel'];
    case 'running':
    case 'aborted':
    case 'unknown':
    case 'handed_over':
    case 'saved':
      return ['refresh'];
    default:
      return [];
  }
}

// The dispositions the current 对账 verdict offers on a fill whose write result is unknown (#192, ADR-0027):
// wait = 再对一次账 (read-only), hand_off = 转人工, refill = 重新去报销. Empty in any other phase and while a 对账 job
// runs. Before any read and after a 原地等待 verdict both wait and hand_off; a 转人工 verdict only hand_off.
//
// 重新去报销 is the exit out of an import that was never saved: 未保存·已导入未写明细 with no bill number (单据编号) ever
// read for this task. It is not gated on the attempt log: baox never saves (ADR-0028), so "this job started no save
// attempt" is vacuously true and carries no information. A 单据编号 means the employee saved and re-importing would
// act on a bill that exists, so that reading keeps 转人工. An unreadable 单据编号 cell also reads as null here, and that
// is the conservative side of the reading only because the bucket itself already required 新增 mode with no bill.
// A 对账 that found no 费用报销单 open is the same exit, for the same reason. Closing the tab or cleaning the ERP
// browser is a normal act, and an unsaved 费用报销单 does not outlive its tab: with no form on the page there is no
// bill to hand anyone, nothing to clean up, and nothing left that the recovery's fresh 新增单 could collide with —
// the 收票 records the import left behind are overwritten by the re-import (ADR-0026). The one fact that cannot be
// read this way is whether the employee saved before closing, and ADR-0028 already leaves that to them: the gate
// stays 「while the ERP shows no 单据编号」, here strengthened to 「no 单据编号 has ever been read for this task」,
// and the banner asks them not to press it if they saved. Without this, cleaning the browser would destroy the
// evidence the only non-terminal exit depends on and leave 转人工 as the only way out. With no form open,
// 再对一次账 stays on offer: the employee may open the bill again and read it properly.
export function reconcileActionsOf(phase: ErpFacts | null | undefined, erp: ErpVerdict): Reconcile['allowedActions'] {
  if (phase?.phase !== 'unknown' || phase.reconciling) return [];
  const { judged, draftNo, noForm } = reconcileReading(erp);
  if (!judged) return ['wait', 'hand_off'];
  if ((judged.verdict.bucket === '未保存·已导入未写明细' || noForm) && draftNo === null) return noForm ? ['refill', 'wait', 'hand_off'] : ['refill', 'hand_off'];
  return judged.verdict.action === '转人工' ? ['hand_off'] : ['wait', 'hand_off'];
}

// The latest 对账 judgement, the 单据编号 read for this task so far (by the 对账, else by the fill), and whether the
// 对账 found no 费用报销单 open at all (only a 未知 reading can say that). The rules above and the reconcile section's
// wording (`task-snapshot/erp.ts`) both read these three from here.
export function reconcileReading(erp: ErpVerdict): { judged: ReconcileJudgement | null; draftNo: string | null; noForm: boolean } {
  const judged = erp.reconcile?.judged ?? null;
  return { judged, draftNo: judged?.billNo ?? erp.result?.billNo ?? null, noForm: !!judged && judged.noForm && judged.verdict.bucket === '未知' };
}

// `erp` is what the policy reads from the task's loaded ERP record (`ErpVerdict`); null = no ERP yet.
export function taskPolicy(facts: TaskFacts, erp: ErpVerdict | null): TaskPolicy {
  const projection = project(facts);
  const step = projection.step.kind;
  return {
    ...projection,
    allowedActions: new Set(TASK_ACTIONS.filter((action) => admit(facts, erp, step, action, null, null) === 'ok')),
    admit: (action, token, request = null) => admit(facts, erp, step, action, token, request),
  };
}

// The mutation gate, in the order its answers take precedence. A stale token beats everything; a closed task beats a
// running job; the action's own precondition comes last, so it never masks the gate's reason. `task-policy.test.ts`
// pins each precedence the HTTP API has always answered with.
function admit(facts: TaskFacts, erp: ErpVerdict | null, step: Step['kind'], action: ActionName, token: string | null, request: Refusal | null): Admission {
  const { job = false, loginPause = false, erpAction = false, printOnly = false, voids = false, ownsFreeze = false, takesLease = null, ready } = ACTIONS[action];
  if (token !== null && token !== stepToken(facts.taskId, facts.revision)) return 'stale';
  // A print adjustment outlives the ERP write: only a voided task and an imported legacy one (which has no
  // materials at all) are out of reach. Voiding reaches every task that is not voided already.
  const closed = printOnly ? facts.lifecycle === 'voided' || facts.origin === 'legacy' : voids ? facts.lifecycle === 'voided' : facts.lifecycle !== 'open';
  if (closed) return TASK_CLOSED;
  if (!job) {
    if (jobInFlight(facts, loginPause)) return 'stale';
    if (!printOnly && !voids) {
      const phase = facts.erp?.phase;
      if (phase === 'handed_over' || phase === 'saved') return TASK_CLOSED;
      if (phase === 'unknown' && !erpAction) return ERP_STARTED;
      // ADR-0014: a task's materials freeze at its first ERP action attempt. The phase checks above catch the shapes
      // that freeze normally takes, but the rule is about the attempt existing at all, so it is stated once here
      // rather than left to upload, exclude, answer-pending and assign to each remember separately. ERP actions
      // and the jobs' own writes are what may still move a frozen task; print never changes facts; and an action
      // with a better reason of its own (`ownsFreeze`) gets to give it.
      if (erp?.attempted && !erpAction && !ownsFreeze) return ERP_STARTED;
    }
    if (takesLease && facts.erpConfigured === false) return ERP_NOT_READY;
    // The account's one ERP (ADR-0019): another task's job has it now. Come back later.
    if (takesLease === 'before_ready' && facts.erpLease === 'other') return ERP_IN_USE;
    // Voiding under a job of this very task that took the lease: the job is in flight even if its row is not visible.
    if (voids && facts.erpLease === 'own') return 'stale';
  }
  const refusal = request ?? ready?.(facts, step, erp) ?? null;
  if (refusal) return refusal;
  if (!job && takesLease === 'after_ready' && facts.erpLease === 'other') return ERP_IN_USE;
  return 'ok';
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
