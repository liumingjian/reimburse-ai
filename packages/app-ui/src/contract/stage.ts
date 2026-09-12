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
] as const;
export const TaskStageSchema = z.enum(TASK_STAGES);
export type TaskStage = z.infer<typeof TaskStageSchema>;

// 任务列表徽标与侧栏状态用的阶段名。
export const TASK_STAGE_LABELS: Readonly<Record<TaskStage, string>> = {
  upload: '上传材料',
  inventory: '材料盘点',
  pending: '待确认项',
  project: '项目归属',
  catalog: '报销信息核对',
  preparation: '报销材料准备',
  review: '整单明细确认',
  actions: '去打印 / 去报销',
  erp: 'ERP 填报',
  done: '已完成',
  reconcile: '对账中',
};

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
};

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

export function pageAllowed(stage: TaskStage, page: TaskPage): boolean {
  if (page === 'done' || page === 'reconcile') return stage === page;
  return stageReached(stage, PAGE_REQUIRED_STAGE[page]);
}
