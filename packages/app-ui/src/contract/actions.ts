import { z } from 'zod';
import { DateSchema, IdSchema } from './primitives';
import { CornersSchema, PENDING_CHOICE_KEY, TaskSnapshotSchema, type PendingItem } from './snapshot';
import { TaskListSchema } from './task-list';

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
  homeCityRequired: '请填写常驻城市。',
  startupIncomplete: '还没有登录报销系统并确认报销人身份，不能新建报销任务。',
} as const;

// 启动动作（任务之外）：「我已登录」请服务端再探测一次登录会话；「确认」登记当前登录身份。
// 两者成功都返回整份新任务列表；失败返回 { error, taskList? }（带最新任务列表时页面据此重渲染）。
// 确认身份时回传页面上看到的账号与账套：服务端重新读一次当前登录，对不上就拒绝（你认的只是你看过的那一个）。
export const ConfirmIdentityInputSchema = z.object({
  account: z.string().min(1),
  tenant: z.string().min(1),
});
export type ConfirmIdentityInput = z.infer<typeof ConfirmIdentityInputSchema>;

export const StartupFailureSchema = z.object({
  error: ActionErrorSchema,
  taskList: TaskListSchema.optional(),
});
export type StartupFailure = z.infer<typeof StartupFailureSchema>;

export const STARTUP_ERRORS = {
  notLoggedIn: '报销系统仍未登录。请在报销系统用本人账号登录后，再点「我已登录」。',
  identityChanged: '当前登录身份与你刚才核对的不一致，请重新核对身份表。',
  identityMismatched: '当前登录身份与已登记的报销人不一致，不能登记。',
} as const;

// 真实日期：格式对，且月日在日历上存在（2026-02-30 不算）。
export function isRealDate(value: string): boolean {
  if (!DateSchema.safeParse(value).success) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// 新建任务：只提交这次任务的常驻城市（去掉首尾空白后非空）。任务名称与费用期间由服务端生成：
// 创建时是占位名称，盘点结束后按材料日期与城市改名并给出费用期间。常驻城市成为任务自己的城市快照。
export const CreateTaskInputSchema = z.object({
  homeCity: z.string().trim().min(1, CREATE_TASK_ERRORS.homeCityRequired),
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

// ERP 填报与对账动作的错误：当前 step 不接受这个动作时服务端的回答（stepToken 过期仍走 stale_step）。
export const ERP_ACTION_ERRORS = {
  notReady: '现在还不能去报销，请先完成整单明细确认。',
  notWaitingLogin: '现在没有在等待登录。',
  notReconciling: '这个任务现在不在对账中。',
} as const;

// 项目归属：文案照内核 selection.mjs / project-workbench.mjs。页面只拦「未填完」，项目是否可用由服务端判定。
export const PURPOSE_MAX_LENGTH = 100;

export const PROJECT_ASSIGNMENT_ERRORS = {
  incomplete: '报销事由和每一条明细的项目都要填写',
  purpose: '报销事由必须填写，且不超过 100 个字',
  lineUnassigned: (no: number) => `明细 No.${no} 还没有选项目`,
  projectNotAllowed: (no: number, number: string) => `明细 No.${no} 的项目 ${number} 不在当前本人项目簿可选集合中；要用它请先在维护页重新核验`,
  unknownLine: (lineId: string) => `提交里出现了不存在的明细 ${lineId}，这批明细可能已经变了`,
  notReady: '现在不能提交项目归属：请先处理完待确认项；已开始 ERP 填报的任务不能再改派。',
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

// 打印稿动作（生成、旋转、四角裁剪）的错误文案；服务端与 mock 共用。这些动作不是答复类，不带 stepToken。
export const PRINT_ACTION_ERRORS = {
  notConfirmed: '打印稿需要先完成整单明细确认。',
  notGenerated: '打印稿还没有生成。',
  pageNotFound: '这一页已经不存在，请刷新后重试。',
  slotEmpty: '这半页没有放置材料。',
  notCroppable: '这份材料不支持四角裁剪。',
  invalidCorners: '四个角点须在原图范围内，且按左上、右上、右下、左下的顺序围成一个区域。',
} as const;

// 处理材料包缺项（resolve_preparation 下）：排除服务端在缺项上标明可排除的那份材料，服务端随后重新准备材料包。
export const EXCLUDE_MATERIAL_ERRORS = {
  notReady: '现在没有需要处理的材料包缺项。',
  notExcludable: '这份材料不能通过排除来处理，请按缺项说明处理。',
} as const;

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
  'exclude-material',
  'start-erp-write',
  'confirm-login',
  'reconcile',
  'hand-off',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
