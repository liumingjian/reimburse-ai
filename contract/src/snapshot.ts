import { z } from 'zod';
import { AmountSchema, DateSchema, DateTimeSchema, IdSchema, StepTokenSchema, UrlSchema } from './primitives';
import { TaskActionSchema, TaskStageSchema } from './stage';
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
  // Relative source provenance. A single-file selection uses the file name; a directory selection keeps its nested
  // folders (for example `travel/2026-08/hotel/invoice.pdf`).
  relativePath: z.string().min(1),
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

// 材料种类 (material kind, ADR-0017): owns the slot schema, checks and manual-fill form. v1 has five kinds; a
// 版式 (layout) belongs to exactly one kind.
export const MATERIAL_KINDS = ['vat_invoice', 'rail_ticket', 'ride_itinerary', 'hotel_folio', 'taxi_receipt'] as const;
export const MaterialKindSchema = z.enum(MATERIAL_KINDS);
export type MaterialKind = z.infer<typeof MaterialKindSchema>;

// A layout name inside its kind, e.g. `einvoice`, `12306`, `amap`.
export const LAYOUT_NAME_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

// Candidate source (ADR-0017): `rule:<kind>/<layout>` from a layout parser, optionally `.<derivation>` for a derived
// value (`rule:taxi_receipt/machine_printed.year_from_suffix`), or `user` for manual fill. The e-invoice QR code is
// its own source, `rule:vat_invoice/einvoice_qr`.
export const CANDIDATE_SOURCE_PATTERN = /^(?:rule:[a-z][a-z0-9_]*\/[a-z0-9][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?|user)$/;

// Edit classes (ADR-0017): `fact_locked` is a 票面事实 (face fact) from a PDF text layer or QR code and refuses edits;
// `fact_correctable` comes from OCR or manual fill and is re-checked on correction, never back-calculated;
// `presentation` is free wording stored as a 呈现值 (presentation value) while checks keep the resolved value;
// `choice` is a derived business value limited to what the company rules allow.
export const EDIT_CLASSES = ['fact_locked', 'fact_correctable', 'presentation', 'choice'] as const;
export const EditClassSchema = z.enum(EDIT_CLASSES);
export type EditClass = z.infer<typeof EditClassSchema>;

// 字段候选：材料原文的解释，附来源（CANDIDATE_SOURCE_PATTERN）与材料证据状态。
export const FieldCandidateSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
  source: z.string().regex(CANDIDATE_SOURCE_PATTERN),
  // Version of the parser that produced a `rule:` candidate; null for `user`.
  parserVersion: z.string().min(1).nullable(),
  evidence: EvidenceStateSchema,
  // Whether and how the user may edit this field (EDIT_CLASSES).
  editClass: EditClassSchema,
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

// A retained source that supports the same invoice as its parent material. The parent is the canonical material for
// the reimbursement flow; variants remain independently inspectable and are never deleted by the projection.
export const MaterialVariantSchema = z.object({
  materialId: IdSchema,
  fileName: z.string().min(1),
  relativePath: z.string().min(1),
  contentHash: z.string().min(1),
  size: z.number().int().nonnegative(),
  mediaType: z.enum(['pdf', 'image']),
  originalUrl: UrlSchema.nullable(),
  previewUrl: UrlSchema.nullable(),
});
export type MaterialVariant = z.infer<typeof MaterialVariantSchema>;

export const MaterialSchema = z.object({
  materialId: IdSchema,
  batchId: IdSchema,
  fileName: z.string().min(1),
  // Relative source provenance, retained independently of the display file name.
  relativePath: z.string().min(1),
  contentHash: z.string().min(1),
  size: z.number().int().nonnegative(),
  // 材料种类; null before inventory and while unrecognised (manual fill sets it, #187).
  kind: MaterialKindSchema.nullable(),
  // 版式 within the kind; null before inventory, while unrecognised, and for manual fill.
  layout: z.string().regex(LAYOUT_NAME_PATTERN).nullable(),
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
  // Alternate originals of this invoice. The server chooses the canonical material; clients only render this list.
  variants: z.array(MaterialVariantSchema),
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
// 盘点页入口、待确认项页「还剩 n 个」与步骤条角标都读它。
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

// 处理人：内核 WHO（next.mjs:428）。待确认项照内核开放项表（next.mjs:451-475）逐条标明；报销信息核对的不匹配表、
// 材料包缺项表与重复发票表也用它。
export const RESOLVER_LABELS = ['要你处理', '我来处理', '系统'] as const;
export const ResolverLabelSchema = z.enum(RESOLVER_LABELS);
export type ResolverLabel = z.infer<typeof ResolverLabelSchema>;

export const PendingFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string(),
  required: z.boolean(),
  // money：两位小数的金额，如 226.42。
  format: z.enum(['text', 'time', 'date', 'money']),
});
export type PendingField = z.infer<typeof PendingFieldSchema>;

export const PendingChoiceSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});
export type PendingChoice = z.infer<typeof PendingChoiceSchema>;

// 答复形状：
// - form 类按 fields[].key 逐个给值；
// - choice 类给 { [PENDING_CHOICE_KEY]: choices[].key }；
// - allocation 类给 { amounts: [...] }（按 segments 顺序，每段的价税合计，两位小数）或 { giveUp: true }（「这张票我认不出」）。
export const PENDING_CHOICE_KEY = 'choice';

export const FieldAnswerSchema = z.record(z.string(), z.string());
export type FieldAnswer = z.infer<typeof FieldAnswerSchema>;
export const AllocationAnswerSchema = z.union([z.strictObject({ amounts: z.array(z.string()) }), z.strictObject({ giveUp: z.literal(true) })]);
export type AllocationAnswer = z.infer<typeof AllocationAnswerSchema>;
export const PendingAnswerSchema = z.union([AllocationAnswerSchema, FieldAnswerSchema]);
export type PendingAnswer = z.infer<typeof PendingAnswerSchema>;

export function isAllocationAnswer(answer: PendingAnswer): answer is AllocationAnswer {
  const value = answer as Record<string, unknown>;
  return Array.isArray(value.amounts) || value.giveUp === true;
}

// form / choice 类答复的键值；逐段分摊的答复或没有答复时为空对象。
export function fieldAnswer(answer: PendingAnswer | null): FieldAnswer {
  return answer && !isAllocationAnswer(answer) ? answer : {};
}

