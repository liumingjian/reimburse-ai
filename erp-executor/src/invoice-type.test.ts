import { describe, expect, it } from 'vitest';
import { EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE, erpInvoiceTypeOf, ERP_INVOICE_TYPES, validInvoiceTypeSource, writableInvoiceType } from './invoice-type';

describe('ERP 发票类型', () => {
  it('writes all six values in ERP\'s enum', () => {
    expect([...ERP_INVOICE_TYPES]).toEqual(['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他']);
    for (const value of ERP_INVOICE_TYPES) expect(writableInvoiceType(value)).toBe(true);
    for (const other of ['', '发票', '增值税普通发票']) expect(writableInvoiceType(other)).toBe(false);
  });

  it('maps known face kinds onto ERP enum values', () => {
    expect(erpInvoiceTypeOf('增值税专用发票')).toEqual({ kind: 'resolved', invoiceType: '增值税发票', invoiceTypeSource: 'face_type_to_erp_enum' });
    expect(erpInvoiceTypeOf('增值税普通发票')).toMatchObject({ kind: 'resolved', invoiceType: '普通发票' });
    expect(erpInvoiceTypeOf('铁路电子客票')).toMatchObject({ kind: 'resolved', invoiceType: '火车票' });
    expect(erpInvoiceTypeOf('专票')).toMatchObject({ kind: 'resolved', invoiceType: '增值税发票' });
  });

  it('requires an employee choice for an unmapped face kind', () => {
    expect(erpInvoiceTypeOf('定额发票')).toEqual({ kind: 'choice_required', choices: ERP_INVOICE_TYPES });
    expect(erpInvoiceTypeOf('', ' 其他运输票 ')).toEqual({ kind: 'resolved', invoiceType: '其他运输票', invoiceTypeSource: EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE });
  });

  it('accepts confirmed sources and refuses defaults or guesses', () => {
    expect(validInvoiceTypeSource('face_type_to_erp_enum')).toBe(true);
    expect(validInvoiceTypeSource(EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE)).toBe(true);
    for (const bad of ['', '  ', 'erp_enum_default', 'guessed', 'inferred_from_amount', '按金额推断', 'fallback']) {
      expect(validInvoiceTypeSource(bad)).toBe(false);
    }
  });
});
