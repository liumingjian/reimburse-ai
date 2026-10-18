import { z } from 'zod';
import { DateSchema, IdSchema } from './primitives';
import { DINING_INVOICE_KEY, CornersSchema, MANUAL_FILL_CHOICE, MANUAL_KIND_KEY, PENDING_CHOICE_KEY, TaskSnapshotSchema, fieldAnswer, isAllocationAnswer, type FieldAnswer, type PendingAnswer, type PendingField, type PendingItem, type PendingManualKind } from './snapshot';
import { TaskListSchema } from './task-list';

// 接口三：动作端点。成功返回新快照；失败返回 { error }；stepToken 过期返回 HTTP 409 与 { error, snapshot }。

// `link`: the page where the employee can fix what the refusal names, for a refusal that has one (`settings`: the 设置页).
export const ACTION_LINKS = ['settings'] as const;
export type ActionLink = (typeof ACTION_LINKS)[number];
export const ActionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  link: z.enum(ACTION_LINKS).optional(),
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
  // At most one non-terminal task per account (ADR-0018).
  activeTaskExists: '已有一个进行中的报销任务。请先完成或作废它，再新建。',
} as const;

// 任务之外、返回整份任务列表的动作（作废任务、完全重置）失败时的形状：{ error, taskList? }。
export const TaskListFailureSchema = z.object({
  error: ActionErrorSchema,
  taskList: TaskListSchema.optional(),
});
export type TaskListFailure = z.infer<typeof TaskListFailureSchema>;

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

// 待确认项答复的形状（PendingAnswerSchema）在 snapshot.ts，快照里已处理项的 answer 与它相同。

// 待确认项答复的格式校验文案，页面与服务端共用；页面据此在提交前拦住非法值，服务端再校验一次。
export const PENDING_ANSWER_ERRORS = {
  required: '必填，对照原件填写。',
  time: '格式应为 HH:MM，且小时 00-23、分钟 00-59。',
  date: '格式应为 YYYY-MM-DD，且是真实存在的日期。',
  money: '金额要写两位小数，例如 226.42。',
  choice: '请选择一种处理方式。',
  kind: '请选择材料种类。',
  notOpen: '这个待确认项已经处理过了。',
  // given_up 项不接受答复：出路在材料一侧（排除这张发票，或追加逐段行程单后重新盘点）。
  notAnswerable: '这一项不能直接答复：请排除这张发票，或在上传页追加列了逐段金额的行程单后重新盘点。',
} as const;

// 逐段分摊的文案。页面只拦格式（两位小数、大于 0、每段都填）；加起来对不对由服务端判定，不守恒时服务端用 notConserved 成句。
export const ALLOCATION_ERRORS = {
  amount: '金额要写两位小数，且大于 0，例如 26.69。',
  missing: '请逐段填写价税合计，或选「这张票我认不出」。',
  notConserved: (sum: string, total: string) =>
    `各段加起来是 ${sum} 元，和票面价税合计 ${total} 元对不上。请对照行程单重新填写，不会平均、不会按比例，也不会把差额加到任何一段上。`,
} as const;

// 逐段分摊的错误按段归档的键。
export const segmentKey = (index: number): string => `segment-${index}`;

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/;

type AnswerTarget = Pick<PendingItem, 'kind' | 'fields' | 'choices'> & Partial<Pick<PendingItem, 'allocation' | 'manualKinds'>>;

// 返回按字段 key 归档的错误；空对象表示合法。值先 trim 再判定。
export function validatePendingAnswer(item: AnswerTarget, answer: PendingAnswer): Record<string, string> {
  const errors: Record<string, string> = {};
  if (item.kind === 'given_up') {
    errors.item = PENDING_ANSWER_ERRORS.notAnswerable;
    return errors;
  }
  if (item.kind === 'allocation') {
    if (isAllocationAnswer(answer) && 'giveUp' in answer) return errors;
    const amounts = isAllocationAnswer(answer) && 'amounts' in answer ? answer.amounts : null;
    const segments = item.allocation?.segments ?? [];
    if (!amounts || amounts.length !== segments.length) {
      errors.allocation = ALLOCATION_ERRORS.missing;
      return errors;
    }
    segments.forEach((segment, index) => {
      const value = (amounts[index] ?? '').trim();
      if (!value) errors[segmentKey(segment.index)] = PENDING_ANSWER_ERRORS.required;
      else if (!AMOUNT_PATTERN.test(value) || value === '0.00') errors[segmentKey(segment.index)] = ALLOCATION_ERRORS.amount;
    });
    return errors;
  }
  const values = fieldAnswer(answer);
  if (item.kind === 'choice') {
    const chosen = (values[PENDING_CHOICE_KEY] ?? '').trim();
    if (!item.choices.some((choice) => choice.key === chosen)) errors[PENDING_CHOICE_KEY] = PENDING_ANSWER_ERRORS.choice;
    else if (chosen === MANUAL_FILL_CHOICE && item.manualKinds?.length) {
      const manual = manualKindOf(item, values);
      if (!manual) errors[MANUAL_KIND_KEY] = PENDING_ANSWER_ERRORS.kind;
      else {
        Object.assign(errors, fieldErrors(manual.fields, values));
        const target = values[DINING_INVOICE_KEY]?.trim();
        if (target && !manual.diningAssignment?.options.some((option) => option.invoiceId === target)) errors[DINING_INVOICE_KEY] = PENDING_ANSWER_ERRORS.choice;
      }
    }
    return errors;
  }
  return fieldErrors(item.fields, values);
}

