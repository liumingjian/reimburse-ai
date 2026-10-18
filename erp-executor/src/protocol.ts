// The fill-plan job protocol between the server and the separable ERP executor (ADR-0016).
//
// The server sends one plan per job; the executor answers with events. Two events wait for a server reply:
//   - `attempt_started`: the executor must not mutate ERP until the server has persisted the attempt;
//   - `readback`: the server owns judgement, so it answers each raw read-back with a verdict.
// This file and the executor ship together in @baox/erp-executor, so a second consumer — the 浏览器扩展 (browser
// extension) — speaks the protocol without importing the server. A lint rule keeps the package off the server.

import { sha256Hex } from './sha256';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** Invoices travel by content: sha256 + filename + MIME, read through a `BlobSource` port. */
export const BlobRefSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1),
  mime: z.string().min(1),
});
export type BlobRef = z.infer<typeof BlobRefSchema>;

/** Compatibility fingerprint: the ERP build and the form id. A mismatch aborts before any mutation. */
export const CompatibilitySchema = z.object({ erpBuild: z.string().min(1), formId: z.string().min(1) });
export type Compatibility = z.infer<typeof CompatibilitySchema>;

/**
 * baox's ownership marker (归属标记, ADR-0029): `baox-` and ten random lower-case letters and digits, one per job. It
 * names a job, nobody types it, and it is plain enough to survive 事由 verbatim and to sit in a query's LIKE without
 * escaping.
 */
export const DRAFT_MARK = /^baox-[a-z0-9]{10}$/;
// An invoice number as it goes into a query filter: digits only (全电发票 20, 增值税发票 8 to 12).
export const INVOICE_NO = /^\d{8,20}$/;
/** 事由 as a 暂存 fill writes it. */
export const markedPurpose = (purpose: string, mark: string) => `${purpose} ${mark}`;

/** One filled grid row of a form as a read-back saw it: column label to cell text. */
export const DraftRowSchema = z.object({ values: z.record(z.string(), z.string()) });
export type DraftRow = z.infer<typeof DraftRowSchema>;
/** A read-back grid's filled data rows: what a 暂存 draft's View is compared with, by the fill and by 对账. */
export const filledRows = (grid: { ok: boolean; rows?: ReadonlyArray<{ kind: string; values?: Record<string, string> }> } | null | undefined): DraftRow[] =>
  (grid?.ok === true && Array.isArray(grid.rows) ? grid.rows : [])
    .filter((row) => row.kind === 'data').map((row) => ({ values: { ...(row.values ?? {}) } }))
    .filter((row) => Object.values(row.values).some((v) => String(v ?? '').trim() !== ''));

const CatalogEntrySchema = z.object({ code: z.string().min(1), name: z.string().min(1) });

export const FillPlanSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('fill'),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  erpOrigin: z.string().url(),
  compatibility: CompatibilitySchema,
  // 报销信息核对 (catalog check): every project and expense item the lines use, with the expected ERP name.
  catalog: z.object({ projects: z.array(CatalogEntrySchema), expenseItems: z.array(CatalogEntrySchema) }),
  invoices: z.array(BlobRefSchema).min(1),
  purpose: z.string().min(1),
  // Set by 重新去报销 (ADR-0027) and by nothing else: close any 费用报销单-新增 tab still open before opening the
  // fresh one. 对账 offers that recovery only over a 新增 with no 单据编号, or over no form at all, so the tab it
  // closes is the unsaved bill the banner already told the employee would be replaced.
  replaceAbandonedForm: z.boolean().optional(),
  // 暂存 (ADR-0029, ADR-0037): every fill ends at a draft. The fill writes 事由 as the purpose followed by a space
  // and `mark`, presses 暂存, and finds the draft again by that mark: a 暂存 draft has no 单据编号.
  draft: z.object({ mark: z.string().regex(DRAFT_MARK) }),
  // 自动重新去报销 (ADR-0034): set by the server on a re-run it starts by itself, and on nothing else. Before anything
  // is uploaded the executor asks ERP, read-only, whether a 费用报销单 already holds one of these invoices and whether a
  // draft carries one of the earlier jobs' marks; either, or no answer, ends the run with nothing written.
  rerun: z.object({
    invoiceNos: z.array(z.string().regex(INVOICE_NO)).min(1),
    marks: z.array(z.string().regex(DRAFT_MARK)).min(1),
  }).optional(),
});
export type FillPlan = z.infer<typeof FillPlanSchema>;

