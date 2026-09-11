import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErpWritePreview, erpWritePreviewDigest } from '../src/erp-write-preview.mjs';
import { approvalCovers, writePreviewDigest } from '../src/erpwrite.mjs';
import { linesDigest } from '../src/selection.mjs';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const projectNames = {
  '39163': '中国农业发展银行河南省分行-20-2614',
  '38480': '中国农业发展银行河南省分行-20-1961',
  '37269': '中国农业发展银行河南省分行-19-3218',
};
const expenseNames = {
  FY010003: '长途交通',
  FY008001: '本地市内交通',
  FY010001: '住宿',
};

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

const projects = {
  '39163': { code: '39163', name: projectNames['39163'], verdict: 'confirmed' },
  '38480': { code: '38480', name: projectNames['38480'], verdict: 'confirmed' },
  '37269': { code: '37269', name: projectNames['37269'], verdict: 'confirmed' },
};
const expenseItems = Object.fromEntries(Object.entries(expenseNames)
  .map(([code, name]) => [code, { code, name, verdict: 'confirmed' }]));

const receiptFacts = [
  ['m-rail', '26427000000640558021', 'SPD202609040022', '703.00'],
  ['m-ride-a', '26327000001570964156', 'SPD202609020037', '51.63'],
  ['m-ride-b', '26342000002661673906', 'SPD202608220132', '18.80'],
  ['m-hotel', '26349119423005877606', 'SPD202609020039', '3640.00'],
];

const receiptCheck = {
  taskId: 'task-1',
  versionId: built.versionId,
  checks: receiptFacts.map(([materialId, invoiceNumber, receiptNumber, gross]) => ({
    materialId,
    identityKey: `einvoice-20:${invoiceNumber}`,
    ok: true,
    rows: [[receiptNumber, '正常', '无需查验', gross]],
  })),
};

const lines = built.lineItems.map((line, index) => ({
  ...line,
  projectCode: ['39163', '38480', '38480', '37269'][index],
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  expenseItemCode: ['FY010003', 'FY008001', 'FY008001', 'FY010001'][index],
  expenseItemName: [expenseNames.FY010003, expenseNames.FY008001,
    expenseNames.FY008001, expenseNames.FY010001][index],
  category: ['long_distance', 'local_city_transport', 'local_city_transport', 'accommodation'][index],
  invoiceType: line.invoiceType,
  invoiceTypeSource: line.invoiceTypeSource,
}));

const task = { taskId: 'task-1', currentVersionId: built.versionId, identity, homeCity: '广州' };
const selection = {
  versionId: built.versionId,
  linesDigest: linesDigest(built),
  identity,
  homeCity: '广州',
  purpose: '客户支持',
  projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
};
const catalog = {
  versionId: built.versionId,
  linesDigest: linesDigest(built),
  identity,
  projects,
};

const input = () => ({ task, built, lines, selection, catalog, expenseItems, receiptCheck });

test('从已确认事件、项目簿、ERP 目录和逐票收票检查生成四行完整预览', () => {
  const result = buildErpWritePreview(input());
  assert.equal(result.ready, true);
  assert.equal(result.expectedPreview.previewDigest, writePreviewDigest(result.expectedPreview));
  assert.equal(result.expectedPreview.lines.length, 4);
  assert.equal(result.expectedPreview.receiptBindings.length, 4);
  const rail = result.expectedPreview.lines[0];
  assert.deepEqual({ net: rail.netAmount, tax: rail.taxAmount,
    netSource: rail.netAmountSource, taxSource: rail.taxAmountSource },
  { net: null, tax: null, netSource: 'erp_receipt', taxSource: 'erp_receipt' });
  assert.equal(result.expectedPreview.lines[3].endDate, '2026-08-22');
  assert.equal(result.expectedPreview.lines[0].projectName, projectNames['39163']);
  assert.ok(result.expectedPreview.previewDigest);
});