// 逐段分摊（内核 allocation_required，next.mjs:1112-1151，docs/design/standalone-app.md）：一张合并的交通发票票面只有一个价税合计、行程单上有多段，
// 且逐段金额加起来和票面对不上时才出现。每段金额由用户给，是否按分守恒由服务端判定（不守恒返回错误，页面只显示）；
// 服务端不平均、不按比例，也不把差额加到任何一段上。用户也可以选「这张票我认不出」放弃，后果说明由服务端给出（giveUpNote）。
// 放弃照内核（allocate.mjs givenUpOpenItems，state.mjs allocation_given_up）：逐段分摊项记为已处理，同时出现一条阻塞的
// given_up 待确认项。它不能答复，出路在材料一侧：用 exclude-material 把这张发票连同它的行程单排除，或追加逐段行程单后重新盘点。
export const AllocationSegmentSchema = z.object({
  // 第几段（从 1 起）。
  index: z.number().int().positive(),
  date: DateSchema,
  // 如「虹桥枢纽 → 漕河泾」。
  route: z.string().min(1),
  // 行程单上写的这一段金额；没写为 null。页面拿它预填，不据此计算。
  suggested: AmountSchema.nullable(),
});
export type AllocationSegment = z.infer<typeof AllocationSegmentSchema>;

export const PendingAllocationSchema = z.object({
  segments: z.array(AllocationSegmentSchema).min(1),
  // 票面价税合计。
  total: AmountSchema,
  giveUpNote: z.string().min(1),
});
export type PendingAllocation = z.infer<typeof PendingAllocationSchema>;

// given_up：内核 allocation_given_up，阻塞，不接受 answer-pending；why 是服务端给的后果说明，
// 唯一的应用内处置是 exclude-material（materialId 就是这张发票，服务端连同它的行程单一起排除）。
export const PENDING_ITEM_KINDS = ['form', 'choice', 'allocation', 'given_up'] as const;

// 空文本 PDF、多页发票（内核 pdf_markdown_conversion_empty / multi_page_invoice）是「要你处理」的 choice 类，
// 只给「排除」一个选择；换原件走追加材料、重新盘点。
export const PendingItemSchema = z.object({
  itemId: IdSchema,
  materialId: IdSchema,
  title: z.string().min(1),
  why: z.string(),
  kind: z.enum(PENDING_ITEM_KINDS),
  resolver: ResolverLabelSchema,
  fields: z.array(PendingFieldSchema),
  choices: z.array(PendingChoiceSchema),
  // allocation 类的逐段内容；其他类为 null。
  allocation: PendingAllocationSchema.nullable(),
  status: z.enum(['open', 'resolved']),
  answer: PendingAnswerSchema.nullable(),
});
export type PendingItem = z.infer<typeof PendingItemSchema>;

// ---- 整批停的阻塞项 ----

// 跨任务重复发票（内核 duplicate_blocked，next.mjs:1088-1102；按发票身份判定，不是文件内容）：命中就停整批。
// 盘点结束，但不划分费用事件、不形成待确认项；阶段停在 inventory，step 为 none（带凭据）。
// 处置照内核「把文件移出」：exclude-material 带阻塞项的 materialId，服务端把它移出本次材料（之后重新盘点也不再算它），
// 阻塞随之解除，接着划分费用事件与待确认项。
// 行文字由服务端成句；表格列照内核 itemTable（next.mjs:452-458），「参考材料」列内核写破折号，页面留空。
export const BLOCKER_KINDS = ['duplicate_across_tasks'] as const;
export const BLOCKER_TABLE_COLUMNS = ['序号', '材料/明细', '参考材料', '待处理问题', '处理人'] as const;

export const BlockerTaskSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
});
export type BlockerTask = z.infer<typeof BlockerTaskSchema>;

export const BlockerSchema = z.object({
  kind: z.enum(BLOCKER_KINDS),
  materialId: IdSchema,
  fileName: z.string().min(1),
  // 「待处理问题」列，如「这张发票在报销任务「2026-06 北京培训」里也在……」。
  reason: z.string().min(1),
  resolver: ResolverLabelSchema,
  // 命中的任务：仍占用这张发票的自己的其他报销任务。另一个账号的任务占用时为空：只说「已被另一个账号的任务占用」，
  // 不透露任务名称或任何细节（ADR-0018）。
  tasks: z.array(BlockerTaskSchema),
});
export type Blocker = z.infer<typeof BlockerSchema>;

// 重复发票的阻塞与处置说明，照内核话术（去掉「告诉我」，报销系统不写作 ERP）。服务端与 mock 共用。
export const DUPLICATE_BLOCKER_COPY = {
  blocked: '发现重复发票：同一张发票不能报两次，这批材料整批暂停，不会划分费用事件。',
  disposal: '请点「移出」把重复的发票移出本次材料，移出后接着划分费用事件。',
  scope: '这里只比对了本机记过、仍占用发票的报销任务；直接在报销系统里录入的、同事报过的、或者换电脑之前报过的，这里查不到。',
} as const;

// ---- 候选明细（统一业务序号） ----

// 统一业务序号（No.）由服务端给出，整单确认表、打印稿页序、ERP 明细行与回读表共用：
// 跟随内核确认表的费用分类排序（next.mjs preparationConfirmationTable）：本地市内交通 → 外地市内交通 → 长途交通 → 住宿；
// 同一分类内保持内核的事件顺序（先按主要报销凭证，再按行程段）。页面只按 lines[] 的顺序渲染，从不自己排序或编号。
export const LineSchema = z.object({
  lineId: IdSchema,
  no: z.number().int().positive(),
  voucherMaterialId: IdSchema,
  // 发票短标签「发票N」，编号规则照内核（next.mjs:518-519）：按材料包里主要发票的 materialId 顺序编号，
  // 所以不跟随表格行序。整单确认表只展示它，不展示完整发票号或文件名。
  invoiceLabel: z.string().min(1),
  eventId: IdSchema.nullable(),
  date: DateSchema,
  // 住宿为离店日期；交通类为 null（确认表的结束日期照内核取 endDate ?? date，即与起始日期相同）。
  endDate: DateSchema.nullable(),
  category: ExpenseCategorySchema,
  description: z.string(),
  // 住宿地/城市、出发点、目的地（内核 line.city / origin / destination）；没有的为 null。
  city: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  // 路线（内核 line.route，如「杭州东 → 上海虹桥」）与脱敏票号（内核 maskNumber，如「2631************7734」）；
  // 项目归属页的明细卡片照内核 project-workbench.mjs 展示。没有的为 null。
  route: z.string().nullable(),
  maskedNumber: z.string().nullable(),
  // 项目归属提交后由服务端写入（内核 buildPreparation 投影 selection，preparation.mjs:568-571）；之前为 null。
  projectCode: z.string().nullable(),
  projectName: z.string().nullable(),
  // 费用项目编码与名称（如 FY020102 / 住宿费），由服务端给出；名称在报销信息核对后取报销系统回读值。
  expenseItemCode: z.string().nullable(),
  expenseItemName: z.string().nullable(),
  invoiceType: z.string().min(1),
  // The evidence behind the ERP enum value, distinct from the material's parsed 发票票种.
  invoiceTypeSource: z.string().min(1),
  referenceMaterialIds: z.array(IdSchema),
  grossAmount: AmountSchema,
  netAmount: AmountSchema,
  taxAmount: AmountSchema,
});
export type Line = z.infer<typeof LineSchema>;

