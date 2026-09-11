import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTaskLines } from '../src/erpreconcile.mjs';

const identity = [
  ['m-rail', '26427000000640558021', 'SPD202609040022', '703.00', '644.95', '58.05'],
  ['m-ride-a', '26327000001570964156', 'SPD202609020037', '51.63', '50.12', '1.51'],
  ['m-ride-b', '26342000002661673906', 'SPD202608220132', '18.80', '18.25', '0.55'],
  ['m-hotel', '26349119423005877606', 'SPD202609020039', '3640.00', '3433.96', '206.04'],
];
const project = '中华联合财产保险股份有限公司黑龙江分公司-网络维保-20-2614';
const lines = identity.map(([materialId, invoiceNumber, receiptNumber, total, net, tax], index) => ({
  lineId: `ev-0${index + 1}`,
  eventId: `ev-0${index + 1}`,
  voucherMaterialId: materialId,
  kind: ['rail_eticket', 'passenger_transport', 'passenger_transport', 'vat_common'][index],
  category: ['long_distance', 'local_city_transport', 'local_city_transport', 'accommodation'][index],
  projectCode: ['39163', '38480', '38480', '37269'][index],
  projectName: index === 0 ? project : '天津银行股份有限公司泸州分行-2020泸州分行存储维保项目-20-1961',
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  expenseItemCode: index === 0 ? 'FY010003' : index === 3 ? 'FY010001' : 'FY008001',
  expenseItemName: index === 0 ? '长途交通' : index === 3 ? '住宿' : '本地市内交通',
  date: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-09'][index],
  endDate: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-22'][index],
  invoiceType: ['普通发票', '普通发票', '普通发票', '增值税发票'][index],
  invoiceTypeSource: 'fixture_confirmed',
  netAmount: index === 0 ? null : net,
  taxAmount: index === 0 ? null : tax,
  totalAmount: total,
  invoiceNumber,
}));

const expected = {
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  lines,
  receiptBindings: identity.map(([voucherMaterialId, invoiceNumber, receiptNumber, gross]) => ({
    voucherMaterialId,
    identityKey: `einvoice-20:${invoiceNumber}`,
    invoiceNumber,
    receiptNumber,
    grossAmount: gross,
  })),
};

const columns = (...labels) => labels.map((label) => ({ label }));
const grid = (columns_, rows) => ({ ok: true, columns: columns_, rows });
const data = (values) => ({ kind: 'data', values });

const receipts = grid(columns('序号', '收票单', '发票号码', '不含税金额', '税额', '价税合计'),
  identity.map(([materialId, invoiceNumber, receiptNumber, gross, net, tax], index) => data({
    '序号': String(index + 1),
    '收票单': receiptNumber,
    // Use the exact mask saved alongside the real receipt identity.
    '发票号码': `${invoiceNumber.slice(0, 4)}************${invoiceNumber.slice(-4)}`,
    '不含税金额': net,
    '税额': tax,
    '价税合计': gross,
    materialId,
  })));

const detailValues = (line, overrides = {}) => ({
  '申请报销金额': line.totalAmount,
  '费用金额': line.netAmount ?? (line.lineId === 'ev-01' ? '644.95' : null),
  '税额': line.taxAmount ?? (line.lineId === 'ev-01' ? '58.05' : null),
  '发票类型': line.invoiceType,
  '项目': line.projectName,
  '费用项目': line.expenseItemName,
  '开始日期': line.date,
  '结束日期': line.endDate,
  '收票单号': expected.receiptBindings.find((binding) => binding.voucherMaterialId === line.voucherMaterialId).receiptNumber,
  ...overrides,
});
const details = (rows = lines.map((line) => data(detailValues(line)))) => grid(columns(
  '序号', '项目', '费用项目', '开始日期', '结束日期', '发票类型', '费用金额', '税额', '申请报销金额', '收票单号',
), rows.map((row, index) => ({ ...row, values: { 序号: String(index + 1), ...row.values } })));

test('四行逐字段和逐票身份匹配才通过，铁路未知税额来自对应收票', () => {
  const result = matchTaskLines(details(), expected, receipts);
  assert.equal(result.ok, true, result.reasons.join('; '));
  assert.deepEqual(result.amountSources[0], { line: 1, net: 'erp_receipt', tax: 'erp_receipt' });
});

test('金额和非空字段都相同仍拒绝错误项目、日期、费用类别和税额', () => {
  const wrong = lines.map((line, index) => data(detailValues(line, index === 0
    ? { 项目: '别的项目' }
    : index === 1
      ? { 开始日期: '2026-09-09' }
      : index === 2
        ? { 费用项目: '住宿' }
        : { 税额: '206.03' })));
  const result = matchTaskLines(details(wrong), expected, receipts);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /同时匹配项目、费用项目、日期、金额和收票关联/.test(reason)));
});

test('项目名称后缀等于项目号也不算精确项目回读', () => {
  const altered = lines.map((line) => ({ ...line, projectName: project }));
  const result = matchTaskLines(details(altered.map((line) => data(detailValues(line)))), expected, receipts);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /没有一条同时匹配/.test(reason)));
});

test('同金额错误发票号或收票号不允许替代绑定', () => {
  const wrongReceipt = receipts.rows.map((row, index) => index === 0
    ? data({ ...row.values, 发票号码: '26327000001570964156' }) : row);
  const result = matchTaskLines(details(), expected, { ...receipts, rows: wrongReceipt });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /发票号与预览不一致|没有唯一对应/.test(reason)));

  const forgedMask = receipts.rows.map((row, index) => index === 0
    ? data({ ...row.values, 发票号码: '2642foo8021' }) : row);
  assert.equal(matchTaskLines(details(), expected, { ...receipts, rows: forgedMask }).ok, false);
});

test('缺结束日期、收票绑定或铁路收票净税额时保持阻塞', () => {
  const noEndDate = { ...expected, lines: lines.map((line, index) => index === 3
    ? (({ endDate, ...rest }) => rest)(line) : line) };
  assert.equal(matchTaskLines(details(), noEndDate, receipts).ok, false);

  const noBindings = { ...expected, receiptBindings: undefined };
  assert.equal(matchTaskLines(details(), noBindings, receipts).ok, false);

  const noRailNetTax = { ...receipts, rows: receipts.rows.map((row, index) => index === 0
    ? data({ ...row.values, 不含税金额: '', 税额: '' }) : row) };
  const result = matchTaskLines(details(), expected, noRailNetTax);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /对应收票没有可读值|收票不含税金额/.test(reason)));
});

test('只有明确铁路客票才允许票面净额和税额未知', () => {
  const missingFaceTax = { ...expected, lines: lines.map((line, index) => index === 1
    ? { ...line, netAmount: null, taxAmount: null } : line) };
  const result = matchTaskLines(details(), missingFaceTax, receipts);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /不是铁路客票.*缺少票面/.test(reason)));
});

test('真实样本形状：四张收票而只有三条明细时拒绝，即使全单金额相等', () => {
  const threeRows = details(lines.slice(0, 3).map((line) => data(detailValues(line))));
  const result = matchTaskLines(threeRows, expected, receipts);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /要求 4 条明细，ERP 实际为 3 条/.test(reason)));
});
