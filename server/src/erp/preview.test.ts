// Origin: kernel/test/erp-write-preview.test.mjs (translated to Vitest; inputs and expected outputs kept).
// `linesDigest` (kernel/src/selection.mjs) is the same function as `previewLinesDigest`.
import { describe, expect, it } from 'vitest';
import { buildErpWritePreview, previewLinesDigest as linesDigest } from './preview';
import { approvalCovers, erpWritePreviewDigest, erpWritePreviewDigest as writePreviewDigest } from './protocol';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const projectNames: Record<string, string> = {
  '39163': '中国农业发展银行河南省分行-20-2614',
  '38480': '中国农业发展银行河南省分行-20-1961',
  '37269': '中国农业发展银行河南省分行-19-3218',
};
const expenseNames: Record<string, string> = { FY010003: '长途交通', FY008001: '本地市内交通', FY010001: '住宿' };

const events = [
  { eventId: 'ev-01', voucherMaterialId: 'm-rail', kind: 'rail_eticket' },
  { eventId: 'ev-02', voucherMaterialId: 'm-ride-a', kind: 'passenger_transport' },
  { eventId: 'ev-03', voucherMaterialId: 'm-ride-b', kind: 'passenger_transport' },
  { eventId: 'ev-04', voucherMaterialId: 'm-hotel', kind: 'vat_common' },
];

const built = {
  versionId: 'v-1',
  events,
  lineItems: [
    { lineId: 'ev-01', eventId: 'ev-01', voucherMaterialId: 'm-rail', kind: 'rail_eticket',
      maskedNumber: '2642************8021', date: '2026-08-22', endDate: '2026-08-22',
      city: null, route: '合肥南 → 广州南', netAmount: null, taxAmount: null, totalAmount: '703.00',
      invoiceType: '普通发票', invoiceTypeSource: 'erp_receipt_mapping' },
    { lineId: 'ev-02', eventId: 'ev-02', voucherMaterialId: 'm-ride-a', kind: 'passenger_transport',
      maskedNumber: '2632************4156', date: '2026-08-27', endDate: '2026-08-27',
      city: '广州', route: '番禺广场地铁站D口 → 傍西酒堂', netAmount: '50.12', taxAmount: '1.51', totalAmount: '51.63',
      invoiceType: '普通发票', invoiceTypeSource: 'save_contract_transport_mapping' },
    { lineId: 'ev-03', eventId: 'ev-03', voucherMaterialId: 'm-ride-b', kind: 'passenger_transport',
      maskedNumber: '2632************3906', date: '2026-08-22', endDate: '2026-08-22',
      city: '广州', route: '时代天逸 傍西酒堂', netAmount: '18.25', taxAmount: '0.55', totalAmount: '18.80',
      invoiceType: '普通发票', invoiceTypeSource: 'erp_receipt_mapping' },
    { lineId: 'ev-04', eventId: 'ev-04', voucherMaterialId: 'm-hotel', kind: 'vat_common',
      maskedNumber: '2634************3906', date: '2026-08-09', endDate: '2026-08-22',
      city: null, route: null, netAmount: '3433.96', taxAmount: '206.04', totalAmount: '3640.00',
      invoiceType: '增值税发票', invoiceTypeSource: 'save_contract_hotel_mapping' },
  ],
};

const projects = Object.fromEntries(Object.entries(projectNames).map(([code, name]) => [code, { code, name, verdict: 'confirmed' }]));
const expenseItems = Object.fromEntries(Object.entries(expenseNames).map(([code, name]) => [code, { code, name, verdict: 'confirmed' }]));

const receiptFacts = [
  ['m-rail', '26427000000640558021', 'SPD202609040022', '703.00'],
  ['m-ride-a', '26327000001570964156', 'SPD202609020037', '51.63'],
  ['m-ride-b', '26342000002661673906', 'SPD202608220132', '18.80'],
  ['m-hotel', '26349119423005877606', 'SPD202609020039', '3640.00'],
] as const;

const receiptCheck = {
  taskId: 'task-1',
  versionId: built.versionId,
  checks: receiptFacts.map(([materialId, invoiceNumber, receiptNumber, gross]) => ({
    materialId, identityKey: `einvoice-20:${invoiceNumber}`, ok: true, rows: [[receiptNumber, '正常', '无需查验', gross]],
  })),
};

const lines = built.lineItems.map((line, index) => ({
  ...line,
  projectCode: ['39163', '38480', '38480', '37269'][index],
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  expenseItemCode: ['FY010003', 'FY008001', 'FY008001', 'FY010001'][index],
  expenseItemName: [expenseNames.FY010003, expenseNames.FY008001, expenseNames.FY008001, expenseNames.FY010001][index],
  category: ['long_distance', 'local_city_transport', 'local_city_transport', 'accommodation'][index],
}));

const task = { taskId: 'task-1', currentVersionId: built.versionId, identity, homeCity: '广州' };
const selection = {
  versionId: built.versionId, linesDigest: linesDigest(built), identity, homeCity: '广州', purpose: '客户支持',
  projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
  projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
};
const catalog = { versionId: built.versionId, linesDigest: linesDigest(built), identity, projects };

