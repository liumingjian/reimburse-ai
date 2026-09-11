import { z } from 'zod';
import { AmountSchema, DateSchema, DateTimeSchema, IdSchema } from './primitives';
import { TaskStageSchema } from './stage';

export const EmployeeSchema = z.object({
  name: z.string().min(1),
  department: z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

export const TaskPeriodSchema = z.object({
  start: DateSchema,
  end: DateSchema,
});
export type TaskPeriod = z.infer<typeof TaskPeriodSchema>;

// 任务列表的一行。价税合计只在整单明细确认后才有值；ERP 草稿号只在保存草稿后才有值。
export const TaskListItemSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
  stage: TaskStageSchema,
  period: TaskPeriodSchema.nullable(),
  grossTotal: AmountSchema.nullable(),
  erpDraftNo: z.string().min(1).nullable(),
  pendingCount: z.number().int().nonnegative(),
  updatedAt: DateTimeSchema,
});
export type TaskListItem = z.infer<typeof TaskListItemSchema>;

// 接口一：任务列表。服务端已按更新时间倒序排好；页面不再排序。
export const TaskListSchema = z.object({
  employee: EmployeeSchema.nullable(),
  tasks: z.array(TaskListItemSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;