// 整单确认表的 13 列，列名与顺序逐字照抄内核 preparationConfirmationTable（next.mjs:522-535）。
// 页面在前面加一列 No.（统一业务序号，打印稿与 ERP 明细行共用）。「项目号」「费用项目」单元格为「编码 / 名称」，
// 「费用金额」为不含税金额，「总额」为价税合计。按费用分类排序（服务端给出的 lines[] 顺序），无组标题、无合计行。
export const CONFIRMATION_NO_COLUMN = 'No.';
export const CONFIRMATION_TABLE_COLUMNS = [
  '发票',
  '项目号',
  '起始日期',
  '结束日期',
  '住宿地/城市',
  '出发点',
  '目的地',
  '费用分类',
  '费用项目',
  '发票类型',
  '费用金额',
  '税额',
  '总额',
] as const;

// ---- 整单明细确认 ----

// 唯一一次整单确认（内核 preparation_confirmation）：在项目归属、报销信息核对与材料准备之后。
// 确认绑定的摘要包含项目归属与报销事由（内核 preparationDigest 的 sourceSnapshot 含 selection，preparation.mjs:973-992），
// 以及材料包（待服务端 spec 确认具体构成）。因此：
// - 追加或删除材料形成新的盘点版本，旧确认与已生成的打印稿作废；
// - 确认后改派项目或改事由，旧确认失效，须重新确认；
// 两种情况状态都记为 invalidated，直到用户重新核对并确认。支付截图、打印稿的旋转与裁剪不进摘要，不使确认失效。
export const CONFIRMATION_STATUSES = ['unconfirmed', 'confirmed', 'invalidated'] as const;

// 失效提示由服务端成句；这些是标准文案，服务端与 mock 共用。
export const REVIEW_INVALIDATED_NOTICE = '材料已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';
export const PROJECT_CHANGED_NOTICE = '项目归属已变更，之前的整单明细确认失效。请重新核对后再确认。';
// 明细内容（字段修改、常驻城市、公司规则）变了，材料没变。
export const DETAIL_CHANGED_NOTICE = '整单明细已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';

