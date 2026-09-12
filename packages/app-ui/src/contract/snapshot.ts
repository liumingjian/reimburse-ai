import { z } from 'zod';
import { AmountSchema, DateSchema, DateTimeSchema, IdSchema, StepTokenSchema, UrlSchema } from './primitives';
import { TaskStageSchema } from './stage';
import { TaskPeriodSchema } from './task-list';

// 接口二：单任务完整快照。前端只渲染这里的值，不保存第二份业务状态，不计算、不判定。
// 本文件在 #100 定下所有分节的名字与最小形状；后续票只加深分节，不重排结构。

// ---- 上传批次与材料 ----

// 上传约束（spec #99）：接受 pdf/jpg/jpeg/png；HEIC 拒绝并提示；单文件 20MB；内容哈希重复由服务端拒绝。
// 这些常量供服务端与 mock 共用；页面不据此判断，只显示服务端逐文件给出的结果。
export const UPLOAD_ACCEPTED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'] as const;
export const UPLOAD_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const UPLOAD_ACCEPT_ATTRIBUTE = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

export const UPLOAD_REJECT_CODES = ['unsupported_type', 'too_large', 'heic', 'duplicate_content'] as const;
export const UploadRejectCodeSchema = z.enum(UPLOAD_REJECT_CODES);
export type UploadRejectCode = z.infer<typeof UploadRejectCodeSchema>;

// 拒绝原因的固定开头；服务端可在其后补充细节（如与哪份材料重复）。
export const UPLOAD_REJECT_MESSAGES: Readonly<Record<UploadRejectCode, string>> = {
  unsupported_type: '类型不支持，只接受 PDF、JPG、PNG',
  too_large: '超过 20MB',
  heic: 'HEIC 不支持，请在 iPhone 相册导出为 JPG',
  duplicate_content: '内容重复',
};

export const UploadFileResultSchema = z.object({
  fileId: IdSchema,
  fileName: z.string().min(1),
  size: z.number().int().nonnegative(),
  status: z.enum(['accepted', 'rejected']),
  // 已接收的文件有内容哈希（sha256 十六进制），页面显示前 8 位作为身份；被拒绝的为 null。
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  // 拒绝原因由服务端给出成句（以 UPLOAD_REJECT_MESSAGES 开头，可补充细节）；已接收的为 null。
  reasonCode: UploadRejectCodeSchema.nullable(),
  reason: z.string().nullable(),
  materialId: IdSchema.nullable(),
});
export type UploadFileResult = z.infer<typeof UploadFileResultSchema>;

export const UploadBatchSchema = z.object({
  batchId: IdSchema,
  no: z.number().int().positive(),
  uploadedAt: DateTimeSchema,
  // 盘点版本；追加或删除材料后形成新版本，旧盘点与确认失效。
  versionId: z.string().nullable(),
  files: z.array(UploadFileResultSchema),
});
export type UploadBatch = z.infer<typeof UploadBatchSchema>;

export const EVIDENCE_STATES = ['explicit', 'derived', 'ambiguous', 'missing'] as const;
export const EvidenceStateSchema = z.enum(EVIDENCE_STATES);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

// 字段候选：材料原文的解释，附来源（规则名如 rule:amap_itinerary，或 user）与材料证据状态。
export const FieldCandidateSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
  source: z.string().min(1),
  evidence: EvidenceStateSchema,
});
export type FieldCandidate = z.infer<typeof FieldCandidateSchema>;

// uploaded：已接收但还没有盘点，角色未定。
export const MATERIAL_ROLES = ['uploaded', 'primary_voucher', 'reference', 'pending', 'excluded'] as const;
export const MaterialRoleSchema = z.enum(MATERIAL_ROLES);
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;

export const MATERIAL_ROLE_LABELS: Readonly<Record<MaterialRole, string>> = {
  uploaded: '待盘点',
  primary_voucher: '主要报销凭证',
  reference: '参考材料',
  pending: '待确认',
  excluded: '已排除',
};

