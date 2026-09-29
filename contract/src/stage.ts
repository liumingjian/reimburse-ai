import { z } from 'zod';

// 报销任务阶段：用户可见的业务里程碑，闭合枚举。`?seed=<stage>` 复用同一套名字。
// 主线照 Skill 的实际顺序（内核 state.mjs 规则顺序）：
// upload → inventory → pending → project（项目归属 + 事由）→ catalog（报销信息核对）→ preparation（报销材料准备）
// → review（唯一一次整单确认，绑定项目归属）→ actions（去打印 / 去报销）→ erp → done。
// catalog 与 preparation 由服务端在提交项目归属后自动执行；reconcile 是 ERP 写入结果不确定后的停顿状态（对账中），不是失败。
export const TASK_STAGES = [
  'upload',
  'inventory',
  'pending',
  'project',
  'catalog',
  'preparation',
  'review',
  'actions',
  'erp',
  'done',
  'reconcile',
  // 任务作废 (void task): terminal and read-only (ADR-0014). Voided tasks leave the task list.
  'voided',
] as const;
export const TaskStageSchema = z.enum(TASK_STAGES);
export type TaskStage = z.infer<typeof TaskStageSchema>;

// 员工可见的阶段名只用内核的 10 阶段（interaction.mjs:12-21 PROGRESS，user-interaction-contract.md「业务进度」要求沿用这组编号）。
// 1/10 环境准备与 2/10 身份与常驻城市发生在启动页与新建任务，不对应任务阶段。
export const KERNEL_PHASES = [
  '环境准备',
  '身份与常驻城市',
  '材料盘点',
  '材料整理',
  '划分费用事件',
  '项目归属',
  '报销信息核对',
  '报销材料准备',
  '填写报销单',
  '单据交接',
] as const;
export type KernelPhase = (typeof KERNEL_PHASES)[number];

// 这是按任务阶段的粗粒度对应，有意不显示 5/10 划分费用事件：内核在待确认项阶段里同时发 4/10 的材料整理项
// （补填字段、排除材料）和 5/10 的 allocation_required / events_pending；pending 一个阶段装两种，这里统一记 4/10。
// 要精确到 5/10，需要服务端在快照里直接给阶段名（待服务端 spec 确认），页面不自己看待确认项种类去猜。
// 任务阶段落在内核哪一阶段：上传与盘点是材料盘点，待确认项是材料整理，整单确认与去打印 / 去报销属于报销材料准备
// （内核 preparation_confirmation 用 PREPARATION_PROGRESS），写入与对账是填写报销单，完成是单据交接。
export const TASK_STAGE_PHASES: Readonly<Record<TaskStage, KernelPhase>> = {
  upload: '材料盘点',
  inventory: '材料盘点',
  pending: '材料整理',
  project: '项目归属',
  catalog: '报销信息核对',
  preparation: '报销材料准备',
  review: '报销材料准备',
  actions: '报销材料准备',
  erp: '填写报销单',
  done: '单据交接',
  reconcile: '填写报销单',
  // Never listed (voided tasks leave the list); the phase badge disappears with KERNEL_PHASES (#191).
  voided: '材料盘点',
};

// 任务列表徽标用的阶段名：「N/10 阶段名」。
export const TASK_STAGE_LABELS: Readonly<Record<TaskStage, string>> = Object.fromEntries(
  Object.entries(TASK_STAGE_PHASES).map(([stage, phase]) => [stage, `${KERNEL_PHASES.indexOf(phase) + 1}/10 ${phase}`]),
) as Record<TaskStage, string>;

// 对账不是内核的阶段而是填写报销单里的停顿状态；任务列表与步骤条用这个状态名代替阶段名。
export const RECONCILE_STATUS_LABEL = '对账中';

// 阶段在主线上的序号，用于「阶段不可跳过」的页面守卫；reconcile 与 erp 同级（都在 ERP 写入开始之后）。
const STAGE_RANK: Readonly<Record<TaskStage, number>> = {
  upload: 0,
  inventory: 1,
  pending: 2,
  project: 3,
  catalog: 4,
  preparation: 5,
  review: 6,
  actions: 7,
  erp: 8,
  reconcile: 8,
  done: 9,
  voided: 0,
};

export function stageRank(stage: TaskStage): number {
  return STAGE_RANK[stage];
}