export const ConfirmationSchema = z.object({
  status: z.enum(CONFIRMATION_STATUSES),
  confirmedAt: DateTimeSchema.nullable(),
  // 确认所绑定的摘要（含项目归属）；确认动作回传它，服务端据此判断用户点头的是不是这一份。
  // 项目归属提交、报销信息核对与材料准备完成之前为 null（还没有可确认的一份）。
  digest: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  invoiceCount: z.number().int().nonnegative(),
  grossTotal: AmountSchema.nullable(),
  // 材料包文件清单在 preparation.packageFiles（唯一来源），这里不再另记文件数。
  // 失效等提示，由服务端成句（如「材料已变更，之前的整单确认与已生成的打印稿作废」）。
  notice: z.string().nullable(),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

// ---- 支付截图与打印稿 ----

// A 支付截图 (payment screenshot) is an image only (JPG, PNG). It goes on the 打印稿 (print sheet) alone and never changes
// the lines. Only a 住宿 (accommodation) invoice takes them, and only from its missing-screenshot 待确认项 (pending
// item; #213, see STAY_TRIO_COPY): a group of up to PAYMENT_SCREENSHOT_CAP, one image per upload, kept in upload order.
// The group is the snapshot's `paymentScreenshots` with the invoice's `voucherMaterialId`, in list order; the filer
// closes it with 「已传齐」 (`completePaymentScreenshots`).
export const PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE = '.jpg,.jpeg,.png,image/jpeg,image/png';
export const PAYMENT_SCREENSHOT_CAP = 6;

// The 住宿 (accommodation) trio check at 盘点 (inventory), #213. 住宿 reimbursement takes three materials: the 发票
// (invoice), the 结账单 (hotel folio) and the 支付截图 (payment screenshot). Inventory raises one 待确认项 per missing
// invoice or folio; the item disappears once the material is supplied, or settles on the choice
// `STAY_TRIO_CONFIRM_NONE`, which records the absence. Every 住宿 invoice carries a screenshot item: it stays open
// while its group is empty or not yet declared complete (「已传齐」), and settles on the declaration or on
// `STAY_TRIO_CONFIRM_NONE` while the group is empty. An upload supersedes a `STAY_TRIO_CONFIRM_NONE` for good. A resolved
// item's group still takes additions and removals until the list is confirmed; removing its last screenshot opens the
// item again (#332). The print stage reads that record instead of judging the absence again. All filer-facing
// wording of the check lives here, shared by the server and the page.
export const STAY_TRIO_ELEMENTS = ['invoice', 'folio', 'screenshot'] as const;
export type StayTrioElement = (typeof STAY_TRIO_ELEMENTS)[number];

// Item ids are `<code>.<materialId>`: the invoice's id for folio / screenshot, the folio's id for a missing invoice.
export const STAY_TRIO_ITEM_CODES: Readonly<Record<StayTrioElement, string>> = {
  invoice: 'stay_invoice_missing',
  folio: 'stay_folio_missing',
  screenshot: 'stay_screenshot_missing',
};
export const STAY_TRIO_CONFIRM_NONE = 'confirm_none';

// The one place a trio item id is built and read back.
export const stayTrioItemId = (element: StayTrioElement, materialId: string): string => `${STAY_TRIO_ITEM_CODES[element]}.${materialId}`;
export const stayTrioElementOf = (itemId: string): StayTrioElement | null => STAY_TRIO_ELEMENTS.find((element) => itemId.startsWith(`${STAY_TRIO_ITEM_CODES[element]}.`)) ?? null;

// Whether a pending item is the missing-screenshot item, which the page answers with an upload as well as a choice.
export const isStayScreenshotItem = (item: Pick<PendingItem, 'itemId'>): boolean => stayTrioElementOf(item.itemId) === 'screenshot';

const TRIO = '住宿报销要发票、结账单、支付截图三样。';
const amountNote = (label: string, amount: string | undefined) => (amount ? `（${label} ${amount} 元）` : '');

export const STAY_TRIO_COPY = {
  folio: {
    title: (invoiceFileName: string) => `住宿发票「${invoiceFileName}」缺少结账单`,
    why: (totalAmount: string | undefined) =>
      `${TRIO}这张住宿发票${amountNote('价税合计', totalAmount)}没有配对到结账单：结账单的消费合计要和发票价税合计一分不差，才算同一次住宿。请在上传页追加结账单后重新盘点；确实没有结账单，就选「确认没有结账单」，这条明细的日期只能用发票上的日期。`,
    confirmNone: '确认没有结账单',
  },
  screenshot: {
    title: (invoiceFileName: string) => `住宿发票「${invoiceFileName}」缺少支付截图`,
    why: (totalAmount: string | undefined) =>
      `${TRIO}这张住宿发票${amountNote('价税合计', totalAmount)}需要支付截图。可以在这里上传支付截图（JPG、PNG，可一次选多张，每张发票最多 ${PAYMENT_SCREENSHOT_CAP} 张），传完点「已传齐」；确实没有，就选「确认没有支付截图」，打印稿这一页不放支付截图。`,
    confirmNone: '确认没有支付截图',
    upload: '上传支付截图',
    // The file input's accessible name.
    inputLabel: (invoiceFileName: string) => `选择这张住宿发票的支付截图：${invoiceFileName}`,
    uploadNote: '分次付款、多种支付方式或一次付款截了几屏，都传在这里，按上传顺序排列；传齐后点「已传齐」。支付截图只进打印稿，不上传报销系统。',
    // 「已传齐」: declares the group complete; the item settles on it.
    complete: '已传齐',
    count: (count: number) => `已传 ${count} 张`,
    // A thumbnail's accessible name and its remove button's.
    thumbnail: (fileName: string, index: number) => `第 ${index} 张支付截图：${fileName}`,
    remove: (fileName: string, index: number) => `移除第 ${index} 张支付截图：${fileName}`,
    // Opens a resolved item again to add or remove screenshots (#332).
    reopen: '修改支付截图',
  },
  invoice: {
    title: (folioFileName: string) => `结账单「${folioFileName}」缺少住宿发票`,
    why: (folioTotal: string | undefined) =>
      `${TRIO}这张结账单${amountNote('消费合计', folioTotal)}没有配对到住宿发票：发票价税合计要和结账单消费合计一分不差，才算同一次住宿。没有发票就形成不了明细。请在上传页追加住宿发票后重新盘点；确实没有，就选「确认没有住宿发票」，这张结账单只作为参考材料留下。`,
    confirmNone: '确认没有住宿发票',
  },
  // 打印稿 notice for a 住宿 page whose screenshot absence was confirmed at inventory.
  printNotice: (nos: string, categoryLabel: string) => `${nos} ${categoryLabel}发票在盘点时已确认没有支付截图，这一页不放支付截图。`,
  // Refusal: a change to the group would reopen the check on a list that is already confirmed (or went to ERP).
  changeLocked: '整单明细已经确认或已开始写入报销系统，这张住宿发票的支付截图不能再增减。',
} as const;

export const PAYMENT_SCREENSHOT_ERRORS = {
  notImage: '只接受图片（JPG、PNG）。',
  notApplicable: '这张发票不需要支付截图。',
  notFound: '这张支付截图已经不存在。',
  cap: `每张发票最多 ${PAYMENT_SCREENSHOT_CAP} 张支付截图`,
  // 「已传齐」 on an empty group.
  empty: '还没有上传支付截图，传好后再点「已传齐」。',
  // 「确认没有支付截图」 while the group holds a screenshot (#332).
  noneWithScreenshots: '这张发票已经上传了支付截图，不能再确认没有。要确认没有，先删掉这些截图。',
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
  // 页眉整句，如「No.1-3 · 08-10 · 外地市内交通 · 69.19」；范围用 ASCII 连字符。页面原样显示，不自己拼。
  // 页序与 No. 都跟随统一业务序号（见 LineSchema）。
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
  // 服务端成句的提醒，如「No.9 住宿发票还没有支付截图。可以照常打印，该页下半页只放结账单。」；提醒不阻止下载。
  notices: z.array(z.string()),
});
export type PrintSheet = z.infer<typeof PrintSheetSchema>;

// ---- 项目归属 ----

// 规则照内核现有项目归属页面（project-workbench.mjs Variant B）：项目只能从允许列表里选。允许列表是个人项目簿
// 与公共项目簿（#194）的可选项目并排给出，source 标明来自哪一本；同一个项目号两本都有时只给个人那条。
// 允许列表只含可选项目（内核 selectableProjects，baox.mjs:1603）：不可选的（已过期 / 复检未通过 / 项目号不安全）不随快照给出，
// 需要时去个人项目簿查看。可选判定在服务端。
export const PROJECT_SOURCES = ['personal', 'public'] as const;
export const ProjectSourceSchema = z.enum(PROJECT_SOURCES);
export type ProjectSource = z.infer<typeof ProjectSourceSchema>;

export const ProjectOptionSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  source: ProjectSourceSchema,
  // Advisory project-book fact. It is omitted for projects without a deadline to preserve older snapshot fixtures.
  deadlineOn: DateSchema.nullable().optional(),
});
export type ProjectOption = z.infer<typeof ProjectOptionSchema>;

// 「本次已归入」区的一项（内核 project-workbench.mjs 的 used 区）：本次正在编辑的归属里用到的项目，
// 条数与金额（价税合计之和）由服务端算好给出，页面不计算。selectable 为 false 的是已经不在允许列表里的项目
// （如已从项目簿删除）：已归入的明细可以沿用，但不能再归入新的明细（页面显示「已锁定」）。
export const ProjectUsageSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  lineCount: z.number().int().positive(),
  grossTotal: AmountSchema,
  selectable: z.boolean(),
});
export type ProjectUsage = z.infer<typeof ProjectUsageSchema>;

// 项目归属在待确认项处理完之后、整单确认之前（Skill 的 project_unassigned → select-task）。
// not_started：还没进入项目归属；pending：进入了、尚未提交（可能已有上次留下的归属）；
// submitted：已提交，服务端随后自动做报销信息核对与材料准备，再进入整单确认。ERP 写入开始前都可以改派（改派使确认失效）。
export const PROJECT_ASSIGNMENT_STATUSES = ['not_started', 'pending', 'submitted'] as const;

