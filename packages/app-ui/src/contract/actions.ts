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

// 确认整单明细：动作回传快照里的 confirmation.digest 与 stepToken，服务端据此判断用户点头的是不是这一份。
export const CONFIRM_REVIEW_ERRORS = {
  digestMismatch: '候选明细已更新，请重新核对后再确认。',
  noLines: '还没有候选明细，不能确认。',
} as const;

// 追加材料（确认后）：任务回到上传阶段接收新批次；已有的整单明细确认失效，已生成的打印稿作废。
export const REOPEN_UPLOAD_ERRORS = {
  erpStarted: '已开始 ERP 填报，不能再追加材料。',
} as const;

// 项目归属：文案照内核 selection.mjs / project-workbench.mjs。页面只拦「未填完」，项目是否可用由服务端判定。
export const PURPOSE_MAX_LENGTH = 100;

export const PROJECT_ASSIGNMENT_ERRORS = {
  incomplete: '报销事由和每一条明细的项目都要填写',
  purpose: '报销事由必须填写，且不超过 100 个字',
  lineUnassigned: (no: number) => `明细 No.${no} 还没有选项目`,
  projectNotAllowed: (no: number, number: string) => `明细 No.${no} 的项目 ${number} 不在当前本人项目簿可选集合中；要用它请先在维护页重新核验`,
  unknownLine: (lineId: string) => `提交里出现了不存在的明细 ${lineId}，这批明细可能已经变了`,
  notReady: '还不能提交项目归属，请先完成整单明细确认。',
  bookEmpty: '当前个人项目簿没有可选项目；先维护本人项目簿，再回来做任务选择',
} as const;

// 批量归入碰到已有其他项目归属的明细时的三个选项（内核 Variant B）。
export const PROJECT_CONFLICT_COPY = {
  title: (count: number) => `${count} 条明细已有其他项目归属，请确认是否覆盖`,
  onlyEmpty: '只处理未归属',
  overwrite: '确认覆盖',
  cancel: '取消',
} as const;

export const ProjectAssignmentInputSchema = z.object({
  purpose: z.string().trim().min(1, PROJECT_ASSIGNMENT_ERRORS.purpose).max(PURPOSE_MAX_LENGTH, PROJECT_ASSIGNMENT_ERRORS.purpose),
  // lineId → 项目号
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
  'reopen-upload',
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
