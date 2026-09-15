// Origin: kernel/test/erp-write-readback.test.mjs (translated to Vitest; inputs and expected outputs kept).
import { describe, expect, it } from 'vitest';
import { buildReceiptReadback } from './readback';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const invoices = [
  { materialId: 'm-1', identity: { key: 'einvoice-20:12345678901234567890', number: '12345678901234567890' } },
  { materialId: 'm-2', identity: { key: 'einvoice-20:22345678901234567890', number: '22345678901234567890' } },
];

const grid = (rows: Record<string, string>[]) => ({
  ok: true as const,
  columns: [{ label: '收票单' }, { label: '发票号码' }, { label: '不含税金额' }, { label: '税额' }, { label: '价税合计' }],
  rows: rows.map((values) => ({ kind: 'data' as const, values })),
});

describe('receipt readback (收票回读)', () => {
  it('binds rows by invoice identity and keeps net, tax and gross amounts', () => {
    const result = buildReceiptReadback({
      grid: grid([
        { 收票单: 'SP-1', 发票号码: '1234************7890', 不含税金额: '100.00', 税额: '6.00', 价税合计: '106.00' },
        { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
      ]),
      invoices, taskId: 'task-1', versionId: 'v-1', identity,
    });
    expect(result.ok, result.problems.map((p) => p.message).join('; ')).toBe(true);
    expect(result.receiptCheck?.checks.map((check) => check.materialId)).toEqual(['m-1', 'm-2']);
    expect(result.receiptReadback?.rows[0]?.netAmount).toBe('100.00');
    expect(result.receiptReadback?.rows[0]?.taxAmount).toBe('6.00');
    expect(result.receiptReadback?.rows[0]?.grossAmount).toBe('106.00');
  });

  it('refuses an equal-amount row whose invoice identity does not match; never guesses by amount', () => {
    const result = buildReceiptReadback({
      grid: grid([
        { 收票单: 'SP-1', 发票号码: '32345678901234567890', 不含税金额: '100.00', 税额: '6.00', 价税合计: '106.00' },
        { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
      ]),
      invoices, taskId: 'task-1', versionId: 'v-1', identity,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.code === 'receipt_invoice_unmatched')).toBe(true);
  });

  it('refuses to proceed to the detail fill when amounts are not conserved', () => {
    const result = buildReceiptReadback({
      grid: grid([
        { 收票单: 'SP-1', 发票号码: '12345678901234567890', 不含税金额: '100.00', 税额: '6.01', 价税合计: '106.00' },
        { 收票单: 'SP-2', 发票号码: '22345678901234567890', 不含税金额: '20.00', 税额: '1.20', 价税合计: '21.20' },
      ]),
      invoices, taskId: 'task-1', versionId: 'v-1', identity,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.code === 'receipt_amount_not_conserved')).toBe(true);
  });
});