export const MaterialSchema = z.object({
  materialId: IdSchema,
  batchId: IdSchema,
  fileName: z.string().min(1),
  contentHash: z.string().min(1),
  size: z.number().int().nonnegative(),
  kindLabel: z.string().min(1),
  categoryLabel: z.string().nullable(),
  role: MaterialRoleSchema,
  shape: z.enum(['portrait', 'landscape', 'photo']),
  // 原件类型决定预览方式：pdf 用 iframe，image 用 img。
  mediaType: z.enum(['pdf', 'image']),
  status: z.enum(['uploaded', 'ok', 'pending', 'excluded']),
  // 「校验」列文本，由服务端成句（配对、金额守恒、二维码核对结果）。
  checkText: z.string(),
  // 材料证据关联：与本材料共同证明同一费用事件的其他材料。
  linkedMaterialIds: z.array(IdSchema),
  pendingItemIds: z.array(IdSchema),
  originalUrl: UrlSchema.nullable(),
  previewUrl: UrlSchema.nullable(),
  fields: z.array(FieldCandidateSchema),
});
export type Material = z.infer<typeof MaterialSchema>;

export const ExpenseCategorySchema = z.object({
  // 内核类别 code（accommodation / local_city_transport / long_distance / remote_city_transport）；页面只显示 label。
  code: z.string().min(1),
  label: z.string().min(1),
});
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

// 费用事件：一笔可报销消费，由主要报销凭证与参考材料共同证明；一个事件对应一条候选明细。
// 事件按统一业务序号排列（no）；同一主要报销凭证的事件相邻。summary 与 evidenceNote 由服务端成句：
// summary 是一句话描述（如「高德 · 虹桥枢纽 → 漕河泾」），evidenceNote 是该凭证组的材料证据关联结论
// （如「打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒」），只放在组内第一个事件上，其余为 null。
export const ExpenseEventSchema = z.object({
  eventId: IdSchema,
  no: z.number().int().positive(),
  voucherMaterialId: IdSchema,
  referenceMaterialIds: z.array(IdSchema),
  category: ExpenseCategorySchema,
  summary: z.string(),
  evidenceNote: z.string().nullable(),
  date: DateSchema,
  endDate: DateSchema.nullable(),
  city: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  grossAmount: AmountSchema,
});
export type ExpenseEvent = z.infer<typeof ExpenseEventSchema>;

// ---- 材料盘点进度 ----

// 盘点由服务端分阶段推进并推送快照；页面只显示阶段名与状态。
export const InventoryPhaseSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['todo', 'running', 'done']),
});
export type InventoryPhase = z.infer<typeof InventoryPhaseSchema>;

// 盘点结果的计数，由服务端给出（页面不按状态或角色自己数）。openPendingItemCount 是还没处理的待确认项个数，
// 盘点页入口、待确认项页「还剩 n 个」与侧栏角标都读它。
export const InventorySummarySchema = z.object({
  materialCount: z.number().int().nonnegative(),
  okCount: z.number().int().nonnegative(),
  pendingMaterialCount: z.number().int().nonnegative(),
  voucherCount: z.number().int().nonnegative(),
  referenceCount: z.number().int().nonnegative(),
  openPendingItemCount: z.number().int().nonnegative(),
});
export type InventorySummary = z.infer<typeof InventorySummarySchema>;

export const InventorySchema = z.object({
  status: z.enum(['not_started', 'running', 'done']),
  versionId: z.string().nullable(),
  phases: z.array(InventoryPhaseSchema),
  finishedAt: DateTimeSchema.nullable(),
  // 盘点结束后才有值。
  summary: InventorySummarySchema.nullable(),
  // 没有归入任何费用事件的材料（待确认或已排除），按服务端给出的顺序显示在「未归入费用事件」组。
  ungroupedMaterialIds: z.array(IdSchema),
});
export type Inventory = z.infer<typeof InventorySchema>;

// ---- 待确认项 ----

export const PendingFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string(),
  required: z.boolean(),
  format: z.enum(['text', 'time', 'date']),
});
export type PendingField = z.infer<typeof PendingFieldSchema>;

export const PendingChoiceSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});
export type PendingChoice = z.infer<typeof PendingChoiceSchema>;

// 答复形状：form 类按 fields[].key 逐个给值；choice 类给 { [PENDING_CHOICE_KEY]: choices[].key }。
export const PENDING_CHOICE_KEY = 'choice';