/**
 * 对账 (reconcile): the second, read-only job kind. The executor probes the login, reads the open form once and
 * sends it as a `readback` at stage `reconcile`; the server classifies it. With `draft` it reads no form and looks
 * the 暂存 draft up by its marker instead (`draft_lookup`). No attempt, no ERP write, ever.
 */
export const ReconcilePlanSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('reconcile'),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  erpOrigin: z.string().url(),
  // 对账 after 暂存 was pressed (erp-headless-v1.md line 2 item 5): the page is gone with the job's browser, so the
  // draft is looked up by its ownership marker through WebAPI instead (ExecuteBillQuery, View: read-only) and the
  // open form is not read. `mark` is the 暂存 job's; `earlier` the task's other jobs', none of which may have a draft.
  // `expected` is what the strict hand-over read-back saw before 暂存, as the fill compares its own draft; null when
  // the server holds no such read-back, and then nothing is compared and nothing can be proved.
  draft: z.object({
    mark: z.string().regex(DRAFT_MARK),
    earlier: z.array(z.string().regex(DRAFT_MARK)),
    expected: z.object({ causa: z.string().min(1), receipts: z.array(DraftRowSchema), details: z.array(DraftRowSchema) }).nullable(),
  }).optional(),
});
export type ReconcilePlan = z.infer<typeof ReconcilePlanSchema>;

export const ErpAccountSchema = z.object({ displayName: z.string(), account: z.string(), tenant: z.string() });
/** The ERP account and 账套 (account set) that were logged in. Recorded on the attempt, never compared. */
export type ErpAccount = z.infer<typeof ErpAccountSchema>;

export const MUTATIONS = ['import', 'fill', 'save'] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** What the executor observed right before a mutation; re-checked again after the server's acknowledgement. */
export const PreconditionsSchema = z.object({
  targetId: z.string(),
  url: z.string(),
  formInstanceId: z.string(),
  formMode: z.enum(['new', 'modify']),
  billNo: z.string().nullable(),
  receiptRowCount: z.number().int(),
  detailRowCount: z.number().int(),
});
export type Preconditions = z.infer<typeof PreconditionsSchema>;

// `save` is 暂存 (ADR-0029), and a 保存 in job events recorded before ADR-0028; `draft_check` (核对暂存单) is the
// lookup and read-back of the draft 暂存 left. `handover` is the strict read-back the form passes before 暂存.
export const STEPS = ['chromium', 'login', 'catalog', 'compatibility', 'navigate', 'import', 'fill', 'save', 'handover', 'readback', 'draft_check'] as const;
export type Step = (typeof STEPS)[number];

/**
 * 去报销进度 (#420): how far a step with countable parts is, on its `step` event. Today only 填写明细 sends it: `total`
 * 明细 rows with its start (`done: 0`), then one event per row written. An executor or 浏览器扩展 from before it sends
 * none; the server then counts the step once. Optional on purpose: a new event type would be refused (`bad_event`).
 */
export const StepProgressSchema = z.object({ done: z.number().int().min(0), total: z.number().int().min(1) })
  .refine((progress) => progress.done <= progress.total);
export type StepProgress = z.infer<typeof StepProgressSchema>;

const GridSchema = z.union([
  z.object({ ok: z.literal(true), columns: z.array(z.object({ label: z.string() }).passthrough()), rows: z.array(z.object({ kind: z.enum(['data', 'total']), values: z.record(z.string(), z.string()) }).passthrough()) }).passthrough(),
  z.object({ ok: z.literal(false), reason: z.string() }).passthrough(),
]);

/** Raw read-back of the form: the executor only observes; comparison happens in the server. */
export const ReadingsSchema = z.object({
  formMode: z.object({ readable: z.boolean(), value: z.enum(['new', 'modify']).nullable() }).passthrough(),
  billNo: z.object({ readable: z.boolean(), value: z.string().nullable() }).passthrough(),
  receiptsGrid: GridSchema,
  detailGrid: GridSchema,
});
export type Readings = z.infer<typeof ReadingsSchema>;

