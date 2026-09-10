import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeCurrentReceiptGrid } = await import('../src/recovery-flow.mjs');

const bindings = [
  { materialId: 'm-a', identity: { scheme: 'einvoice-20', number: '12345678901234567890' },
    receiptNumber: 'SPD-A', totalCents: 1000 },
  { materialId: 'm-b', identity: { scheme: 'einvoice-20', number: '98765432109876543210' },
    receiptNumber: 'SPD-B', totalCents: 2000 },
];

const grid = (rows, overrides = {}) => ({
  ok: true,
  columns: [{ label: '发票号码' }, { label: '收票单' }, { label: '价税合计' }],
  rowCount: rows.length,
  rows: rows.map((values) => ({ kind: 'data', values })),
  ...overrides,
});

test('恢复 fresh 收票回读按 receipt 身份和金额匹配，掩码中段只扩展为预期号码', () => {
  const result = normalizeCurrentReceiptGrid(grid([
    { 发票号码: '1234****7890', 收票单: 'SPD-A', 价税合计: '10.00' },
    { 发票号码: '98765432109876543210', 收票单: 'SPD-B', 价税合计: '20.00' },
  ]), bindings);

  assert.equal(result.ok, true);
  assert.deepEqual(result.grid.rows.map((row) => row.values['发票号码']), [
    '12345678901234567890', '98765432109876543210',
  ]);
});

test('恢复 fresh 收票回读拒绝同额未知收票、换票和金额漂移', () => {
  const result = normalizeCurrentReceiptGrid(grid([
    { 发票号码: '1234****7890', 收票单: 'SPD-OTHER', 价税合计: '10.00' },
    { 发票号码: '98765432109876543210', 收票单: 'SPD-B', 价税合计: '20.01' },
  ]), bindings);

  assert.equal(result.ok, false);
  assert.equal(result.grid, null);
  assert.ok(result.reasons.some((reason) => reason.includes('不在原收票查询结果')));
  assert.ok(result.reasons.some((reason) => reason.includes('价税合计')));
});