export function stageReached(current: TaskStage, target: TaskStage): boolean {
  return STAGE_RANK[current] >= STAGE_RANK[target];
}

// 任务页面：`#/task/:id/<page>` 的 page 部分。
export const TASK_PAGES = ['upload', 'inventory', 'pending', 'project', 'review', 'print', 'erp', 'done', 'reconcile'] as const;
export const TaskPageSchema = z.enum(TASK_PAGES);
export type TaskPage = z.infer<typeof TaskPageSchema>;

export function isTaskPage(value: string): value is TaskPage {
  return (TASK_PAGES as readonly string[]).includes(value);
}

// 某个阶段的任务默认落到哪个页面（任务列表「继续」链接、`#/task/:id` 无页面时的跳转）。
// 报销信息核对与材料准备在整单确认页上显示进度（它们是确认前的自动步骤）。
export const STAGE_DEFAULT_PAGE: Readonly<Record<TaskStage, TaskPage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'pending',
  project: 'project',
  catalog: 'review',
  preparation: 'review',
  review: 'review',
  actions: 'review',
  erp: 'erp',
  done: 'done',
  reconcile: 'reconcile',
  voided: 'upload',
};

// The writes a reimbursement task (报销任务) accepts. The server's taskPolicy decides from the task's facts which of them
// are admitted right now; the snapshot's `allowedActions` lists exactly those (checks of the request input itself, such
// as which material or which pending item, are not part of it). Page buttons read that list and derive no rule of their
// own. `void_task` is voiding the task (任务作废, ADR-0030): allowed in every state, except while a write, a
// reconcile (对账) or an inventory run of this very task is in flight.
export const TASK_ACTIONS = [
  'upload',
  'start_inventory',
  'reopen_upload',
  'exclude_material',
  'answer_pending',
  'set_home_city',
  'assign_project_lines',
  'submit_project_assignment',
  'confirm_review',
  'start_erp_write',
  'confirm_login',
  'cancel_erp_write',
  'reconcile',
  'hand_off',
  'refill',
  'print',
  'void_task',
] as const;
export const TaskActionSchema = z.enum(TASK_ACTIONS);
export type TaskAction = z.infer<typeof TaskActionSchema>;

// 进入某页面至少要到达的阶段；done 与 reconcile 两页只对处于该阶段的任务开放。
// 项目归属在待确认项处理完后开放；整单确认页在项目归属提交后（报销信息核对起）开放；
// 打印稿在整单确认之后开放；ERP 填报在「去报销」之后开放（去报销把阶段推到 erp）。
const PAGE_REQUIRED_STAGE: Readonly<Record<TaskPage, TaskStage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'inventory',
  project: 'project',
  review: 'catalog',
  print: 'actions',
  erp: 'erp',
  done: 'done',
  reconcile: 'reconcile',
};

// The actions each page hosts. A page whose action the server admits right now is always open, so the page gate and
// the page's buttons cannot disagree. Print is not listed: its adjustments pass the gate from the first upload on,
// while the print page opens with the confirmation (stage actions) and stays open after the write, by stage alone.
const PAGE_ACTIONS: Readonly<Record<TaskPage, readonly TaskAction[]>> = {
  upload: ['upload', 'start_inventory'],
  inventory: [],
  pending: ['answer_pending'],
  project: ['assign_project_lines', 'submit_project_assignment'],
  review: ['confirm_review'],
  print: [],
  erp: ['confirm_login', 'cancel_erp_write'],
  done: [],
  // 转人工 is not listed: it is also taken from the done page (a strict read-back mismatch), so it names no one page.
  reconcile: ['reconcile', 'refill'],
};

// The page gate over the snapshot's own answers: the page hosts an admitted action, or the task's stage reached the
// page (a page stays readable once its actions are spent).
export function pageAllowed(task: { stage: TaskStage; allowedActions: readonly TaskAction[] }, page: TaskPage): boolean {
  const { stage, allowedActions } = task;
  // A voided task keeps only its upload page, read-only.
  if (stage === 'voided') return page === 'upload';
  if (PAGE_ACTIONS[page].some((action) => allowedActions.includes(action))) return true;
  if (page === 'done' || page === 'reconcile') return stage === page;
  return stageReached(stage, PAGE_REQUIRED_STAGE[page]);
}