// The 手工补填 form an answer picked, if it names one the item offers.
export function manualKindOf(item: Partial<Pick<PendingItem, 'manualKinds'>>, values: FieldAnswer): PendingManualKind | undefined {
  const kind = (values[MANUAL_KIND_KEY] ?? '').trim();
  return item.manualKinds?.find((manual) => manual.kind === kind);
}

function fieldErrors(fields: readonly PendingField[], values: FieldAnswer): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.key] ?? '').trim();
    if (!value) {
      if (field.required) errors[field.key] = PENDING_ANSWER_ERRORS.required;
      continue;
    }
    if (field.format === 'time' && !TIME_PATTERN.test(value)) errors[field.key] = PENDING_ANSWER_ERRORS.time;
    if (field.format === 'date' && !isRealDate(value)) errors[field.key] = PENDING_ANSWER_ERRORS.date;
    if (field.format === 'money' && !AMOUNT_PATTERN.test(value)) errors[field.key] = PENDING_ANSWER_ERRORS.money;
  }
  return errors;
}

// 去掉首尾空白后的答复；只保留该项定义的键（逐段分摊只保留 amounts 或 giveUp）。
export function normalizePendingAnswer(item: Pick<PendingItem, 'kind' | 'fields'> & Partial<Pick<PendingItem, 'manualKinds'>>, answer: PendingAnswer): PendingAnswer {
  if (item.kind === 'allocation') {
    if (!isAllocationAnswer(answer)) return { amounts: [] };
    return 'giveUp' in answer ? { giveUp: true } : { amounts: answer.amounts.map((amount) => amount.trim()) };
  }
  const values = fieldAnswer(answer);
  const manual = item.kind === 'choice' && values[PENDING_CHOICE_KEY]?.trim() === MANUAL_FILL_CHOICE ? manualKindOf(item, values) : undefined;
  const keys = manual ? [PENDING_CHOICE_KEY, MANUAL_KIND_KEY, ...manual.fields.map((field) => field.key), ...(manual.diningAssignment ? [DINING_INVOICE_KEY] : [])] : item.kind === 'choice' ? [PENDING_CHOICE_KEY] : item.fields.map((field) => field.key);
  const out: Record<string, string> = {};
  for (const key of keys) out[key] = (values[key] ?? '').trim();
  return out;
}

// 确认整单明细：动作回传快照里的 confirmation.digest 与 stepToken，服务端据此判断用户点头的是不是这一份。
export const CONFIRM_REVIEW_ERRORS = {
  digestMismatch: '整单明细已更新，请重新核对后再确认。',
  notReady: '现在不需要确认整单明细：还没有提交项目归属，或已经确认过。',
  noLines: '还没有明细，不能确认。',
  deadlineConfirmationRequired: '所选项目有截止日期提醒。请明确选择“仍然继续”后再确认。',
} as const;

export const ConfirmReviewInputSchema = z.object({
  digest: z.string().min(1),
  acceptDeadlineWarnings: z.boolean().optional().default(false),
});
export type ConfirmReviewInput = z.infer<typeof ConfirmReviewInputSchema>;

// 追加材料（确认后）：任务回到上传阶段接收新批次；已有的整单明细确认失效，已生成的打印稿作废。
export const REOPEN_UPLOAD_ERRORS = {
  erpStarted: '已开始写入报销系统，不能再追加材料。',
} as const;

