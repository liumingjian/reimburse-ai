// One two-invoice fill scenario shared by the executor's job tests, the server's orchestration tests and the kernel
// parity golden: a rail e-ticket (net/tax known only from the ERP receipt) and a ride-hailing invoice with a
// structured route. Amounts and numbers follow 50931a3:kernel/test/erp-draft-flow.test.mjs.
//
// Only the ERP side lives here. The server-side facts its judge turns into the approved preview (`judgeInputs`)
// stay in server/src/erp/testing/judge-inputs.ts; `approvedPreview` below is what that judge approves for them, pinned
// by server/src/erp/job.test.ts so the two cannot drift apart.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FakeErpOptions, FakeInvoice } from './fake-erp';
import {
  erpWritePreviewDigest, fieldPlanOf, PROTOCOL_VERSION,
  type ApprovedPreview, type BlobSource, type FillPlan, type FreshGate, type PreviewLine, type ReconcilePlan,
} from '../protocol';

export const ERP_ORIGIN = 'http://erp.antute.com.cn';
export const IDENTITY = { account: 'luo.liu', tenant: 'tenant-a' };
export const ERP_ACCOUNT = { displayName: '刘明建', ...IDENTITY };
export const COMPATIBILITY = { erpBuild: '8.2.830.9', formId: 'ER_ExpReimbursement' };
export const PROJECTS = [
  { code: '39163', name: '中国农业发展银行河南省分行-20-2614' },
  { code: '38480', name: '中国农业发展银行河南省分行-20-1961' },
];
export const EXPENSE_ITEMS = [
  { code: 'FY010003', name: '长途交通' },
  { code: 'FY008001', name: '本地市内交通' },
];

const bytes = (text: string) => new TextEncoder().encode(text);
export const INVOICES: Array<FakeInvoice & { materialId: string; fileName: string }> = [
  { materialId: 'm-rail', fileName: '铁路电子客票.pdf', bytes: bytes('%PDF-1.4\n% fake rail e-ticket 26427000000640558021\n%%EOF\n'),
    invoiceNumber: '26427000000640558021', receiptNumber: 'SPD202609040022', seller: '中国铁路广州局集团有限公司', issueDate: '2026-09-04',
    net: '644.95', tax: '58.05', gross: '703.00', category: '电子铁路客票' },
  { materialId: 'm-ride', fileName: '网约车发票.pdf', bytes: bytes('%PDF-1.4\n% fake ride-hailing invoice 26327000001570964156\n%%EOF\n'),
    invoiceNumber: '26327000001570964156', receiptNumber: 'SPD202609020037', seller: '苏州市吉利优行电子科技有限公司', issueDate: '2026-09-02',
    net: '50.12', tax: '1.51', gross: '51.63', category: '全电普通发票' },
];

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export const fakeErpOptions = (overrides: Partial<FakeErpOptions> = {}): FakeErpOptions => ({
  origin: ERP_ORIGIN, account: ERP_ACCOUNT, erpBuild: COMPATIBILITY.erpBuild, formId: COMPATIBILITY.formId,
  invoices: INVOICES, projects: PROJECTS, expenseItems: EXPENSE_ITEMS, ...overrides,
});

export const blobSource = (): BlobSource => {
  const bySha = new Map(INVOICES.map((invoice) => [sha(invoice.bytes), invoice.bytes]));
  return { read: async (ref) => bySha.get(ref.sha256) ?? new Uint8Array() };
};

export const fillPlan = (taskId: string, overrides: Partial<FillPlan> = {}): FillPlan => ({
  protocolVersion: PROTOCOL_VERSION, kind: 'fill', jobId: `job-${taskId}`, taskId, erpOrigin: ERP_ORIGIN,
  compatibility: COMPATIBILITY, catalog: { projects: PROJECTS, expenseItems: EXPENSE_ITEMS },
  invoices: INVOICES.map((invoice) => ({ sha256: sha(invoice.bytes), fileName: invoice.fileName, mime: 'application/pdf' })),
  purpose: '客户支持', ...overrides,
});

export const reconcilePlan = (taskId: string, overrides: Partial<ReconcilePlan> = {}): ReconcilePlan => ({
  protocolVersion: PROTOCOL_VERSION, kind: 'reconcile', jobId: `reconcile-${taskId}`, taskId, erpOrigin: ERP_ORIGIN, ...overrides,
});

/**
 * The preview the server's judge approves after this scenario's import, for `taskId`. Recorded from
 * `createDraftJudge(judgeInputs(taskId))` without its derived field plan and digest, which are recomputed here after
 * `editLine` has changed each line, as the server would have built them from different facts.
 */
export function approvedPreview(taskId: string, editLine: (line: PreviewLine) => PreviewLine = (line) => line): ApprovedPreview {
  const recorded: ApprovedPreview = JSON.parse(readFileSync(new URL('./fixtures/approved-preview.json', import.meta.url), 'utf8'));
  const { fieldPlan: _plan, previewDigest: _digest, ...rest } = recorded;
  const preview: ApprovedPreview = { ...rest, taskId, lines: rest.lines.map(editLine) };
  preview.fieldPlan = fieldPlanOf(preview);
  preview.previewDigest = erpWritePreviewDigest(preview);
  return preview;
}

/** The fresh gate the server sends with an approved preview: this task, this version, this identity. */
export const freshGateOf = (preview: ApprovedPreview): FreshGate => {
  const scope = { taskId: preview.taskId, versionId: preview.versionId, identity: preview.identity };
  return { status: 'matched', fresh: true, ...scope, scope };
};

/** Test pace: the fake ERP answers at once, so waits only need to be long enough to fail. */
export const FAST_PACE = { quietMs: 2, pollMs: 1, settleMs: 2, longMs: 2000 };

/** Rows' `y` is fake layout, not ERP content; comparisons drop it. */
export const withoutLayout = (readings: any) => {
  const grid = (g: any) => (g?.ok ? { ...g, rows: g.rows.map(({ y: _y, ...row }: any) => row) } : g);
  return { formMode: readings.formMode, billNo: readings.billNo, receiptsGrid: grid(readings.receiptsGrid), detailGrid: grid(readings.detailGrid) };
};
