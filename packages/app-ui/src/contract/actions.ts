import { z } from 'zod';
import { DateSchema, IdSchema } from './primitives';
import { CornersSchema, PENDING_CHOICE_KEY, TaskSnapshotSchema, type PendingItem } from './snapshot';

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

// 新建任务的校验文案，页面与服务端共用。
export const CREATE_TASK_ERRORS = {
  nameRequired: '任务名称必填。',
  dateInvalid: '日期格式应为 YYYY-MM-DD，且是真实存在的日期。',
  periodIncomplete: '开始日期与结束日期要一起填写，或都留空。',
  periodReversed: '结束日期不能早于开始日期。',
} as const;

// 真实日期：格式对，且月日在日历上存在（2026-02-30 不算）。
export function isRealDate(value: string): boolean {
  if (!DateSchema.safeParse(value).success) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const RealDateSchema = DateSchema.refine(isRealDate, CREATE_TASK_ERRORS.dateInvalid);

// 新建任务：名称必填；出差日期范围可整个留空，填了就要起止都有、都合法，且结束不早于开始。
export const CreateTaskInputSchema = z
  .object({
    name: z.string().trim().min(1, CREATE_TASK_ERRORS.nameRequired),
    periodStart: RealDateSchema.nullable(),
    periodEnd: RealDateSchema.nullable(),
  })
  .superRefine((input, ctx) => {
    const hasStart = input.periodStart !== null;
    const hasEnd = input.periodEnd !== null;
    if (hasStart !== hasEnd) {
      ctx.addIssue({ code: 'custom', message: CREATE_TASK_ERRORS.periodIncomplete, path: [hasStart ? 'periodEnd' : 'periodStart'] });
      return;
    }
    if (input.periodStart !== null && input.periodEnd !== null && input.periodEnd < input.periodStart) {
      ctx.addIssue({ code: 'custom', message: CREATE_TASK_ERRORS.periodReversed, path: ['periodEnd'] });
    }
  });
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const PendingAnswerSchema = z.record(z.string(), z.string());
export type PendingAnswer = z.infer<typeof PendingAnswerSchema>;

// 待确认项答复的格式校验文案，页面与服务端共用；页面据此在提交前拦住非法值，服务端再校验一次。
export const PENDING_ANSWER_ERRORS = {
  required: '必填，对照原件填写。',
  time: '格式应为 HH:MM，且小时 00-23、分钟 00-59。',
  date: '格式应为 YYYY-MM-DD，且是真实存在的日期。',
  choice: '请选择一种处理方式。',
  notOpen: '这个待确认项已经处理过了。',
} as const;

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

// 返回按字段 key 归档的错误；空对象表示合法。值先 trim 再判定。
export function validatePendingAnswer(item: Pick<PendingItem, 'kind' | 'fields' | 'choices'>, answer: PendingAnswer): Record<string, string> {
  const errors: Record<string, string> = {};
  if (item.kind === 'choice') {
    const chosen = (answer[PENDING_CHOICE_KEY] ?? '').trim();
    if (!item.choices.some((choice) => choice.key === chosen)) errors[PENDING_CHOICE_KEY] = PENDING_ANSWER_ERRORS.choice;
    return errors;
  }
  for (const field of item.fields) {
    const value = (answer[field.key] ?? '').trim();
    if (!value) {
      if (field.required) errors[field.key] = PENDING_ANSWER_ERRORS.required;
      continue;
    }
    if (field.format === 'time' && !TIME_PATTERN.test(value)) errors[field.key] = PENDING_ANSWER_ERRORS.time;
    if (field.format === 'date' && !isRealDate(value)) errors[field.key] = PENDING_ANSWER_ERRORS.date;
  }
  return errors;
}

// 去掉首尾空白后的答复；只保留该项定义的键。
export function normalizePendingAnswer(item: Pick<PendingItem, 'kind' | 'fields'>, answer: PendingAnswer): PendingAnswer {
  const keys = item.kind === 'choice' ? [PENDING_CHOICE_KEY] : item.fields.map((field) => field.key);
  const out: PendingAnswer = {};
  for (const key of keys) out[key] = (answer[key] ?? '').trim();
  return out;
}

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
