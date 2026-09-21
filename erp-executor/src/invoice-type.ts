// The ERP 发票类型 (invoice type) enum baox writes, and how a face 票种 (face invoice kind) maps onto it.
//
// ERP's own enum has six entries (docs/research/erp-expense-flow/deep-dive/11-invoice-type-enum.md:
// 普通发票、增值税发票、机票、火车票、其他运输票、其他). baox writes three of them: 普通发票, 增值税发票 and
// 火车票. The other three name transport documents this product does not yet read, so nothing maps onto them.
//
// A face kind with no mapping is NOT a refusal any more. The owner decided 2026-09-20 that an undetermined face
// kind is written as 普通发票 rather than stopping the whole 去报销 — the type is a classification on the bill,
// the employee reviews it before saving, and a stopped round costs far more than a type they can change.
// That decision is recorded in the source of such a line: `erp_enum_default` says "the face named no type
// baox writes, so this is the default", and it is an ACCEPTED source, unlike a guess.

export const ERP_INVOICE_TYPES: readonly string[] = ['普通发票', '增值税发票', '火车票'];
const WRITABLE = new Set(ERP_INVOICE_TYPES);

/** What an unmapped face kind is written as, and the source that says so. */
export const ERP_INVOICE_TYPE_DEFAULT = '普通发票';
export const DEFAULTED_INVOICE_TYPE_SOURCE = 'erp_enum_default';
/** A face kind that mapped onto the enum by name carries this source instead. */
export const MAPPED_INVOICE_TYPE_SOURCE = 'face_type_to_erp_enum';

// 专票 → 增值税发票 follows the deep-dive's temporary validation, not a confirmed company mapping;
// `test:erp-live` checks it on a real draft. 铁路电子客票 maps to ERP's own 火车票 entry.
export const ERP_INVOICE_TYPE_OF: Readonly<Record<string, string>> = {
  增值税专用发票: '增值税发票',
  增值税发票: '增值税发票',
  增值税普通发票: '普通发票',
  普通发票: '普通发票',
  火车票: '火车票',
  铁路电子客票: '火车票',
};

/** Is this a 发票类型 baox may write? */
export const writableInvoiceType = (value: unknown) => WRITABLE.has(String(value ?? '').trim());

/** The ERP 发票类型 for a face 票种, and where it came from. Never fails: an unknown face kind defaults. */
export function erpInvoiceTypeOf(faceType: unknown): { invoiceType: string; invoiceTypeSource: string } {
  const mapped = ERP_INVOICE_TYPE_OF[String(faceType ?? '').trim()];
  return mapped && WRITABLE.has(mapped)
    ? { invoiceType: mapped, invoiceTypeSource: MAPPED_INVOICE_TYPE_SOURCE }
    : { invoiceType: ERP_INVOICE_TYPE_DEFAULT, invoiceTypeSource: DEFAULTED_INVOICE_TYPE_SOURCE };
}

/**
 * Does this source name a real origin for the type? A guess is still refused; the default is not a guess but a
 * recorded decision, so it is named explicitly rather than let through by the word filter.
 */
export function validInvoiceTypeSource(value: unknown): boolean {
  const source = (typeof value === 'string' ? value.trim() : '');
  if (source === DEFAULTED_INVOICE_TYPE_SOURCE) return true;
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
}