export const PendingItemSchema = z.object({
  itemId: IdSchema,
  materialId: IdSchema,
  title: z.string().min(1),
  why: z.string(),
  kind: z.enum(['form', 'choice']),
  fields: z.array(PendingFieldSchema),
  choices: z.array(PendingChoiceSchema),
  status: z.enum(['open', 'resolved']),
  answer: z.record(z.string(), z.string()).nullable(),
});
export type PendingItem = z.infer<typeof PendingItemSchema>;

// ---- 候选明细（统一业务序号） ----

export const LineSchema = z.object({
  lineId: IdSchema,
  no: z.number().int().positive(),
  // 同一主要报销凭证的行共享 groupId，页面以左侧色条归组。
  groupId: IdSchema,
  voucherMaterialId: IdSchema,
  eventId: IdSchema.nullable(),
  date: DateSchema,
  endDate: DateSchema.nullable(),
  category: ExpenseCategorySchema,
  description: z.string(),
  invoiceType: z.string().min(1),
  referenceMaterialIds: z.array(IdSchema),
  grossAmount: AmountSchema,
  netAmount: AmountSchema,
  taxAmount: AmountSchema,
  fromPendingItemId: IdSchema.nullable(),
  // 这张发票是否可以补充支付截图（住宿发票为 true）；由服务端按票种判定，页面只据此显示入口。
  acceptsPaymentScreenshot: z.boolean(),
});
export type Line = z.infer<typeof LineSchema>;

// ---- 整单明细确认 ----

// 确认失效语义（内核 §2.6）：追加或删除材料形成新的盘点版本，旧确认与已生成的打印稿作废，状态记为 invalidated，
// 直到用户重新核对并确认。支付截图、打印稿的旋转与裁剪、项目归属都不进摘要，不使确认失效。
export const CONFIRMATION_STATUSES = ['unconfirmed', 'confirmed', 'invalidated'] as const;

// 失效提示由服务端成句；这是标准文案，服务端与 mock 共用。
export const REVIEW_INVALIDATED_NOTICE = '材料已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';