const input = () => ({ task, built, lines, selection, catalog, expenseItems, receiptCheck });

describe('ERP write preview (写入预览)', () => {
  it('builds a complete four-line preview from confirmed events, project book, ERP catalog and receipt checks', () => {
    const result = buildErpWritePreview(input());
    expect(result.ready).toBe(true);
    const preview = result.expectedPreview!;
    expect(preview.previewDigest).toBe(writePreviewDigest(preview));
    expect(preview.lines.length).toBe(4);
    expect(preview.receiptBindings.length).toBe(4);
    const rail = preview.lines[0]!;
    expect({ net: rail.netAmount, tax: rail.taxAmount, netSource: rail.netAmountSource, taxSource: rail.taxAmountSource })
      .toEqual({ net: null, tax: null, netSource: 'erp_receipt', taxSource: 'erp_receipt' });
    expect(preview.lines[3]!.endDate).toBe('2026-08-22');
    expect(preview.lines[0]!.projectName).toBe(projectNames['39163']);
    expect(preview.previewDigest).toBeTruthy();
  });

  it('refuses an unverified selection, a missing expense catalog or a missing end date', () => {
    const unverified = buildErpWritePreview({ ...input(), selection: { ...selection, projectSource: 'user_input_unverified' } });
    expect(unverified.ready).toBe(false);
    expect(unverified.problems.some((problem) => problem.code === 'project_source_not_ready')).toBe(true);

    const noExpenseCatalog = buildErpWritePreview({ ...input(), expenseItems: null, catalog: { ...catalog, expenseItems: undefined } });
    expect(noExpenseCatalog.ready).toBe(false);
    expect(noExpenseCatalog.problems.some((problem) => problem.code === 'expense_item_catalog_mismatch')).toBe(true);

    const noEndDate = buildErpWritePreview({ ...input(), lines: lines.map((line, index) => (index === 3 ? (({ endDate: _e, ...rest }) => rest)(line) : line)) });
    expect(noEndDate.ready).toBe(false);
    expect(noEndDate.problems.some((problem) => problem.code === 'end_date_missing')).toBe(true);

    const checkOutOnlyLines = lines.map((line, index) => (index === 3 ? (({ endDate: _e, ...rest }) => ({ ...rest, checkOut: '2026-08-22' }))(line) : line));
    expect(buildErpWritePreview({ ...input(), lines: checkOutOnlyLines }).ready).toBe(true);

    const noFaceTax = buildErpWritePreview({ ...input(), lines: lines.map((line, index) => (index === 1 ? { ...line, netAmount: null, taxAmount: null } : line)) });
    expect(noFaceTax.ready).toBe(false);
    expect(noFaceTax.problems.some((problem) => problem.code === 'line_net_missing')).toBe(true);
    expect(noFaceTax.problems.some((problem) => problem.code === 'line_tax_missing')).toBe(true);
  });

  it('refuses receipt bindings with a missing or duplicate identity; never pairs by amount', () => {
    const duplicate = buildErpWritePreview({ ...input(), receiptCheck: {
      ...receiptCheck, checks: receiptCheck.checks.map((check, index) => (index === 1 ? { ...check, identityKey: receiptCheck.checks[0]!.identityKey } : check)),
    } });
    expect(duplicate.ready).toBe(false);
    expect(duplicate.problems.some((problem) => problem.code === 'receipt_identity_duplicate')).toBe(true);

    const missingIdentity = buildErpWritePreview({ ...input(), receiptCheck: {
      ...receiptCheck, checks: receiptCheck.checks.map((check, index) => (index === 0 ? { ...check, identityKey: 'not-an-invoice' } : check)),
    } });
    expect(missingIdentity.ready).toBe(false);
    expect(missingIdentity.problems.some((problem) => problem.code === 'receipt_identity_invalid')).toBe(true);
  });

  it('fingerprints route, sources and receipt bindings', () => {
    const preview = buildErpWritePreview(input()).expectedPreview!;
    const changedRoute = { ...preview, lines: preview.lines.map((line, index) => (index === 0 ? { ...line, route: '错误路线' } : line)) };
    const changedBinding = { ...preview, receiptBindings: preview.receiptBindings.map((binding, index) => (index === 0 ? { ...binding, receiptNumber: 'OTHER' } : binding)) };
    expect(erpWritePreviewDigest(preview)).not.toBe(erpWritePreviewDigest(changedRoute));
    expect(erpWritePreviewDigest(preview)).not.toBe(erpWritePreviewDigest(changedBinding));
  });

  it('keeps and verifies the complete preview the user actually saw', () => {
    const preview = buildErpWritePreview(input()).expectedPreview!;
    const digest = writePreviewDigest(preview);
    expect(approvalCovers({ digest }, preview)).toBe(false);
    expect(approvalCovers({ digest, preview }, preview)).toBe(true);
    const changed = { ...preview, lines: preview.lines.map((line, index) => (index === 0 ? { ...line, projectName: '另一个完整项目名' } : line)) };
    expect(approvalCovers({ digest, preview }, changed)).toBe(false);
  });
});