// The moments a fill job reads the form back. `before_hand_over` is the strict read the hand-over gate makes before
// 暂存 (the name is from ADR-0028, when the filled, unsaved form itself was handed over); the draft 暂存 leaves is
// read back by its 内码 instead (`draft_check`), and baox never saves.
export const READBACK_STAGES = ['after_import', 'after_fill', 'before_hand_over', 'reconcile'] as const;
export type ReadbackStage = (typeof READBACK_STAGES)[number];

export const ErrorCaptureSchema = z.object({
  // #32: verbatim ERP text from visible `.k-window` dialogs and the piaozone iframe, and a cropped screenshot.
  erpText: z.array(z.string()),
  screenshot: z.string().nullable(),
});
export type ErrorCapture = z.infer<typeof ErrorCaptureSchema>;

// `drafted`: ERP 草稿已交接 — a fill job's only success (ADR-0029, ADR-0037): the filled form was 暂存'd, found again
// by its ownership marker and read back by its 内码 (`draftId`); it has no 单据编号 until the employee saves it.
// `saved`: no longer produced by a fill job, but still a valid stored value — legacy imported tasks really did save,
// and a 对账 (reconcile) that proves 已保存 synthesises one.
// `read`: a reconcile job delivered its read-back (the bucket is the server's, not the executor's).
export const RESULT_STATUSES = ['saved', 'drafted', 'aborted', 'unknown', 'catalog_mismatch', 'read'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ExecutorEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: z.enum(STEPS), status: z.enum(['running', 'done', 'failed']), progress: StepProgressSchema.optional() }),
  z.object({
    type: z.literal('catalog_mismatch'),
    problems: z.array(z.object({ kind: z.enum(['project', 'expense_item']), code: z.string(), verdict: z.string(), expectedName: z.string(), erpName: z.string().nullable() })),
  }),
  z.object({
    type: z.literal('attempt_started'),
    attemptId: z.string(),
    action: z.enum(MUTATIONS),
    preconditions: PreconditionsSchema,
    expectedPostconditions: z.record(z.string(), z.unknown()),
    compatibility: CompatibilitySchema,
    erpAccount: ErpAccountSchema,
  }),
  z.object({
    type: z.literal('readback'), stage: z.enum(READBACK_STAGES), readings: ReadingsSchema,
    // Which form was read (reconcile only): the server compares it with the fill's last attempt.
    form: z.object({ formInstanceId: z.string().nullable(), targetId: z.string().nullable() }).optional(),
  }),
  // A 对账 by ownership marker (ReconcilePlan.draft): every draft found under each mark, and for the one draft under
  // the job's own mark, if it was the only draft found, the problems between its View and the expected read-back
  // (empty: they agree; null: not compared). `failure`: a query or the View did not answer; nothing is judged on it.
  z.object({
    type: z.literal('draft_lookup'),
    drafts: z.array(z.object({ mark: z.string(), id: z.string(), billNo: z.string().nullable(), status: z.string() })),
    problems: z.array(z.string()).nullable(),
    failure: z.string().nullable(),
  }),
  z.object({
    type: z.literal('result'),
    // `unknown` is ERP 写入结果未知 (write result unknown): it goes to reconcile, never to replay.
    status: z.enum(RESULT_STATUSES),
    code: z.string().nullable(),
    message: z.string().nullable(),
    billNo: z.string().nullable(),
    capture: ErrorCaptureSchema.nullable(),
    // The 暂存 draft's 内码 (FID), on `drafted` and on an `unknown` after 暂存 that found it.
    draftId: z.string().nullable().optional(),
  }),
]);
export type ExecutorEvent = z.infer<typeof ExecutorEventSchema>;
export type ResultEvent = Extract<ExecutorEvent, { type: 'result' }>;
/**
 * A job ended as `aborted` by whoever could not let it go on: the server past its reconnection window, or the
 * extension's job link. It never picks the disposition — the server turns it into `unknown` (对账) when an attempt is
 * on record.
 */
export const abortedResult = (code: string, message: string): ResultEvent => ({ type: 'result', status: 'aborted', code, message, billNo: null, capture: null });
export type AttemptStartedEvent = Extract<ExecutorEvent, { type: 'attempt_started' }>;
export type ReadbackEvent = Extract<ExecutorEvent, { type: 'readback' }>;

/** The server's answer to `attempt_started`: sent only after the attempt row is durable. */
export type AttemptAck = { persisted: true };