// 写入报销系统与对账动作的错误：当前 step 不接受这个动作时服务端的回答（stepToken 过期仍走 stale_step）。
// notAllowed：对账结果不允许这个处置（页面只渲染 allowedActions，服务端仍然再核一次）。
export const ERP_ACTION_ERRORS = {
  notReady: '现在还不能去报销，请先完成整单明细确认。',
  notWaitingLogin: '现在没有在等待登录。',
  notReconciling: '这个任务现在不在对账中。',
  notAllowed: '当前对账结果不允许这个处置。',
  // Another task of the same 应用账号 (app account) holds that account's ERP lease; names no task (ADR-0019).
  // HTTP 409 `erp_in_use`. Another account's job never causes this refusal.
  inUse: '报销系统正被另一个任务使用，请稍后再试。',
  // Once an ERP action attempt exists the task's facts are frozen (ADR-0014).
  erpStarted: '已开始写入报销系统，不能再改动；请按对账结果处理。',
  // Checks that need no ERP (invoice identity, ERP invoice type, dates, amounts) failed; nothing was started.
  preflight: (problems: readonly string[]) => `还不能写入报销系统：${problems.join('；')}。`,
  // 去报销 runs only in the employee's paired 本地执行器 (ADR-0037); without one nothing is started (story 13).
  // `executor_not_paired` (EXECUTOR_NOT_PAIRED_CODE): this 应用账号 has no pairing; the refusal links to the 设置页.
  // `extension_offline`: paired, but the 本地执行器 is not connected.
  notPaired: '先在设置页安装本地执行器。',
  executorOffline: '本地执行器现在没有连上应用，所以现在去报销不了。请在电脑上打开 baox 本地执行器，等设置页显示已连接，再来去报销。',
} as const;

// The 去报销 refusal when the 应用账号 has no paired 本地执行器 (ADR-0037). It carries `link: 'settings'`.
export const EXECUTOR_NOT_PAIRED_CODE = 'executor_not_paired';

// The one task-action refusal that is HTTP 409 but not stale_step: this 应用账号's ERP lease is held by another of
// its own tasks.
// The web adapter keeps its code and message; every other task-action 409 is stale_step.
export const ERP_IN_USE_CODE = 'erp_in_use';

// 任务作废（任务之外的生命周期操作，内核 abandon-task）：任何状态的任务都可以作废（ADR-0030，2026-09-20 决定），
// 只有正在跑的那一下除外。作废是状态变更不是删除，任务从列表中移除，材料与记录保留在本机，
// 它占用的发票可以在别的任务里使用；报销系统里已经产生的单据不会被撤销。
export const ABANDON_TASK_COPY = {
  // 唯一挡住作废的状态：这个任务的写入或对账正在跑。它会自己跑完，不需要别的动作来解除。
  blockedReason: '正在写入报销系统或对账，等这一步跑完再作废。',
  notFound: '没有这个报销任务，列表可能已经变了。',
  dialogTitle: '作废这个报销任务？',
  dialogBody: '作废后任务从列表中移除，材料与记录保留在本机，它占用的发票可以在别的任务里使用。作废不能撤销。',
  // Shown in place of `dialogBody` for a task that already touched ERP: voiding is local and undoes nothing over there.
  dialogBodyErpTouched:
    '这个任务已经写入过报销系统。作废只改本机的状态：报销系统里已经产生的费用报销单和已导入的发票不会被撤销，要你自己去报销系统里处理。作废后任务从列表中移除，材料与记录保留在本机，它占用的发票可以在别的任务里使用。作废不能撤销。',
  confirm: '作废',
} as const;

// 完全重置（设置页）：只清空当前登录账号自己的数据（报销任务、个人项目簿、常驻城市），别的账号不受影响，账号本身与登录状态保留。
// 报销系统里已保存的草稿不受影响。
export const RESET_COPY = {
  title: '完全重置',
  body: '清空你这个账号的全部报销任务、材料、个人项目簿和常驻城市，别的账号的数据不受影响。报销系统里已保存的草稿不受影响。',
  button: '完全重置',
  dialogTitle: '清空你的全部数据？',
  dialogBody: '你这个账号的报销任务、材料、个人项目簿和常驻城市都会被清空，不能撤销。账号本身保留，不用重新登录。',
  confirm: '清空并重置',
} as const;

// 项目归属：文案照内核 selection.mjs / project-workbench.mjs。页面只拦「未填完」，项目是否可用由服务端判定。
export const PURPOSE_MAX_LENGTH = 100;