export const ProjectLineAssignmentSchema = z.object({
  lineId: IdSchema,
  projectNumber: z.string().min(1),
  projectName: z.string().min(1),
  // 任务选择钉住的来源：个人项目簿或公共项目簿（ADR-0018）。
  projectSource: ProjectSourceSchema,
});
export type ProjectLineAssignment = z.infer<typeof ProjectLineAssignmentSchema>;

export const PROJECT_DEADLINE_WARNING_KINDS = ['after_deadline', 'stay_crosses_deadline'] as const;
export const ProjectDeadlineWarningSchema = z.object({
  lineId: IdSchema,
  lineNo: z.number().int().positive(),
  projectNumber: z.string().min(1),
  projectName: z.string().min(1),
  deadlineOn: DateSchema,
  kind: z.enum(PROJECT_DEADLINE_WARNING_KINDS),
});
export type ProjectDeadlineWarning = z.infer<typeof ProjectDeadlineWarningSchema>;

export const ProjectAssignmentSchema = z.object({
  status: z.enum(PROJECT_ASSIGNMENT_STATUSES),
  // 报销事由，至多 100 个字；未填为 null。
  purpose: z.string().nullable(),
  // 任务的常驻城市快照（与 task.homeCity 相同，创建任务时确认），这里只读显示。
  homeCity: z.string().nullable(),
  // 服务端已记下的逐条归属（上次提交或预置的）。整单确认的摘要绑定的是这一份。
  assignments: z.array(ProjectLineAssignmentSchema),
  // 本次正在编辑、尚未提交的逐条归属（按明细顺序）。「归入」动作（assign-project-lines）由服务端改它；
  // 进入项目归属与每次提交后，它等于 assignments。页面显示它，提交时把它连同事由一起送出。
  // working、usage 与 projects（项目簿变动）都是服务端状态：每次改动都换发 stepToken，另一个窗口带旧凭据提交会得到 409。
  working: z.array(ProjectLineAssignmentSchema),
  // 「本次已归入」区：working 里用到的项目，按首次出现的明细顺序，带条数与金额（服务端给出）。
  usage: z.array(ProjectUsageSchema),
  // 整单价税合计（全部明细，不只已归属的那些），由服务端加总；没有明细时为 `0.00`。
  // 归属页的吸底栏显示它。confirmation.grossTotal 不能用：它绑的是整单确认，提交归属之前一直是 null。
  grossTotal: AmountSchema,
  // 提交前项目已被停用或删除的明细（#194）：服务端已把它们从 working 里拿掉，这里列出原来归入的项目，页面提示重新选择。
  // 已提交归属里钉住的项目不在此列（沿用）。
  reselect: z.array(ProjectLineAssignmentSchema),
  // 允许列表（只含可选项目），打开页面时整份给出；搜索只缩小显示，不缩小允许列表。
  projects: z.array(ProjectOptionSchema),
  deadlineWarnings: z.array(ProjectDeadlineWarningSchema),
  submittedAt: DateTimeSchema.nullable(),
});
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

// ---- ERP 填报、回读、对账 ----

// The ERP progress copy is part of the API: the server derives each state from recorded executor facts and the mock
// reuses the same list. The paired browser extension opens one ERP tab for this reimbursement; the employee logs in
// there, then the app fills and strictly reads the form back before handing it over.
export const ERP_PROGRESS_STAGE_KEYS = ['chromium', 'login', 'catalog', 'navigate', 'import', 'receipt', 'fill', 'handover'] as const;
export const ErpProgressStageSchema = z.enum(ERP_PROGRESS_STAGE_KEYS);
export type ErpProgressStage = z.infer<typeof ErpProgressStageSchema>;

export const ERP_EXTERNAL_WAITS = ['none', 'employee_login', 'extension_connection', 'erp_response'] as const;
export const ErpExternalWaitSchema = z.enum(ERP_EXTERNAL_WAITS);
export type ErpExternalWait = z.infer<typeof ErpExternalWaitSchema>;

export const ERP_OUTCOMES = ['none', 'filled', 'saved'] as const;
export const ErpOutcomeSchema = z.enum(ERP_OUTCOMES);
export type ErpOutcome = z.infer<typeof ErpOutcomeSchema>;

// These are commands over the recorded state. `refresh` only reads the latest snapshot; it never reruns a fill job.
export const ERP_ALLOWED_ACTIONS = ['refresh', 'confirm_login', 'cancel'] as const;
export const ErpAllowedActionSchema = z.enum(ERP_ALLOWED_ACTIONS);
export type ErpAllowedAction = z.infer<typeof ErpAllowedActionSchema>;

// The hand-over step (交接单据, hand over the bill) closes 去报销: baox fills the form, runs the strict read-back and
// releases automation control. It never clicks 保存 or submits the claim (ADR-0028).
export const ERP_HANDOVER_STEP_COPY = {
  key: 'handover',
  title: '交接单据',
  description: '不点保存、不提交审批：严格回读逐行通过后，把填好的报销单交给你，由你自己点「保存」并按流程提交。',
} as const;

export const ERP_PROGRESS_STEPS = [
  { key: 'chromium', title: '打开报销系统标签页', description: '通过已配对的浏览器扩展，打开这次报销专用的报销系统标签页。' },
  { key: 'login', title: '登录', description: '在为这次报销打开的报销系统标签页里使用本人账号登录。应用不会替你输入账号或密码。' },
  { key: 'catalog', title: '报销信息核对', description: '只读核对项目与费用项目：在报销系统里存在、名称一致、已审核且未禁用。' },
  { key: 'navigate', title: '打开空白报销单', description: '打开费用报销单新增页，核对报销系统版本，确认是唯一一张空白单据。' },
  { key: 'import', title: '导入发票', description: '在发票助手里选择「不生成费用明细」，导入这次的发票。' },
  { key: 'receipt', title: '收票回读', description: '逐票回读收票单号、发票号码、不含税金额、税额与价税合计。' },
  { key: 'fill', title: '填写明细', description: '按统一业务序号逐行写入明细，每个值写入后从单元格回读。' },
  ERP_HANDOVER_STEP_COPY,
] as const;

export const ERP_EXTERNAL_WAIT_COPY: Readonly<Record<Exclude<ErpExternalWait, 'none'>, string>> = {
  employee_login: '等待你在报销系统标签页登录。',
  extension_connection: '浏览器扩展没有连接。连接恢复后，刷新状态只会读取已经记录的进度。',
  erp_response: '正在等待报销系统返回结果。',
};