/** The server's answer to `readback`. After import it hands over the approved preview the fill must realise. */
export type ReadbackVerdict =
  | { ok: true; preview?: ApprovedPreview; approval?: Approval; freshGate?: FreshGate }
  | { ok: false; reasons: string[] };

/**
 * The executor's only channel. `emit` resolves with the server's reply: an AttemptAck for `attempt_started`,
 * a ReadbackVerdict for `readback`, nothing for the rest.
 */
export interface ExecutorChannel {
  emit(event: Extract<ExecutorEvent, { type: 'attempt_started' }>): Promise<AttemptAck>;
  emit(event: Extract<ExecutorEvent, { type: 'readback' }>): Promise<ReadbackVerdict>;
  emit(event: Exclude<ExecutorEvent, { type: 'attempt_started' } | { type: 'readback' }>): Promise<void>;
}

/** Invoice bytes by content. */
export interface BlobSource {
  read(ref: BlobRef): Promise<Uint8Array>;
}

// ---- The approved preview: the exact field plan the fill realises, shared by server and executor ----

export type Identity = { account: string; tenant: string };
export type RoutePlan = { origin: string; destination: string; source: string };
export type PreviewLine = {
  lineId: string; eventId: string | null; voucherMaterialId: string; kind: string | null;
  date: string; endDate: string | null; checkOut?: string | null; endDateSource?: string | null;
  city: string | null; route?: string | null; origin?: string | null; destination?: string | null; routeSource?: string | null;
  routePlan?: RoutePlan | null;
  netAmount: string | null; taxAmount: string | null; totalAmount: string;
  netAmountSource?: string | null; taxAmountSource?: string | null;
  projectCode: string; projectName: string | null; expenseItemCode: string; expenseItemName: string;
  invoiceType: string | null; invoiceTypeSource: string | null; projectSource?: string | null; projectsFrom?: string | null;
  [extra: string]: unknown;
};
export type ReceiptBinding = {
  voucherMaterialId: string; identityKey: string; invoiceNumber: string; receiptNumber: string; grossAmount: string | null;
  netAmount?: string | null; taxAmount?: string | null; netAmountSource?: string | null; taxAmountSource?: string | null;
};
export type FieldPlanField = { column: string; value?: string | null; option?: string | null; readback: string | null; source: string | null | undefined };
export type FieldPlan = {
  header: Array<{ key: string; value: string; source: string }>;
  order: string[];
  details: Array<{ lineId: string; row: number; voucherMaterialId: string; fields: FieldPlanField[] }>;
};
export type ApprovedPreview = {
  taskId: string; identity: Identity; versionId: string; homeCity: string; purpose: string;
  projectSource: string; projectsFrom: string; lines: PreviewLine[]; receiptBindings: ReceiptBinding[];
  fieldPlan?: FieldPlan; previewDigest?: string;
};
export type Approval = { digest: string; preview: ApprovedPreview };
export type FreshGate = {
  status: string; fresh: boolean; taskId: string; versionId: string; identity: Identity;
  scope: { taskId: string; versionId: string; identity: Identity };
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const erpDate = (value: unknown) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value) ?? '');
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : null;
};

/** The ordered field plan (header purpose, then per line) the fill writes and reads back. */
export const fieldPlanOf = (preview: Pick<ApprovedPreview, 'purpose' | 'lines'>): FieldPlan => ({
  header: [{ key: 'FCAUSA', value: preview.purpose, source: 'selection.purpose' }],
  order: ['项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额'],
  details: preview.lines.map((line, row) => {
    const fields: FieldPlanField[] = [
      { column: '项目', value: line.projectCode, readback: line.projectName, source: 'erp_catalog_confirmed' },
      { column: '费用项目', value: line.expenseItemCode, readback: line.expenseItemName, source: 'erp_catalog_confirmed' },
      { column: '发票类型', option: line.invoiceType, readback: line.invoiceType, source: line.invoiceTypeSource },
      { column: '开始日期', value: erpDate(line.date), readback: erpDate(line.date), source: 'line.date' },
      { column: '结束日期', value: erpDate(line.endDate), readback: erpDate(line.endDate), source: line.endDateSource },
    ];
    if (text(line.city)) fields.push({ column: '住宿/出差地', value: line.city, readback: line.city, source: 'line.city' });
    if (line.routePlan) {
      fields.push({ column: '出发地', value: line.routePlan.origin, readback: line.routePlan.origin, source: line.routePlan.source });
      fields.push({ column: '目的地', value: line.routePlan.destination, readback: line.routePlan.destination, source: line.routePlan.source });
    }
    fields.push(
      { column: '费用金额', value: line.netAmount, readback: line.netAmount, source: line.netAmountSource },
      { column: '税额', value: line.taxAmount, readback: line.taxAmount, source: line.taxAmountSource },
    );
    return { lineId: line.lineId, row, voucherMaterialId: line.voucherMaterialId, fields };
  }),
});

