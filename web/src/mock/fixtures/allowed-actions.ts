import { TASK_ACTIONS, type StepKind, type TaskAction, type TaskSnapshot } from '@baox/contract';

// Server projection: the snapshot's allowedActions (on the server, taskPolicy decides them: server/src/task-policy.ts).
// The mock has no task facts, so it derives them from what its own flows wrote: the step, the ERP status and the
// reconcile disposition. ../parity.test.ts (#316) compares the result with the server's goldens in every scenario it
// drives; states no golden covers (duplicate blockers, given-up items, T2/T3) rest on this table alone.
// The mock calls it before storing any snapshot (bus.put) and at the fixture exits, so the buttons stay in step with
// the rest of the snapshot.

// Changes accepted after the inventory and before anything is written to the ERP.
const CHANGES: readonly TaskAction[] = ['upload', 'reopen_upload', 'exclude_material', 'answer_pending', 'set_home_city'];
const ASSIGNING: readonly TaskAction[] = [...CHANGES, 'assign_project_lines', 'submit_project_assignment'];

const STEP_ACTIONS: Readonly<Record<StepKind, readonly TaskAction[]>> = {
  none: [],
  upload_materials: ['upload', 'exclude_material', 'set_home_city'],
  start_inventory: ['upload', 'start_inventory', 'exclude_material', 'set_home_city'],
  answer_pending: CHANGES,
  maintain_project_book: CHANGES,
  assign_projects: ASSIGNING,
  resolve_preparation: ASSIGNING,
  confirm_review: [...ASSIGNING, 'confirm_review'],
  choose_action: [...ASSIGNING, 'start_erp_write'],
  // On the reconcile and done pages the dispositions follow the reconcile verdict (wait = reconcile again).
  reconcile: [],
  hand_off: [],
};

const RECONCILE_WRITES = { wait: 'reconcile', hand_off: 'hand_off', refill: 'refill' } as const;

export function allowedActionsOf(snapshot: TaskSnapshot): TaskAction[] {
  const { stage, step, erp, reconcile } = snapshot;
  if (stage === 'voided') return [];
  // This task's own write or inventory is running: nothing but its own job moves it.
  const running = erp.status === 'running' || snapshot.inventory.status === 'running';
  const allowed = new Set<TaskAction>(STEP_ACTIONS[step.kind]);
  if (step.kind === 'reconcile' || step.kind === 'hand_off') for (const code of reconcile.allowedActions) allowed.add(RECONCILE_WRITES[code]);
  // A cross-task duplicate invoice stops the whole batch: no step, the way out is excluding that material.
  if (stage === 'inventory' && step.kind === 'none' && snapshot.blockers.length > 0) for (const action of CHANGES) allowed.add(action);
  if (!running && erp.status === 'idle' && snapshot.inventory.status === 'done' && snapshot.blockers.length === 0 && snapshot.confirmation.status !== 'confirmed') allowed.add('change_dining_evidence');
  if (!running) {
    allowed.add('print');
    if (snapshot.confirmation.status === 'confirmed') allowed.add('summary');
    allowed.add('void_task');
  }
  return TASK_ACTIONS.filter((action) => allowed.has(action));
}

export function withAllowedActions(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot, reimbursementSummary: snapshot.confirmation.status === 'confirmed' && snapshot.stage !== 'voided' ? { status: 'ready' } : { status: 'unavailable', cause: 'not-confirmed', reasons: ['请先完成整单明细确认。'] }, allowedActions: allowedActionsOf(snapshot) };
}
