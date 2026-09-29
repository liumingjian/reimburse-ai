import { TASK_ACTIONS, type StepKind, type TaskAction, type TaskSnapshot } from '@baox/contract';

// 服务端投影：快照的 allowedActions（服务端由 taskPolicy 判定，server/src/task-policy.ts）。mock 没有任务事实，
// 只能按它自己的流程写下的 step、ERP 状态与对账处置推出来。与服务端逐项对照的是 ../parity.test.ts（#316）。
// mock 每次存快照前都调用一次（bus.put），夹具出口也调用一次，保证按钮与快照里的其余字段同步。

// 写入报销系统之前、盘点结束之后都接受的改动。
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
  erp_login: ['confirm_login', 'cancel_erp_write'],
  // 对账与完成页上的处置照对账判定给出（wait 即重新对账）。
  reconcile: [],
  hand_off: [],
};

const RECONCILE_WRITES = { wait: 'reconcile', hand_off: 'hand_off', refill: 'refill' } as const;

export function allowedActionsOf(snapshot: TaskSnapshot): TaskAction[] {
  const { stage, step, erp, reconcile } = snapshot;
  if (stage === 'voided') return [];
  // 这个任务自己的写入或盘点正在跑：只有登录暂停时的两个动作（它们在 erp_login 里）。
  const running = erp.status === 'running' || erp.status === 'waiting_login' || snapshot.inventory.status === 'running';
  const allowed = new Set<TaskAction>(STEP_ACTIONS[step.kind]);
  if (step.kind === 'reconcile' || step.kind === 'hand_off') for (const code of reconcile.allowedActions) allowed.add(RECONCILE_WRITES[code]);
  // 跨任务重复发票停住整批：没有 step，出路是排除那份材料。
  if (stage === 'inventory' && step.kind === 'none' && snapshot.blockers.length > 0) for (const action of CHANGES) allowed.add(action);
  if (!running) {
    allowed.add('print');
    allowed.add('void_task');
  }
  return TASK_ACTIONS.filter((action) => allowed.has(action));
}

export function withAllowedActions(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot, allowedActions: allowedActionsOf(snapshot) };
}
