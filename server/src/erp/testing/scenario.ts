// One two-invoice fill scenario shared by the protocol job tests and the kernel parity golden:
// a rail e-ticket (net/tax known only from the ERP receipt) and a ride-hailing invoice with a structured route.
// Amounts and numbers follow 50931a3:kernel/test/erp-draft-flow.test.mjs.

import { createHash } from 'node:crypto';
import type { FakeErpOptions, FakeInvoice } from '../executor/testing/fake-erp';
import type { DraftJudgeInputs } from '../judge';
import { previewLinesDigest } from '../preview';
import { PROTOCOL_VERSION, type BlobSource, type FillPlan, type ReconcilePlan } from '../protocol';

export const ERP_ORIGIN = 'http://erp.antute.com.cn';
export const IDENTITY = { account: 'luo.liu', tenant: 'tenant-a' };
export const ERP_ACCOUNT = { displayName: '刘明建', ...IDENTITY };
export const COMPATIBILITY = { erpBuild: '8.2.0.20250701', formId: 'ER_ExpReimbursement' };
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

/** The server-side facts the judge turns into the approved preview (kernel shapes). */
export const judgeInputs = (taskId: string): DraftJudgeInputs => {
  const events = [
    { eventId: 'ev-1', voucherMaterialId: 'm-rail', kind: 'rail_eticket' },
    { eventId: 'ev-2', voucherMaterialId: 'm-ride', kind: 'passenger_transport' },
  ];
  const built = {
    versionId: 'v-1', events,
    lineItems: [
      { lineId: 'ev-1', eventId: 'ev-1', voucherMaterialId: 'm-rail', kind: 'rail_eticket', date: '2026-08-22', city: null,
        route: '合肥南 → 广州南', netAmount: null, taxAmount: null, totalAmount: '703.00', category: 'long_distance',
        invoiceType: '普通发票', invoiceTypeSource: 'fixture_mapping' },
      { lineId: 'ev-2', eventId: 'ev-2', voucherMaterialId: 'm-ride', kind: 'passenger_transport', date: '2026-08-27', city: '广州',
        route: '番禺广场地铁站D口 → 傍西酒堂', netAmount: '50.12', taxAmount: '1.51', totalAmount: '51.63', category: 'local_city_transport',
        invoiceType: '普通发票', invoiceTypeSource: 'fixture_mapping' },
    ],
  };
  const codes = [['39163', 'FY010003', '长途交通'], ['38480', 'FY008001', '本地市内交通']] as const;
  const lines = built.lineItems.map((line, index) => ({
    ...line, projectCode: codes[index]![0], projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
    expenseItemCode: codes[index]![1], expenseItemName: codes[index]![2],
  }));
  const digest = previewLinesDigest(built);
  return {
    task: { taskId, currentVersionId: built.versionId, identity: IDENTITY, homeCity: '合肥' },
    built, lines,
    selection: {
      versionId: built.versionId, linesDigest: digest, identity: IDENTITY, homeCity: '合肥', purpose: '客户支持',
      projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
      projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
    },
    catalog: {
      versionId: built.versionId, linesDigest: digest, identity: IDENTITY,
      projects: Object.fromEntries(PROJECTS.map((p) => [p.code, { ...p, verdict: 'confirmed' }])),
    },
    expenseItems: Object.fromEntries(EXPENSE_ITEMS.map((e) => [e.code, { ...e, verdict: 'confirmed' }])),
    invoices: INVOICES.map((invoice) => ({ materialId: invoice.materialId, identity: { key: `einvoice-20:${invoice.invoiceNumber}`, number: invoice.invoiceNumber } })),
  };
};

/** Test pace: the fake ERP answers at once, so waits only need to be long enough to fail. */
export const FAST_PACE = { quietMs: 2, pollMs: 1, settleMs: 2, longMs: 2000 };

/** Rows' `y` is fake layout, not ERP content; comparisons drop it. */
export const withoutLayout = (readings: any) => {
  const grid = (g: any) => (g?.ok ? { ...g, rows: g.rows.map(({ y: _y, ...row }: any) => row) } : g);
  return { formMode: readings.formMode, billNo: readings.billNo, receiptsGrid: grid(readings.receiptsGrid), detailGrid: grid(readings.detailGrid) };
};
