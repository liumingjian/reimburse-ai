import type { TaskSnapshot } from '@baox/contract';
import type { FakeErpOptions, FakeInvoice } from '@baox/erp-executor/testing/fake-erp';
import { fakeErpOptions } from '../erp/testing/scenario';
import { sample } from './api';

// The 收票单号 (receipt number) the fake ERP gives the scene's hotel invoice.
export const SCENE_RECEIPT_NUMBER = 'SPD202609150001';

// A fake ERP that knows the default scene's task (`scenario(server).at(...)`: hotel invoice m01 on P-2307): the invoice
// by its bytes and the face amounts the task read, the project and the 住宿 expense item. For running the real fill or
// 对账 executor on the fake ERP against a scenario task.
//
//   fakeOptions = fakeErpFor(scene.reached, { assumeReceiptLink: true });
export function fakeErpFor(task: TaskSnapshot, overrides: Partial<FakeErpOptions> & { invoice?: Partial<FakeInvoice> } = {}): FakeErpOptions {
  const { invoice, ...options } = overrides;
  const [line] = task.lines;
  if (!line) throw new Error('fakeErpFor: expected the scene task to have a line');
  const voucher = task.materials.find((material) => material.materialId === line.voucherMaterialId);
  if (!voucher) throw new Error(`fakeErpFor: no voucher material ${line.voucherMaterialId}`);
  const face = Object.fromEntries(voucher.fields.map((field) => [field.key, field.value]));
  return fakeErpOptions({
    invoices: [{ bytes: new Uint8Array(sample('m01').bytes), invoiceNumber: face['invoiceNumber']!, receiptNumber: SCENE_RECEIPT_NUMBER, seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date, net: line.netAmount, tax: line.taxAmount, gross: line.grossAmount, category: '全电普通发票', ...invoice }],
    projects: [{ code: 'P-2307', name: '华东客户交付' }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
    ...options,
  });
}