test('未核验的旧选择、缺费用项目或缺结束日期都不能生成可写预览', () => {
  const unverified = buildErpWritePreview({ ...input(),
    selection: { ...selection, projectSource: 'user_input_unverified' } });
  assert.equal(unverified.ready, false);
  assert.ok(unverified.problems.some((problem) => problem.code === 'project_source_not_ready'));

  const noExpenseCatalog = buildErpWritePreview({ ...input(), expenseItems: null, catalog: {
    ...catalog, expenseItems: undefined,
  } });
  assert.equal(noExpenseCatalog.ready, false);
  assert.ok(noExpenseCatalog.problems.some((problem) => problem.code === 'expense_item_catalog_mismatch'));

  const noEndDate = buildErpWritePreview({ ...input(), lines: lines.map((line, index) => index === 3
    ? (({ endDate, ...rest }) => rest)(line) : line) });
  assert.equal(noEndDate.ready, false);
  assert.ok(noEndDate.problems.some((problem) => problem.code === 'end_date_missing'));

  const checkOutOnlyLines = lines.map((line, index) => index === 3
    ? (({ endDate, ...rest }) => ({ ...rest, checkOut: '2026-08-22' }))(line) : line);
  assert.equal(buildErpWritePreview({ ...input(), lines: checkOutOnlyLines }).ready, true);

  const noFaceTax = buildErpWritePreview({ ...input(), lines: lines.map((line, index) => index === 1
    ? { ...line, netAmount: null, taxAmount: null } : line) });
  assert.equal(noFaceTax.ready, false);
  assert.ok(noFaceTax.problems.some((problem) => problem.code === 'line_net_missing'));
  assert.ok(noFaceTax.problems.some((problem) => problem.code === 'line_tax_missing'));
});

test('收票绑定缺身份或重复身份时拒绝，不按金额配对', () => {
  const duplicate = buildErpWritePreview({ ...input(), receiptCheck: {
    ...receiptCheck,
    checks: receiptCheck.checks.map((check, index) => index === 1
      ? { ...check, identityKey: receiptCheck.checks[0].identityKey } : check),
  } });
  assert.equal(duplicate.ready, false);
  assert.ok(duplicate.problems.some((problem) => problem.code === 'receipt_identity_duplicate'));

  const missingIdentity = buildErpWritePreview({ ...input(), receiptCheck: {
    ...receiptCheck,
    checks: receiptCheck.checks.map((check, index) => index === 0
      ? { ...check, identityKey: 'not-an-invoice' } : check),
  } });
  assert.equal(missingIdentity.ready, false);
  assert.ok(missingIdentity.problems.some((problem) => problem.code === 'receipt_identity_invalid'));
});

test('完整预览指纹包含路线、来源和收票绑定', () => {
  const result = buildErpWritePreview(input());
  assert.equal(result.ready, true);
  const changedRoute = { ...result.expectedPreview,
    lines: result.expectedPreview.lines.map((line, index) => index === 0
      ? { ...line, route: '错误路线' } : line) };
  const changedBinding = { ...result.expectedPreview,
    receiptBindings: result.expectedPreview.receiptBindings.map((binding, index) => index === 0
      ? { ...binding, receiptNumber: 'OTHER' } : binding) };
  assert.notEqual(erpWritePreviewDigest(result.expectedPreview), erpWritePreviewDigest(changedRoute));
  assert.notEqual(erpWritePreviewDigest(result.expectedPreview), erpWritePreviewDigest(changedBinding));
});

test('审批必须保留并验证用户实际看到的完整预览', () => {
  const preview = buildErpWritePreview(input()).expectedPreview;
  const digest = writePreviewDigest(preview);
  assert.equal(approvalCovers({ digest }, preview), false);
  assert.equal(approvalCovers({ digest, preview }, preview), true);
  const changed = { ...preview,
    lines: preview.lines.map((line, index) => index === 0
      ? { ...line, projectName: '另一个完整项目名' } : line) };
  assert.equal(approvalCovers({ digest, preview }, changed), false);
});