export const ConfirmationSchema = z.object({
  status: z.enum(CONFIRMATION_STATUSES),
  confirmedAt: DateTimeSchema.nullable(),
  // 确认所绑定的摘要；确认动作回传它，服务端据此判断用户点头的是不是这一份。
  digest: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  invoiceCount: z.number().int().nonnegative(),
  grossTotal: AmountSchema.nullable(),
  // 失效等提示，由服务端成句（如「材料已变更，之前的整单确认与已生成的打印稿作废」）。
  notice: z.string().nullable(),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

// ---- 支付截图与打印稿 ----

// 支付截图只接受图片（JPG、PNG），只进打印稿，不改变整单明细确认。每张发票至多一张，再补即替换。
export const PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE = '.jpg,.jpeg,.png,image/jpeg,image/png';

export const PAYMENT_SCREENSHOT_ERRORS = {
  notImage: '只接受图片（JPG、PNG）。',
  notApplicable: '这张发票不需要支付截图。',
  notFound: '这张支付截图已经不存在。',
} as const;

export const PaymentScreenshotSchema = z.object({
  screenshotId: IdSchema,
  voucherMaterialId: IdSchema,
  fileName: z.string().min(1),
  url: UrlSchema,
});
export type PaymentScreenshot = z.infer<typeof PaymentScreenshotSchema>;

// 四角坐标：原图像素（左上原点），依次为左上、右上、右下、左下。
export const PointSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
export const CornersSchema = z.tuple([PointSchema, PointSchema, PointSchema, PointSchema]);
export type Corners = z.infer<typeof CornersSchema>;

// 一页里放置的一份材料（上半页主要报销凭证 / 下半页证明材料）。旋转与裁剪都只是打印设置，不改原件、不进确认摘要。
export const PlacementSchema = z.object({
  materialId: IdSchema,
  fileName: z.string().min(1),
  // 当前是否旋转 90° 放置。服务端先按「竖放 / 旋转 90° 哪个缩放更大」给出默认值，员工可以改。
  rotate: z.boolean(),
  // 能否拖动四角微调裁剪（照片类材料，如出租车票照片）；由服务端判定，页面只据此显示入口。
  croppable: z.boolean(),
  // 当前使用的四角（原图像素）：自动检测的纸张边缘，或员工提交的微调结果；不可裁剪的材料为 null。
  corners: CornersSchema.nullable(),
  // corners 是否来自员工手动微调（否则是自动检测）。
  cropAdjusted: z.boolean(),
  // 原图地址：四角编辑器在它上面拖动角点。
  imageUrl: UrlSchema.nullable(),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const PrintPageSchema = z.object({
  pageId: IdSchema,
  no: z.number().int().positive(),
  // 页眉整句，如「No.3-5 · 08-10 · 外地市内交通 · 69.19」；范围用 ASCII 连字符。页面原样显示，不自己拼。
  header: z.string().min(1),
  nos: z.string().min(1),
  date: DateSchema,
  categoryLabel: z.string().min(1),
  grossAmount: AmountSchema,
  // 服务端按当前放置（旋转、裁剪、支付截图）渲染出的整页页图；设置变了，地址随之变。
  imageUrl: UrlSchema,
  top: PlacementSchema.nullable(),
  bottom: PlacementSchema.nullable(),
  screenshotId: IdSchema.nullable(),
});
export type PrintPage = z.infer<typeof PrintPageSchema>;

// not_generated：还没生成；generated：页图与合并 PDF 可用（调整后服务端立即重新渲染，仍是 generated）；
// stale：材料变更使确认失效，旧打印稿作废，须重新确认后再生成。
export const PRINT_SHEET_STATUSES = ['not_generated', 'generated', 'stale'] as const;

export const PrintSheetSchema = z.object({
  status: z.enum(PRINT_SHEET_STATUSES),
  // 合并 PDF 的文件名与下载地址（generated 时有值）。
  fileName: z.string().nullable(),
  url: UrlSchema.nullable(),
  pages: z.array(PrintPageSchema),
  // 服务端成句的提醒，如「No.2 住宿发票还没有支付截图。可以照常打印，该页下半页只放结账单。」；提醒不阻止下载。
  notices: z.array(z.string()),
});
export type PrintSheet = z.infer<typeof PrintSheetSchema>;

// ---- 项目归属 ----

// 规则照内核现有项目归属页面（project-workbench.mjs）：项目只能从个人项目簿的允许列表里选；
// 允许列表整份随快照给出，selectable 与 statusLabel 由服务端判定（可选 / 已过期 / 复检未通过 / 项目号不安全），页面只据此显示。
export const ProjectOptionSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  selectable: z.boolean(),
  statusLabel: z.string(),
});
export type ProjectOption = z.infer<typeof ProjectOptionSchema>;

// not_started：还没进入项目归属；pending：进入了、尚未提交（可能已有上次留下的归属）；submitted：已提交，可以去 ERP 填报。
export const PROJECT_ASSIGNMENT_STATUSES = ['not_started', 'pending', 'submitted'] as const;

export const ProjectLineAssignmentSchema = z.object({
  lineId: IdSchema,
  projectNumber: z.string().min(1),
  projectName: z.string().min(1),
});
export type ProjectLineAssignment = z.infer<typeof ProjectLineAssignmentSchema>;

export const ProjectAssignmentSchema = z.object({
  status: z.enum(PROJECT_ASSIGNMENT_STATUSES),
  // 报销事由，至多 100 个字；未填为 null。
  purpose: z.string().nullable(),
  // 常驻城市由身份确认固定，这里只读显示。
  homeCity: z.string().nullable(),
  // 服务端已记下的逐条归属（上次提交或预置的）；页面以它为初值。
  assignments: z.array(ProjectLineAssignmentSchema),
  // 个人项目簿允许列表，打开页面时整份给出；搜索只缩小显示，不缩小允许列表。
  projects: z.array(ProjectOptionSchema),
  submittedAt: DateTimeSchema.nullable(),
});
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

// ---- ERP 填报、回读、对账 ----

// ERP 动作进度：步骤、标题与说明都由服务端给出（启动浏览器、登录、导入发票、填明细、保存、严格回读），页面按顺序渲染。
// 登录步处于 waiting 时，当前待答 step 是 erp_login；「我已登录，继续」只是请服务端再探测一次，探测不到就留在原地并给出 loginNotice。
export const ErpStepSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['todo', 'running', 'waiting', 'done', 'failed']),
});
export type ErpStep = z.infer<typeof ErpStepSchema>;

export const ErpSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting_login', 'aborted', 'done']),
  steps: z.array(ErpStepSchema),
  draftNo: z.string().nullable(),
  abortReason: z.string().nullable(),
  loginNotice: z.string().nullable(),
});
export type Erp = z.infer<typeof ErpSchema>;

