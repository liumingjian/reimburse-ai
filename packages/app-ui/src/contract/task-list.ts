import { z } from 'zod';
import { AmountSchema, DateSchema, DateTimeSchema, IdSchema } from './primitives';
import { TaskStageSchema } from './stage';

// 报销人身份：三个值都是服务端从报销系统当前登录会话读到的原值（内核 `identityTable`，next.mjs:402-412）。
// 绑定判据是登录账号 + 账套，不含显示名。binding：unbound 还没登记（启动页展示身份确认表，只能确认）；
// bound 已登记且与当前登录一致；mismatched 当前登录与已登记的报销人不一致（整页阻塞）。没有部门：内核身份里没有这一项。
export const EMPLOYEE_BINDINGS = ['unbound', 'bound', 'mismatched'] as const;
export const EmployeeBindingSchema = z.enum(EMPLOYEE_BINDINGS);
export type EmployeeBinding = z.infer<typeof EmployeeBindingSchema>;

export const EmployeeSchema = z.object({
  displayName: z.string().min(1),
  account: z.string().min(1),
  tenant: z.string().min(1),
  binding: EmployeeBindingSchema,
});
export type Employee = z.infer<typeof EmployeeSchema>;

// 报销系统登录会话，由服务端探测（内核 env_not_logged_in）。not_logged_in 时 employee 为 null（读不出当前身份）。
export const ERP_SESSION_STATES = ['logged_in', 'not_logged_in'] as const;
export const ErpSessionSchema = z.enum(ERP_SESSION_STATES);
export type ErpSession = z.infer<typeof ErpSessionSchema>;

export const TaskPeriodSchema = z.object({
  start: DateSchema,
  end: DateSchema,
});
export type TaskPeriod = z.infer<typeof TaskPeriodSchema>;

// 任务列表层面的 ERP 结局，由服务端给出：none 无需人工；readback_mismatch 草稿已保存但严格回读不一致（停在完成页，不算完成）；
// handed_off 已转人工（终态）。非 none 时列表徽标显示对应文案（warning / danger 语义），代替阶段名。
export const TASK_ERP_OUTCOMES = ['none', 'readback_mismatch', 'handed_off'] as const;
export const TaskErpOutcomeSchema = z.enum(TASK_ERP_OUTCOMES);
export type TaskErpOutcome = z.infer<typeof TaskErpOutcomeSchema>;

export const TASK_ERP_OUTCOME_LABELS: Readonly<Record<Exclude<TaskErpOutcome, 'none'>, string>> = {
  readback_mismatch: '回读不一致',
  handed_off: '已转人工',
};

// 任务列表的一行。价税合计只在整单明细确认后才有值；ERP 草稿号只在保存草稿后才有值。
export const TaskListItemSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
  stage: TaskStageSchema,
  period: TaskPeriodSchema.nullable(),
  grossTotal: AmountSchema.nullable(),
  erpDraftNo: z.string().min(1).nullable(),
  pendingCount: z.number().int().nonnegative(),
  erpOutcome: TaskErpOutcomeSchema,
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

// 接口一：任务列表。服务端已按更新时间倒序排好；页面不再排序。
// 启动状态也在这里：erpSession 与 employee.binding 决定页面先显示启动页（登录 / 确认身份 / 身份不一致），
// 还是任务列表与任务页。homeCity 是按身份（tenant + account）记住的常驻城市或网络位置候选。
export const TaskListSchema = z.object({
  erpSession: ErpSessionSchema,
  employee: EmployeeSchema.nullable(),
  homeCity: HomeCityDefaultSchema.nullable(),
  tasks: z.array(TaskListItemSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;

// 启动是否完成：已登录且身份已登记、与当前登录一致。服务端给的两个状态原样判读，页面不做别的推断。
export function startupComplete(list: Pick<TaskList, 'erpSession' | 'employee'>): boolean {
  return list.erpSession === 'logged_in' && list.employee?.binding === 'bound';
}
