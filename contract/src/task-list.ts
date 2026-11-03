import { z } from 'zod';
import { AmountSchema, DateSchema, DateTimeSchema, IdSchema } from './primitives';
import { TaskStageSchema } from './stage';

export const TaskPeriodSchema = z.object({
  start: DateSchema,
  end: DateSchema,
});
export type TaskPeriod = z.infer<typeof TaskPeriodSchema>;

// 任务列表层面的 ERP 结局，由服务端给出：none 无需人工；readback_mismatch 严格回读与本地确认不一致（停在完成页，不算完成）；
// handed_off 已转人工（终态）。非 none 时列表徽标显示对应文案（warning / danger 语义），代替阶段名。
export const TASK_ERP_OUTCOMES = ['none', 'readback_mismatch', 'handed_off'] as const;
export const TaskErpOutcomeSchema = z.enum(TASK_ERP_OUTCOMES);
export type TaskErpOutcome = z.infer<typeof TaskErpOutcomeSchema>;

export const TASK_ERP_OUTCOME_LABELS: Readonly<Record<Exclude<TaskErpOutcome, 'none'>, string>> = {
  readback_mismatch: '回读不一致',
  handed_off: '已转人工',
};

// 任务列表的一行。价税合计只在整单明细确认后才有值；单据编号只在员工自己保存过之后才读得到。
export const TaskListItemSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
  stage: TaskStageSchema,
  period: TaskPeriodSchema.nullable(),
  grossTotal: AmountSchema.nullable(),
  // Derived from the current detail and confirmation facts; older clients may omit it.
  summaryStatus: z.enum(['unavailable', 'pending', 'confirmed']).optional(),
  erpDraftNo: z.string().min(1).nullable(),
  pendingCount: z.number().int().nonnegative(),
  erpOutcome: TaskErpOutcomeSchema,
  // The task policy admits printing, including after ERP completion; legacy imports have no materials to print.
  printable: z.boolean(),
  // 能否作废由服务端判定。任何状态的任务都可以作废（ADR-0030），只有写入/对账正在跑的那一下不行，
  // abandonBlockedReason 给出原因（页面照抄在不可用的按钮旁）。
  // erpTouched：这个任务动过报销系统，确认框要用 dialogBodyErpTouched 说清作废撤不掉那边的单据。
  abandonable: z.boolean(),
  abandonBlockedReason: z.string().min(1).nullable(),
  erpTouched: z.boolean(),
  updatedAt: DateTimeSchema,
});
export type TaskListItem = z.infer<typeof TaskListItemSchema>;

// 新建任务时常驻城市的服务端默认值（前端从不自己定位）。remembered：员工此前确认过的常驻城市；
// network：内核位置 Adapter 给出的城市级网络位置候选（员工还没有确认过）。整体为 null：没有记忆且位置获取失败，由员工直接填写。
export const HOME_CITY_SOURCES = ['remembered', 'network'] as const;
export const HomeCityDefaultSchema = z.object({
  value: z.string().min(1),
  source: z.enum(HOME_CITY_SOURCES),
});
export type HomeCityDefault = z.infer<typeof HomeCityDefaultSchema>;

// 接口一：任务列表（当前登录的应用账号自己的任务）。服务端已按更新时间倒序排好；页面不再排序。
// homeCity 是这个账号记住的常驻城市或网络位置候选。
export const TaskListSchema = z.object({
  homeCity: HomeCityDefaultSchema.nullable(),
  tasks: z.array(TaskListItemSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;