export const PROJECT_ASSIGNMENT_ERRORS = {
  incomplete: '报销事由和每一条明细的项目都要填写',
  purpose: '报销事由必须填写，且不超过 100 个字',
  lineUnassigned: (no: number) => `明细 No.${no} 还没有选项目`,
  projectNotAllowed: (no: number, number: string) => `明细 No.${no} 的项目 ${number} 不在当前本人项目簿可选集合中；要用它请先在维护页重新核验`,
  unknownLine: (lineId: string) => `提交里出现了不存在的明细 ${lineId}，这批明细可能已经变了`,
  notReady: '现在不能提交项目归属：请先处理完待确认项；已开始写入报销系统的任务不能再改派。',
  bookEmpty: '当前个人项目簿没有可选项目；先维护本人项目簿，再回来做任务选择',
  // 「归入」动作：新的归属只能用当前可选项目（已删除或失效的项目，已归入的明细可以沿用，但不能再归入新的明细）。
  projectNotSelectable: (number: string) => `项目 ${number} 不在当前本人项目簿可选集合中，不能归入新的明细；要用它请先在维护页重新核验`,
  noLinesSelected: '请先勾选要归入的明细',
  deadlineConfirmationRequired: '所选项目有截止日期提醒。请明确选择“仍然继续”后再提交。',
} as const;

export const PROJECT_DEADLINE_WARNING_COPY = {
  title: '项目截止日期提醒',
  notice: '以下费用与所选项目的截止日期不一致。项目仍可继续使用；请明确确认后继续，系统不会拆分报销任务。',
  afterDeadline: (lineNo: number, projectNumber: string, deadlineOn: string) => `明细 No.${lineNo} 的费用发生日在项目 ${projectNumber} 的截止日期 ${deadlineOn} 之后。`,
  stayCrossesDeadline: (lineNo: number, projectNumber: string, deadlineOn: string) => `明细 No.${lineNo} 的住宿期间跨过项目 ${projectNumber} 的截止日期 ${deadlineOn}。`,
  continue: '仍然继续',
} as const;

// 「归入」：把勾选的明细归入某个可选项目，只改本次正在编辑的归属（working），不是提交。
// onlyUnassigned 为真时只给还没有项目的明细归入（冲突提示里的「只处理未归属」），否则覆盖。
export const AssignProjectLinesInputSchema = z.object({
  lineIds: z.array(IdSchema).min(1, PROJECT_ASSIGNMENT_ERRORS.noLinesSelected),
  projectNumber: z.string().min(1),
  onlyUnassigned: z.boolean(),
});
export type AssignProjectLinesInput = z.infer<typeof AssignProjectLinesInputSchema>;

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
  acceptDeadlineWarnings: z.boolean().optional().default(false),
});
export type ProjectAssignmentInput = z.input<typeof ProjectAssignmentInputSchema>;

// 修改当前任务的常驻城市（set-home-city，带 stepToken）：第一次写入报销系统之前都可以改；改后按新城市重新推导费用类别、
// 整单确认随之失效，并成为这个账号新建任务时的默认值（ADR-0014 经 ADR-0016 修订）。
export const HOME_CITY_ERRORS = {
  invalid: '常驻城市必须填写，且不超过 20 个字。',
  locked: '已开始写入报销系统，常驻城市不能再修改。',
} as const;

export const SetHomeCityInputSchema = z.object({
  homeCity: z.string().trim().min(1, HOME_CITY_ERRORS.invalid),
});
export type SetHomeCityInput = z.infer<typeof SetHomeCityInputSchema>;

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
  // 生成前逐份核对原件哈希：磁盘上的原件与上传时不一致，就不生成（服务端）。
  blobMismatch: '有一份原件与上传时的内容不一致，打印稿没有生成。请排除这份材料或重新上传后再试。',
} as const;

// 排除材料（exclude-material，带 stepToken），服务端只在三种情形下接受：
// - 材料包缺项（resolve_preparation 下）：排除缺项上标明可排除的那份材料，服务端随后重新准备材料包；
// - 「这张票我认不出」留下的 given_up 待确认项（answer_pending 下）：排除这张发票连同它的行程单，其余待确认项照常；
// - 跨任务重复发票（盘点停在 inventory、有阻塞项）：把重复的那份移出本次材料，服务端接着划分费用事件。
export const EXCLUDE_MATERIAL_ERRORS = {
  notReady: '现在没有需要通过排除材料来处理的事项。',
  notExcludable: '这份材料不能通过排除来处理，请按缺项说明处理。',
} as const;

// 动作名与 HTTP 路径片段一一对应：POST /api/tasks/:id/actions/<name>
export const ACTION_NAMES = [
  'start-inventory',
  'answer-pending',
  'confirm-review',
  'reopen-upload',
  'remove-payment-screenshot',
  'complete-payment-screenshots',
  'generate-print-sheet',
  'rotate-placement',
  'crop-placement',
  'assign-project-lines',
  'submit-project-assignment',
  'exclude-material',
  'set-home-city',
  'start-erp-write',
  'confirm-login',
  'cancel-erp-write',
  'reconcile',
  'hand-off',
  'refill',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