export const ErpStepSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['todo', 'running', 'waiting', 'done', 'failed']),
});
export type ErpStep = z.infer<typeof ErpStepSchema>;

// 这次写入登录的报销系统账号与账套：按尝试记录、在完成页显示，从不与应用账号比对（ADR-0016）。
export const ErpAccountViewSchema = z.object({
  displayName: z.string(),
  account: z.string(),
  tenant: z.string(),
});
export type ErpAccountView = z.infer<typeof ErpAccountViewSchema>;

// idle 且 abortReason 有值：上一次去报销在写入前就停下了（报销系统没有被改动），可以直接再去报销。
export const ErpSchema = z.object({
  status: z.enum(['idle', 'running', 'waiting_login', 'aborted', 'done']),
  steps: z.array(ErpStepSchema),
  currentStage: ErpProgressStageSchema.nullable(),
  externalWait: ErpExternalWaitSchema,
  outcome: ErpOutcomeSchema,
  allowedActions: z.array(ErpAllowedActionSchema),
  draftNo: z.string().nullable(),
  abortReason: z.string().nullable(),
  loginNotice: z.string().nullable(),
  erpAccount: ErpAccountViewSchema.nullable(),
});
export type Erp = z.infer<typeof ErpSchema>;

// 回读逐行呈现的 9 个字段，名称与顺序照内核 matchTaskLines（erpreconcile.mjs）。它们是对账页给人看的那张表；
// 判定本身不再要求逐行一一对应（2026-09-20 决定：收票按身份绑定，明细看行数与整单三项金额合计）。
export const READBACK_FIELD_LABELS = ['申请报销金额', '项目', '费用项目', '开始日期', '结束日期', '费用金额', '税额', '收票单号', '发票类型'] as const;
export const ReadbackFieldLabelSchema = z.enum(READBACK_FIELD_LABELS);

export const ReadbackFieldSchema = z.object({
  label: ReadbackFieldLabelSchema,
  // 本地确认值与报销系统回读值，都是服务端给出的显示文本；读不到或没有时为 null。
  local: z.string().nullable(),
  erp: z.string().nullable(),
  // 这一项是否一致由服务端判定。
  matched: z.boolean(),
});
export type ReadbackField = z.infer<typeof ReadbackFieldSchema>;

// 一条明细的严格回读：no 是统一业务序号；fields 覆盖 9 个字段（READBACK_FIELD_LABELS 的顺序）；
// reasons 是服务端给出的这一行的原因句（照内核 matchTaskLines 的原因，报销系统不写作 ERP）。
// description 与 matched 是服务端给的行说明和整行结论（页面不自己汇总 9 个字段）。待服务端 spec 确认。
export const ReadbackRowSchema = z.object({
  no: z.number().int().positive(),
  description: z.string(),
  matched: z.boolean(),
  fields: z.array(ReadbackFieldSchema),
  reasons: z.array(z.string()),
});
export type ReadbackRow = z.infer<typeof ReadbackRowSchema>;

export const ReadbackSchema = z.object({
  status: z.enum(['none', 'matched', 'mismatched']),
  rows: z.array(ReadbackRowSchema),
  summary: z.string().nullable(),
  // 本地确认与报销系统回读的申请报销金额合计，由服务端给出；页面不求和。
  localTotal: AmountSchema.nullable(),
  erpTotal: AmountSchema.nullable(),
});
export type Readback = z.infer<typeof ReadbackSchema>;

export const RECONCILE_ACTIONS = ['原地等待', '转人工'] as const;
// 建议处置的代码：页面按代码分支，按 action（文案）显示。
// 只有两种处置（原地等待、转人工）；代码比处置多一个，因为「原地等待」下有两条出路：
// wait = 再对一次账（只读），refill = 重新去报销（重开一张单据再走一遍）。两者的处置文案都是原地等待。
export const RECONCILE_ACTION_CODES = ['wait', 'hand_off', 'refill'] as const;
export type ReconcileActionCode = (typeof RECONCILE_ACTION_CODES)[number];
export const RECONCILE_ACTION_LABELS: Readonly<Record<ReconcileActionCode, (typeof RECONCILE_ACTIONS)[number]>> = {
  wait: '原地等待',
  hand_off: '转人工',
  refill: '原地等待',
};

// 「重新去报销」这条出路的页面文案。按钮永远叫「重新去报销」，不叫「重试」：它不是把同一次写入再做一遍，
// 而是重开一张单据从头走一遍。
export const REFILL_COPY = {
  button: '重新去报销',
  consequence: '重新去报销会重开一张单据，把发票再导一次、明细再填一遍，填好后仍然由你自己保存。',
} as const;

// 对账中断点：内核 classifyReconciliation 的 6 类（erpreconcile.mjs BUCKETS），逐字照抄。
export const RECONCILE_BUCKETS = ['未知', '未保存·导入前', '未保存·已导入未写明细', '未保存·就绪待保存', '已保存', '不自洽'] as const;
export const ReconcileBucketSchema = z.enum(RECONCILE_BUCKETS);
export type ReconcileBucket = z.infer<typeof ReconcileBucketSchema>;

// human_review 的固定句（user-interaction-contract.md:64，内核 handed_off_recover）：转人工的对账结果一律显示这句。
export const HUMAN_REVIEW_NOTICE = '当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。';

// The reconcile banner while the ERP write result is unknown and no reconcile (对账) has judged the breakpoint yet.
// Shared by the server and the web mock.
export const RECONCILE_UNJUDGED_BANNER = '写入报销系统的结果不确定：应用已停止写入，不会重放。请先在报销系统里查看这张报销单，再点「开始对账」只读核对；也可以直接转人工。';