// Origin: 50931a3:kernel/src/erp-write-preview.mjs previewShape / erpWritePreviewDigest. Field order and defaults are kept
// byte-for-byte so a digest computed here equals the kernel's for the same preview.
const previewShape = (preview: any) => ({
  taskId: preview?.taskId ?? null,
  identity: preview?.identity ?? null,
  versionId: preview?.versionId ?? null,
  homeCity: preview?.homeCity ?? null,
  purpose: preview?.purpose ?? null,
  projectSource: preview?.projectSource ?? null,
  projectsFrom: preview?.projectsFrom ?? null,
  lines: (preview?.lines ?? []).map((line: any) => ({
    lineId: line.lineId ?? null,
    eventId: line.eventId ?? null,
    voucherMaterialId: line.voucherMaterialId ?? null,
    maskedNumber: line.maskedNumber ?? null,
    invoiceNumber: line.invoiceNumber ?? null,
    kind: line.kind ?? null,
    date: line.date ?? null,
    endDate: line.endDate ?? null,
    checkOut: line.checkOut ?? null,
    endDateSource: line.endDateSource ?? null,
    city: line.city ?? null,
    route: line.route ?? null,
    origin: line.origin ?? null,
    destination: line.destination ?? null,
    routeSource: line.routeSource ?? null,
    routePlan: line.routePlan ?? null,
    netAmount: line.netAmount ?? null,
    taxAmount: line.taxAmount ?? null,
    totalAmount: line.totalAmount ?? null,
    netAmountSource: line.netAmountSource ?? null,
    taxAmountSource: line.taxAmountSource ?? null,
    amountSource: line.amountSource ?? null,
    referenceMaterialIds: line.referenceMaterialIds ?? [],
    category: line.category ?? null,
    categoryLabel: line.categoryLabel ?? null,
    categoryBasis: line.categoryBasis ?? null,
    categoryNote: line.categoryNote ?? null,
    expenseItemCode: line.expenseItemCode ?? null,
    expenseItemName: line.expenseItemName ?? null,
    expenseItemSource: line.expenseItemSource ?? null,
    projectCode: line.projectCode ?? null,
    projectName: line.projectName ?? null,
    project: line.project ?? null,
    projectSource: line.projectSource ?? null,
    projectsFrom: line.projectsFrom ?? null,
    invoiceType: line.invoiceType ?? null,
    invoiceTypeLabel: line.invoiceTypeLabel ?? null,
    invoiceTypeSource: line.invoiceTypeSource ?? null,
  })),
  receiptBindings: (preview?.receiptBindings ?? []).map((binding: any) => ({
    voucherMaterialId: binding.voucherMaterialId ?? null,
    identityKey: binding.identityKey ?? null,
    invoiceNumber: binding.invoiceNumber ?? null,
    receiptNumber: binding.receiptNumber ?? null,
    grossAmount: binding.grossAmount ?? null,
    netAmount: binding.netAmount ?? null,
    taxAmount: binding.taxAmount ?? null,
    netAmountSource: binding.netAmountSource ?? null,
    taxAmountSource: binding.taxAmountSource ?? null,
  })),
  fieldPlan: preview?.fieldPlan ?? null,
});

/** Stable fingerprint of the complete expected write/readback contract. */
export const erpWritePreviewDigest = (preview: unknown): string =>
  sha256Hex(JSON.stringify(previewShape(preview))).slice(0, 32);

/** Whether an approval covers exactly this preview; one changed field voids it. Origin: 50931a3:kernel/src/erpwrite.mjs. */
export const approvalCovers = (approval: { digest?: string; preview?: unknown } | null | undefined, preview: unknown): boolean =>
  !!approval && !!approval.preview
  && approval.digest === erpWritePreviewDigest(preview)
  && approval.digest === erpWritePreviewDigest(approval.preview);
