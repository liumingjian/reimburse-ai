import { z } from 'zod';
import { DateSchema, IdSchema } from './primitives';
import { CornersSchema, TaskSnapshotSchema } from './snapshot';

// 接口三：动作端点。成功返回新快照；失败返回 { error }；stepToken 过期返回 HTTP 409 与 { error, snapshot }。

export const ActionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ActionError = z.infer<typeof ActionErrorSchema>;

export const STALE_STEP_CODE = 'stale_step';
export const STALE_STEP_NOTICE = '任务已在别处推进';

export const ActionFailureSchema = z.object({
  error: ActionErrorSchema,
  snapshot: TaskSnapshotSchema.optional(),
});
export type ActionFailure = z.infer<typeof ActionFailureSchema>;

export const CreateTaskInputSchema = z.object({
  name: z.string().trim().min(1, '任务名称必填'),
  periodStart: DateSchema.nullable(),
  periodEnd: DateSchema.nullable(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const PendingAnswerSchema = z.record(z.string(), z.string());
export type PendingAnswer = z.infer<typeof PendingAnswerSchema>;

export const ProjectAssignmentInputSchema = z.object({
  purpose: z.string().trim().min(1).max(100),
  projects: z.record(IdSchema, z.string().min(1)),
});
export type ProjectAssignmentInput = z.infer<typeof ProjectAssignmentInputSchema>;

export const PlacementSlotSchema = z.enum(['top', 'bottom']);
export type PlacementSlot = z.infer<typeof PlacementSlotSchema>;

export const CropInputSchema = z.object({
  pageId: IdSchema,
  slot: PlacementSlotSchema,
  corners: CornersSchema,
});
export type CropInput = z.infer<typeof CropInputSchema>;

// 动作名与 HTTP 路径片段一一对应：POST /api/tasks/:id/actions/<name>
export const ACTION_NAMES = [
  'start-inventory',
  'answer-pending',
  'confirm-review',
  'remove-payment-screenshot',
  'generate-print-sheet',
  'rotate-placement',
  'crop-placement',
  'submit-project-assignment',
  'start-erp-write',
  'confirm-login',
  'reconcile',
  'hand-off',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
