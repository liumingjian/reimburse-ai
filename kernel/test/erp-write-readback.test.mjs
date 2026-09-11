import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceiptReadback } from '../src/erp-write-readback.mjs';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const invoices = [
  { materialId: 'm-1', identity: { key: 'einvoice-20:12345678901234567890', number: '12345678901234567890' } },
  { materialId: 'm-2', identity: { key: 'einvoice-20:22345678901234567890', number: '22345678901234567890' } },
];

const grid = (rows) => ({
  ok: true,
  columns: [{ label: '收票单' }, { label: '发票号码' }, { label: '不含税金额' },
    { label: '税额' }, { label: '价税合计' }],
  rows: rows.map((values) => ({ kind: 'data', values })),
});

test('收票回读按发票身份绑定，并保留不含税金额、税额和价税合计', () => {
  const result = buildReceiptReadback({
    grid: grid([
      { 收票单: 'SP-1', 发票号码: '1234************7890', 不含税金额: '100.00', 税额: '6.00', 价税合计: '106.00' },
      { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
    ]),
    invoices, taskId: 'task-1', versionId: 'v-1', identity,
  });
  assert.equal(result.ok, true, result.problems.map((p) => p.message).join('; '));
  assert.deepEqual(result.receiptCheck.checks.map((check) => check.materialId), ['m-1', 'm-2']);
  assert.equal(result.receiptReadback.rows[0].netAmount, '100.00');
  assert.equal(result.receiptReadback.rows[0].taxAmount, '6.00');
  assert.equal(result.receiptReadback.rows[0].grossAmount, '106.00');
});

test('相同金额但发票身份不匹配时拒绝，不按金额猜', () => {
  const result = buildReceiptReadback({
    grid: grid([
      { 收票单: 'SP-1', 发票号码: '32345678901234567890', 不含税金额: '100.00', 税额: '6.00', 价税合计: '106.00' },
      { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
    ]),
    invoices, taskId: 'task-1', versionId: 'v-1', identity,
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.code === 'receipt_invoice_unmatched'));
});

test('金额不守恒时拒绝进入明细填写', () => {
  const result = buildReceiptReadback({
    grid: grid([
      { 收票单: 'SP-1', 发票号码: '12345678901234567890', 不含税金额: '100.00', 税额: '6.01', 价税合计: '106.00' },
      { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
    ]),
    invoices, taskId: 'task-1', versionId: 'v-1', identity,
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.code === 'receipt_amount_not_conserved'));
});
