import { z } from 'zod';

// 报销任务阶段：用户可见的业务里程碑，闭合枚举。`?seed=<stage>` 复用同一套名字。
// 主线：upload → inventory → pending → review → actions →（去报销）project → erp → done；
// reconcile 是 ERP 写入结果不确定后的停顿状态（对账中），不是失败。
export const TASK_STAGES = [
  'upload',
  'inventory',
  'pending',
  'review',
  'actions',
  'project',
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
  review: '整单明细确认',
  actions: '去打印 / 去报销',
  project: '项目归属',
  erp: 'ERP 填报',
  done: '已完成',
  reconcile: '对账中',
};

// 阶段在主线上的序号，用于「阶段不可跳过」的页面守卫；reconcile 与 erp 同级（都在 ERP 写入开始之后）。
const STAGE_RANK: Readonly<Record<TaskStage, number>> = {
  upload: 0,
  inventory: 1,
  pending: 2,
  review: 3,
  actions: 4,
  project: 5,
  erp: 6,
  reconcile: 6,
  done: 7,
};

export function stageRank(stage: TaskStage): number {
  return STAGE_RANK[stage];
}

export function stageReached(current: TaskStage, target: TaskStage): boolean {
  return STAGE_RANK[current] >= STAGE_RANK[target];
}

// 任务页面：`#/task/:id/<page>` 的 page 部分。
export const TASK_PAGES = ['upload', 'inventory', 'pending', 'review', 'print', 'project', 'erp', 'done', 'reconcile'] as const;
export const TaskPageSchema = z.enum(TASK_PAGES);
export type TaskPage = z.infer<typeof TaskPageSchema>;

export function isTaskPage(value: string): value is TaskPage {
  return (TASK_PAGES as readonly string[]).includes(value);
}

// 某个阶段的任务默认落到哪个页面（任务列表「继续」链接、`#/task/:id` 无页面时的跳转）。
export const STAGE_DEFAULT_PAGE: Readonly<Record<TaskStage, TaskPage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'pending',
  review: 'review',
  actions: 'review',
  project: 'project',
  erp: 'erp',
  done: 'done',
  reconcile: 'reconcile',
};

// 进入某页面至少要到达的阶段；done 与 reconcile 两页只对处于该阶段的任务开放。
const PAGE_REQUIRED_STAGE: Readonly<Record<TaskPage, TaskStage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'inventory',
  review: 'review',
  print: 'actions',
  project: 'actions',
  erp: 'project',
  done: 'done',
  reconcile: 'reconcile',
};

export function pageAllowed(stage: TaskStage, page: TaskPage): boolean {
  if (page === 'done' || page === 'reconcile') return stage === page;
  return stageReached(stage, PAGE_REQUIRED_STAGE[page]);
}