// 写入结果不确定后的对账：一律停在 reconcile 阶段。只有逐行一致才是 done（ERP 单据已交接）；
// 严格回读不一致的单据没有被证明与确认过的明细一致，所以也停在对账，由用户决定原地等待还是转人工。
// bucket 与 action / actionCode 是内核判定（bucket 与处置的对应照内核：未知、未保存·导入前、未保存·就绪待保存、
// 身份成立的已保存 ⇒ 原地等待；未保存·已导入未写明细、不自洽、身份不成立或逐行不一致的已保存 ⇒ 转人工）。
// allowedActions 是服务端允许的处置，页面只渲染这些按钮（原地等待 = 重新对账，只读；转人工 = 终止后续写入）。
// action 是建议的处置，allowedActions 是可以做的处置：建议原地等待时也一直可以转人工（两个按钮），
// 建议转人工时只能转人工（一个按钮）。
// humanReview 为真时（转人工的结果）页面显示 HUMAN_REVIEW_NOTICE，且不给「重新对账」。
// actionCode 可以是 refill（未保存·已导入未写明细、且报销系统里还没有单据编号）：建议的处置仍然是原地等待，
// 出路是「重新去报销」和「转人工」。给了这条出路就不是转人工的结果，humanReview 一定为假。
// status：pending 等待用户处置；waiting 已重新对账、原地等待；handed_off 已转人工（终态）。
// rows 是严格回读逐行比对（与 readback.rows 相同）；reasons 是不属于某一行的原因（逐行原因在 rows[].reasons）。
// 写入中止时报销系统自己的原话（逐字，来自报销系统弹窗与发票助手）和裁剪截图（服务端地址，没有时为 null）。
// 页面照原样显示，不改写、不翻译。
export const ErpCaptureSchema = z.object({
  erpText: z.array(z.string()),
  // 同源路径（对账页把它直接放进 img src），与其余地址字段同一条规则。
  screenshotUrl: UrlSchema.nullable(),
});
export type ErpCapture = z.infer<typeof ErpCaptureSchema>;

export const ReconcileSchema = z.object({
  status: z.enum(['none', 'pending', 'waiting', 'handed_off']),
  bucket: ReconcileBucketSchema.nullable(),
  action: z.enum(RECONCILE_ACTIONS).nullable(),
  actionCode: z.enum(RECONCILE_ACTION_CODES).nullable(),
  allowedActions: z.array(z.enum(RECONCILE_ACTION_CODES)),
  humanReview: z.boolean(),
  banner: z.string().nullable(),
  draftNo: z.string().nullable(),
  rows: z.array(ReadbackRowSchema),
  reasons: z.array(z.string()),
  capture: ErpCaptureSchema.nullable(),
}).refine((reconcile) => !(reconcile.humanReview && reconcile.allowedActions.includes('wait')), {
  message: 'humanReview 为真时 allowedActions 不能含 wait（转人工之后不再重新对账）',
  path: ['allowedActions'],
}).refine((reconcile) => !(reconcile.humanReview && reconcile.allowedActions.includes('refill')), {
  message: 'humanReview 为真时 allowedActions 不能含 refill（给了重新去报销这条出路，就不是转人工的结果）',
  path: ['allowedActions'],
});
export type Reconcile = z.infer<typeof ReconcileSchema>;

// The filled outcome means the form was strictly read back and handed to the employee. Saving, submission, approval,
// and payment remain facts of the ERP system, not consequences of filling the form (ADR-0028).
export const HANDOVER_COMPLETED_NOTICE =
  '报销单已经按你确认的明细填好，还没有保存或提交。请在报销系统里逐行核对，由你自己点「保存」并按流程提交。保存时如果弹出「字段必录提示」或「处理结果」，说明有字段没有真正写进报销系统：回到这里重新去报销这一项，不要手工补填。保存后回到这里再对一次账。应用只确认已填好，不代表已保存、已提交、已审批或已付款。';

export const ERP_SAVED_OUTCOME_NOTICE =
  '已从报销系统读到这张单据已保存。应用没有读到提交、审批或付款事实。';

// ---- 报销信息核对与报销材料准备 ----

// 两步都由服务端在提交项目归属后自动执行（内核 catalog_unverified → catalog_mismatch → preparation_package_pending
// → preparation_blocked，next.mjs:1175-1217）。行里的文字由服务端成句（照内核话术，遵守禁用词），页面只照列渲染。

// 处理人（RESOLVER_LABELS）见「待确认项」一节。

// 报销信息核对：只读核对项目与费用项目（编码在不在、名称对不对得上、已审核、未禁用）。
// pending 还没开始（项目归属提交前）；running 核对中；matched 通过；mismatch 有不匹配，整单确认被阻塞，
// 唯一处置是回到项目归属改派（此时当前 step 是 assign_projects），提交后服务端重新核对。
export const CATALOG_STATUSES = ['pending', 'running', 'matched', 'mismatch'] as const;

// 不匹配表的列，照内核 itemTable（next.mjs:452-458）；页面在前面按行序写序号。
export const CATALOG_MISMATCH_COLUMNS = ['序号', '材料/明细', '参考材料', '待处理问题', '处理人'] as const;

export const CatalogProblemSchema = z.object({
  // 「材料/明细」列，如「项目号 P-2307」。
  subject: z.string().min(1),
  // 「参考材料」列；内核没有时写一个破折号，这里为 null（页面留空）。
  reference: z.string().nullable(),
  // 「待处理问题」列，如「项目 P-2307「华东客户交付」在报销系统里已被禁用，不能引用」。
  reason: z.string().min(1),
  resolver: ResolverLabelSchema,
});
export type CatalogProblem = z.infer<typeof CatalogProblemSchema>;