export const ReadbackRowSchema = z.object({
  no: z.number().int().positive(),
  description: z.string(),
  local: AmountSchema,
  // ERP 回读值；读不到时为 null（页面显示「需人工核对」）。
  erp: AmountSchema.nullable(),
  // 是否一致由服务端逐行判定（严格回读），页面只按这个标志着色。
  matched: z.boolean(),
});
export type ReadbackRow = z.infer<typeof ReadbackRowSchema>;

export const ReadbackSchema = z.object({
  status: z.enum(['none', 'matched', 'mismatched']),
  rows: z.array(ReadbackRowSchema),
  summary: z.string().nullable(),
  // 本地确认与 ERP 回读的价税合计合计，由服务端给出；页面不求和。
  localTotal: AmountSchema.nullable(),
  erpTotal: AmountSchema.nullable(),
});
export type Readback = z.infer<typeof ReadbackSchema>;

export const RECONCILE_ACTIONS = ['原地等待', '转人工'] as const;
// 建议处置的代码：页面按代码分支，按 action（文案）显示。
export const RECONCILE_ACTION_CODES = ['wait', 'hand_off'] as const;
export type ReconcileActionCode = (typeof RECONCILE_ACTION_CODES)[number];
export const RECONCILE_ACTION_LABELS: Readonly<Record<ReconcileActionCode, (typeof RECONCILE_ACTIONS)[number]>> = {
  wait: '原地等待',
  hand_off: '转人工',
};

// ERP 对账：写入中止后停在 reconcile 阶段；严格回读不一致时停在 done 阶段（完成页显示差异行与转人工）。
// bucket 是对账中断点（内核六类之一），action / actionCode 是建议处置的文案与代码。
// status：pending 等待用户选择处置；waiting 已重新对账、原地等待；handed_off 已转人工（终止后续 ERP 写入，终态）。
// 严格回读不一致时 rows 带逐行比对（与 readback.rows 相同），中止在保存步时 rows 可能为空。
export const ReconcileSchema = z.object({
  status: z.enum(['none', 'pending', 'waiting', 'handed_off']),
  bucket: z.string().nullable(),
  action: z.enum(RECONCILE_ACTIONS).nullable(),
  actionCode: z.enum(RECONCILE_ACTION_CODES).nullable(),
  banner: z.string().nullable(),
  draftNo: z.string().nullable(),
  rows: z.array(ReadbackRowSchema),
  reasons: z.array(z.string()),
});
export type Reconcile = z.infer<typeof ReconcileSchema>;

// ---- 当前待答 step ----

export const STEP_KINDS = [
  'none',
  'upload_materials',
  'start_inventory',
  'answer_pending',
  'confirm_review',
  'choose_action',
  'assign_projects',
  // 项目归属提交后等待「开始填报」；写入进行中为 none；登录步等待时为 erp_login；停在对账时为 reconcile。
  'start_erp_write',
  'erp_login',
  'reconcile',
  // 严格回读不一致、停在完成页：只接受「转人工」。
  'hand_off',
] as const;
export const StepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKindSchema>;

// stepToken 语义与内核 issueStep 一致：状态没变就是同一个凭据，状态一变旧凭据作废；过期回传得到 409 与最新快照。
export const StepSchema = z.object({
  kind: StepKindSchema,
  stepToken: StepTokenSchema,
});
export type Step = z.infer<typeof StepSchema>;

// ---- 快照 ----

export const TaskInfoSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
  period: TaskPeriodSchema.nullable(),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

export const TaskSnapshotSchema = z.object({
  task: TaskInfoSchema,
  stage: TaskStageSchema,
  batches: z.array(UploadBatchSchema),
  materials: z.array(MaterialSchema),
  inventory: InventorySchema,
  events: z.array(ExpenseEventSchema),
  pendingItems: z.array(PendingItemSchema),
  lines: z.array(LineSchema),
  confirmation: ConfirmationSchema,
  paymentScreenshots: z.array(PaymentScreenshotSchema),
  printSheet: PrintSheetSchema,
  projectAssignment: ProjectAssignmentSchema,
  erp: ErpSchema,
  readback: ReadbackSchema,
  reconcile: ReconcileSchema,
  step: StepSchema,
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
