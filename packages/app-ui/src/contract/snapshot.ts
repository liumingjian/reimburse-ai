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

// 费用事件：一笔可报销消费，由主要报销凭证与参考材料共同证明；一个事件对应一条候选明细。
export const ExpenseEventSchema = z.object({
  eventId: IdSchema,
  voucherMaterialId: IdSchema,
  referenceMaterialIds: z.array(IdSchema),
  date: DateSchema,
  endDate: DateSchema.nullable(),
  city: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  grossAmount: AmountSchema,
});
export type ExpenseEvent = z.infer<typeof ExpenseEventSchema>;

// ---- 待确认项 ----

export const PendingFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string(),
  required: z.boolean(),
  format: z.enum(['text', 'time', 'date']),
});
export type PendingField = z.infer<typeof PendingFieldSchema>;

export const PendingItemSchema = z.object({
  itemId: IdSchema,
  materialId: IdSchema,
  title: z.string().min(1),
  why: z.string(),
  kind: z.enum(['form', 'choice']),
  fields: z.array(PendingFieldSchema),
  choices: z.array(z.string().min(1)),
  status: z.enum(['open', 'resolved']),
  answer: z.record(z.string(), z.string()).nullable(),
});
export type PendingItem = z.infer<typeof PendingItemSchema>;

// ---- 候选明细（统一业务序号） ----

export const ExpenseCategorySchema = z.object({
  // 内核类别 code（accommodation / local_city_transport / long_distance / remote_city_transport）；页面只显示 label。
  code: z.string().min(1),
  label: z.string().min(1),
});
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

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
});
export type Line = z.infer<typeof LineSchema>;

// ---- 整单明细确认 ----

export const ConfirmationSchema = z.object({
  status: z.enum(['unconfirmed', 'confirmed', 'invalidated']),
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

export const PaymentScreenshotSchema = z.object({
  screenshotId: IdSchema,
  voucherMaterialId: IdSchema,
  fileName: z.string().min(1),
  url: UrlSchema,
});
export type PaymentScreenshot = z.infer<typeof PaymentScreenshotSchema>;

export const PointSchema = z.tuple([z.number(), z.number()]);
export const CornersSchema = z.tuple([PointSchema, PointSchema, PointSchema, PointSchema]);
export type Corners = z.infer<typeof CornersSchema>;

export const PlacementSchema = z.object({
  materialId: IdSchema,
  rotate: z.boolean(),
  corners: CornersSchema.nullable(),
  imageUrl: UrlSchema.nullable(),
});
export type Placement = z.infer<typeof PlacementSchema>;

export const PrintPageSchema = z.object({
  pageId: IdSchema,
  no: z.number().int().positive(),
  // 页眉整句，如「No.3-5 · 08-10 · 外地市内交通 · 69.19」；范围用 ASCII 连字符。
  header: z.string().min(1),
  nos: z.string().min(1),
  date: DateSchema,
  categoryLabel: z.string().min(1),
  grossAmount: AmountSchema,
  top: PlacementSchema.nullable(),
  bottom: PlacementSchema.nullable(),
  screenshotId: IdSchema.nullable(),
});
export type PrintPage = z.infer<typeof PrintPageSchema>;

export const PrintSheetSchema = z.object({
  status: z.enum(['not_generated', 'generated', 'stale']),
  fileName: z.string().nullable(),
  url: UrlSchema.nullable(),
  pages: z.array(PrintPageSchema),
  notices: z.array(z.string()),
});
export type PrintSheet = z.infer<typeof PrintSheetSchema>;

// ---- 项目归属 ----

export const ProjectOptionSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  selectable: z.boolean(),
  statusLabel: z.string(),
});
export type ProjectOption = z.infer<typeof ProjectOptionSchema>;

export const ProjectAssignmentSchema = z.object({
  status: z.enum(['not_started', 'pending', 'submitted']),
  purpose: z.string().nullable(),
  homeCity: z.string().nullable(),
  assignments: z.array(
    z.object({
      lineId: IdSchema,
      projectNumber: z.string().min(1),
      projectName: z.string().min(1),
    }),
  ),
  // 个人项目簿允许列表，打开页面时整份给出；搜索只缩小显示，不缩小允许列表。
  projects: z.array(ProjectOptionSchema),
});
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

// ---- ERP 填报、回读、对账 ----

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
  erp: AmountSchema.nullable(),
  matched: z.boolean(),
});
export type ReadbackRow = z.infer<typeof ReadbackRowSchema>;

export const ReadbackSchema = z.object({
  status: z.enum(['none', 'matched', 'mismatched']),
  rows: z.array(ReadbackRowSchema),
  summary: z.string().nullable(),
});
export type Readback = z.infer<typeof ReadbackSchema>;

export const RECONCILE_ACTIONS = ['原地等待', '转人工'] as const;

export const ReconcileSchema = z.object({
  status: z.enum(['none', 'pending', 'waiting', 'handed_off']),
  bucket: z.string().nullable(),
  action: z.enum(RECONCILE_ACTIONS).nullable(),
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
  'erp_login',
  'reconcile',
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