export const CatalogSchema = z.object({
  status: z.enum(CATALOG_STATUSES),
  problems: z.array(CatalogProblemSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

// 报销材料准备：生成材料包（发票副本、参考材料、明细数据与明细文档、材料清单）并做充分性判定。
// pending 还没生成或正在生成；blocked 已生成但有缺项，整单确认不可用（当前 step 是 resolve_preparation）；ready 可以整单确认。
export const PREPARATION_STATUSES = ['pending', 'blocked', 'ready'] as const;

// 缺项表的列，照内核 preparationProblemTable（next.mjs:477-487）。
export const PREPARATION_PROBLEM_COLUMNS = ['序号', '准备缺项', '关联材料/明细', '处理人'] as const;

export const PreparationProblemSchema = z.object({
  problemId: IdSchema,
  // 「准备缺项」列。
  missing: z.string().min(1),
  // 「关联材料/明细」列：文件名、明细或字段。
  subject: z.string().min(1),
  resolver: ResolverLabelSchema,
  // 服务端判定这一项可以通过「排除这份材料」处理时给出材料 ID（页面据此显示入口）；否则为 null。
  excludableMaterialId: IdSchema.nullable(),
});
export type PreparationProblem = z.infer<typeof PreparationProblemSchema>;

// 材料包里的一份文件：包内相对路径与服务端给出的类别名（发票、参考材料、明细数据、明细文档、材料清单）。
export const PackageFileSchema = z.object({
  path: z.string().min(1),
  kindLabel: z.string().min(1),
});
export type PackageFile = z.infer<typeof PackageFileSchema>;

export const PreparationSchema = z.object({
  status: z.enum(PREPARATION_STATUSES),
  problems: z.array(PreparationProblemSchema),
  // 已生成的材料包文件清单（有缺项时也生成，供核对缺什么）；还没生成为空。
  packageFiles: z.array(PackageFileSchema),
});
export type Preparation = z.infer<typeof PreparationSchema>;

// 两步的进度与阻塞提示，照内核话术（去掉对话里的第一人称与「告诉我」，报销系统不写作 ERP）。服务端与 mock 共用。
export const CATALOG_PREPARATION_COPY = {
  catalogRunning: '正在核对报销系统中的项目和费用项目，确认它们可以用于本次报销。',
  catalogMismatch: '报销信息核对发现下列项目不匹配，整单确认暂不可用。请回到项目归属改派后重新提交，提交后会自动重新核对。',
  preparationRunning: '材料已经整理完成，正在生成本次报销的核对材料。',
  preparationBlocked: '核对材料已经生成，但还有下列事项需要补充或调整，整单确认暂不可用。处理完成后会自动重新核对。',
  packageReady: (count: number) => `核对材料已生成，共 ${count} 份文件。`,
} as const;

// ---- 当前待答 step ----

// 顺序即流程：答复待确认项 → 项目归属（assign_projects）→ 报销信息核对与材料准备（服务端自动，none）
// → 整单确认（confirm_review）→ 去打印 / 去报销（choose_action）。
// 「去报销」即开始 ERP 写入，没有单独的「开始填报」：写入进行中为 none；登录步等待时为 erp_login；停在对账时为 reconcile。
// 确认之后、写入开始之前，改派项目仍被接受（confirm_review / choose_action 下提交项目归属），并使确认失效。
export const STEP_KINDS = [
  'none',
  'upload_materials',
  'start_inventory',
  'answer_pending',
  // 内核 project_book_empty：个人项目簿没有可选项目、也还没有任何归属时，先维护项目簿（项目归属页换成维护入口）；
  // 第一次录入成功后服务端回到 assign_projects。
  'maintain_project_book',
  'assign_projects',
  // 内核 preparation_blocked：材料包有缺项，等用户处理（如排除相关材料）；处理后服务端重新准备。
  'resolve_preparation',
  'confirm_review',
  'choose_action',
  'erp_login',
  'reconcile',
  // 严格回读不一致、停在完成页：只接受「转人工」。
  'hand_off',
] as const;
export const StepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKindSchema>;

// stepToken 语义与内核 issueStep 一致：状态没变就是同一个凭据，状态一变旧凭据作废；过期回传得到 409 与最新快照。
// 没有例外：项目归属的草稿（working）、项目簿同步来的允许列表、排除材料，改了都换凭据。
export const StepSchema = z.object({
  kind: StepKindSchema,
  stepToken: StepTokenSchema,
});
export type Step = z.infer<typeof StepSchema>;

// ---- 快照 ----

// 名称与费用期间由服务端生成：创建时是占位名称、期间为 null，盘点结束后按材料日期与城市改名并给出期间。
// homeCity 是任务自己的常驻城市快照（创建时确认），之后重新确认常驻城市不影响既有任务。
export const TaskInfoSchema = z.object({
  taskId: IdSchema,
  name: z.string().min(1),
  period: TaskPeriodSchema.nullable(),
  homeCity: z.string().min(1),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

// Lodging evidence is projected with the task snapshot. Pages may choose a preview and report an actual preview
// failure, but they do not re-derive material associations or field agreement from the raw materials.
export const LODGING_EVIDENCE_STATES = ['associated', 'missing', 'unlinked'] as const;
export const LodgingEvidenceStateSchema = z.enum(LODGING_EVIDENCE_STATES);
export type LodgingEvidenceState = z.infer<typeof LodgingEvidenceStateSchema>;

export const LodgingEvidenceValueSchema = z.object({
  value: z.string().min(1),
  materialId: IdSchema,
  // Most values retain a parser source; location can be the server-recorded candidate line.
  source: z.string().min(1),
  evidence: EvidenceStateSchema,
});
export type LodgingEvidenceValue = z.infer<typeof LodgingEvidenceValueSchema>;

export const LodgingPreviewSchema = z.object({
  materialId: IdSchema,
  available: z.boolean(),
});
export type LodgingPreview = z.infer<typeof LodgingPreviewSchema>;

export const LodgingEvidenceProjectionSchema = z.object({
  materialId: IdSchema,
  defaultMaterialId: IdSchema.nullable(),
  previews: z.array(LodgingPreviewSchema),
  state: LodgingEvidenceStateSchema,
  fields: z.object({
    location: LodgingEvidenceValueSchema.nullable(),
    hotelName: LodgingEvidenceValueSchema.nullable(),
    checkIn: LodgingEvidenceValueSchema.nullable(),
    checkOut: LodgingEvidenceValueSchema.nullable(),
    amount: LodgingEvidenceValueSchema.nullable(),
  }),
});
export type LodgingEvidenceProjection = z.infer<typeof LodgingEvidenceProjectionSchema>;

export const TaskSnapshotSchema = z.object({
  // Monotonic per-task snapshot version. Clients use it to order whole snapshots received through HTTP and SSE;
  // `stepToken` remains an opaque command capability.
  revision: z.number().int().positive(),
  task: TaskInfoSchema,
  stage: TaskStageSchema,
  batches: z.array(UploadBatchSchema),
  materials: z.array(MaterialSchema),
  inventory: InventorySchema,
  events: z.array(ExpenseEventSchema),
  pendingItems: z.array(PendingItemSchema),
  // 整批停的阻塞项（跨任务重复发票）；没有为空数组。
  blockers: z.array(BlockerSchema),
  lines: z.array(LineSchema),
  lodgingEvidence: z.array(LodgingEvidenceProjectionSchema),
  confirmation: ConfirmationSchema,
  paymentScreenshots: z.array(PaymentScreenshotSchema),
  printSheet: PrintSheetSchema,
  projectAssignment: ProjectAssignmentSchema,
  catalog: CatalogSchema,
  preparation: PreparationSchema,
  erp: ErpSchema,
  readback: ReadbackSchema,
  reconcile: ReconcileSchema,
  step: StepSchema,
  // The writes the server's task policy admits right now, on this snapshot's stepToken (TASK_ACTIONS). Buttons and the
  // page gate read this list; they do not re-derive a rule from stage, step or the ERP phase.
  allowedActions: z.array(TaskActionSchema),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
