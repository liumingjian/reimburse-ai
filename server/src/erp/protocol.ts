// The fill-plan job protocol between the server and the separable ERP executor (ADR-0016).
//
// The server sends one plan per job; the executor answers with events. Two events wait for a server reply:
//   - `attempt_started`: the executor must not mutate ERP until the server has persisted the attempt;
//   - `readback`: the server owns judgement, so it answers each raw read-back with a verdict.
// The executor imports only this file from outside `executor/`; a lint rule enforces it.

import { createHash } from 'node:crypto';
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
});
export type FillPlan = z.infer<typeof FillPlanSchema>;

/**
 * 对账 (reconcile): the second, read-only job kind. The executor probes the login, reads the open form once and
 * sends it as a `readback` at stage `reconcile`; the server classifies it. No attempt, no ERP write, ever.
 */
export const ReconcilePlanSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  kind: z.literal('reconcile'),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  erpOrigin: z.string().url(),
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

export const STEPS = ['chromium', 'login', 'catalog', 'compatibility', 'navigate', 'import', 'fill', 'save', 'readback'] as const;

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

export const READBACK_STAGES = ['after_import', 'after_fill', 'before_save', 'after_save', 'reconcile'] as const;
export type ReadbackStage = (typeof READBACK_STAGES)[number];

export const ErrorCaptureSchema = z.object({
  // #32: verbatim ERP text from visible `.k-window` dialogs and the piaozone iframe, and a cropped screenshot.
  erpText: z.array(z.string()),
  screenshot: z.string().nullable(),
});
export type ErrorCapture = z.infer<typeof ErrorCaptureSchema>;

// `read`: a reconcile job delivered its read-back (the bucket is the server's, not the executor's).
export const RESULT_STATUSES = ['saved', 'aborted', 'unknown', 'waiting_login', 'catalog_mismatch', 'read'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const ExecutorEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: z.enum(STEPS), status: z.enum(['running', 'done', 'failed']) }),
  z.object({ type: z.literal('waiting_login'), hint: z.string() }),
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
  z.object({
    type: z.literal('result'),
    // `unknown` is ERP 写入结果未知 (write result unknown): it goes to reconcile, never to replay.
    status: z.enum(RESULT_STATUSES),
    code: z.string().nullable(),
    message: z.string().nullable(),
    billNo: z.string().nullable(),
    capture: ErrorCaptureSchema.nullable(),
  }),
]);
export type ExecutorEvent = z.infer<typeof ExecutorEventSchema>;
export type ResultEvent = Extract<ExecutorEvent, { type: 'result' }>;
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

// Origin: kernel/src/erp-write-preview.mjs previewShape / erpWritePreviewDigest. Field order and defaults are kept
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
  createHash('sha256').update(JSON.stringify(previewShape(preview))).digest('hex').slice(0, 32);

/** Whether an approval covers exactly this preview; one changed field voids it. Origin: kernel/src/erpwrite.mjs. */
export const approvalCovers = (approval: { digest?: string; preview?: unknown } | null | undefined, preview: unknown): boolean =>
  !!approval && !!approval.preview
  && approval.digest === erpWritePreviewDigest(preview)
  && approval.digest === erpWritePreviewDigest(approval.preview);
