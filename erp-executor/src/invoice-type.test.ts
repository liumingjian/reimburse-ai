// The 发票类型 (invoice type) contract: three writable values, a face-kind map, and a default that is a decision
// rather than a guess.
import { describe, expect, it } from 'vitest';
import { erpInvoiceTypeOf, ERP_INVOICE_TYPES, validInvoiceTypeSource, writableInvoiceType } from './invoice-type';

describe('ERP 发票类型', () => {
  it('writes exactly three of ERP\'s six enum values', () => {
    expect([...ERP_INVOICE_TYPES]).toEqual(['普通发票', '增值税发票', '火车票']);
    for (const other of ['机票', '其他运输票', '其他', '', '发票']) expect(writableInvoiceType(other)).toBe(false);
  });

  it('maps a face 票种 onto the enum, 铁路电子客票 onto 火车票', () => {
    expect(erpInvoiceTypeOf('增值税专用发票')).toEqual({ invoiceType: '增值税发票', invoiceTypeSource: 'face_type_to_erp_enum' });
    expect(erpInvoiceTypeOf('增值税普通发票').invoiceType).toBe('普通发票');
    expect(erpInvoiceTypeOf('火车票').invoiceType).toBe('火车票');
    expect(erpInvoiceTypeOf('铁路电子客票').invoiceType).toBe('火车票');
  });

  // The owner's decision, 2026-09-20: an undetermined face kind is 普通发票, not a stopped 去报销.
  it('defaults a face 票种 it does not know to 普通发票, and says so in the source', () => {
    for (const unknown of ['定额发票', '', null, undefined, '机票']) {
      expect(erpInvoiceTypeOf(unknown)).toEqual({ invoiceType: '普通发票', invoiceTypeSource: 'erp_enum_default' });
    }
  });

  it('accepts that default as a source, and still refuses a guess', () => {
    expect(validInvoiceTypeSource('erp_enum_default')).toBe(true);
    expect(validInvoiceTypeSource('face_type_to_erp_enum')).toBe(true);
    for (const bad of ['', '  ', 'guessed', 'inferred_from_amount', '按金额推断', 'fallback']) {
      expect(validInvoiceTypeSource(bad)).toBe(false);
    }
  });
});
