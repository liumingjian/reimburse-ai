import type { TaskSnapshot } from '@baox/contract';
import type { FakeErpOptions, FakeInvoice } from '@baox/erp-executor/testing/fake-erp';
import { fakeErpOptions } from '@baox/erp-executor/testing/scenario';
import { sample } from './api';

// The receipt number (收票单号) the fake ERP gives the scene's hotel invoice.
export const SCENE_RECEIPT_NUMBER = 'SPD202609150001';

// A fake ERP that knows the default scene's task (`scenario(server).at(...)`: hotel invoice m01 on P-2307): the invoice
// by its bytes and the face amounts the task read, the project and the accommodation (住宿) expense item. For running
// the real fill or reconcile (对账) executor on the fake ERP against a scenario task. Any other scene throws: this fake
// ERP would not know its invoice or project, and the job would fail for a reason the test never set up.
//
//   fakeOptions = fakeErpFor(scene.reached, { assumeReceiptLink: true });
export function fakeErpFor(task: TaskSnapshot, overrides: Partial<FakeErpOptions> & { invoice?: Partial<FakeInvoice> } = {}): FakeErpOptions {
  const { invoice, ...options } = overrides;
  const hotel = sample('m01');
  const notDefault = (what: string) => new Error(`fakeErpFor: knows only the default scene (one line from ${hotel.name} on P-2307), but ${what}`);
  const [line, ...others] = task.lines;
  if (!line) throw notDefault('the task has no line');
  if (others.length > 0) throw notDefault(`the task has ${task.lines.length} lines`);
  const voucher = task.materials.find((material) => material.materialId === line.voucherMaterialId);
  if (!voucher) throw new Error(`fakeErpFor: no voucher material ${line.voucherMaterialId}`);
  if (voucher.fileName !== hotel.name) throw notDefault(`the line's voucher is ${voucher.fileName}`);
  if (line.projectCode !== null && line.projectCode !== 'P-2307') throw notDefault(`the line is on project ${line.projectCode}`);
  const face = Object.fromEntries(voucher.fields.map((field) => [field.key, field.value]));
  return fakeErpOptions({
    invoices: [{ bytes: new Uint8Array(hotel.bytes), invoiceNumber: face['invoiceNumber']!, receiptNumber: SCENE_RECEIPT_NUMBER, seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date, net: line.netAmount, tax: line.taxAmount, gross: line.grossAmount, category: '全电普通发票', ...invoice }],
    projects: [{ code: 'P-2307', name: '华东客户交付' }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
    ...options,
  });
}
