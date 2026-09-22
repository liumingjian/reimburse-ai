// The ERP 发票类型 (invoice type) enum baox writes, and how a face 票种 (face invoice kind) maps onto it.
//
// A parsed face kind and an ERP enum choice are distinct facts. Known face kinds map directly; when the face kind
// does not determine an enum value, the employee must select one of ERP's supported values before a line exists.

export const ERP_INVOICE_TYPES = ['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他'] as const;
export type ErpInvoiceType = (typeof ERP_INVOICE_TYPES)[number];

const WRITABLE = new Set<string>(ERP_INVOICE_TYPES);

export const MAPPED_INVOICE_TYPE_SOURCE = 'face_type_to_erp_enum';
export const EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE = 'employee_choice';

export type ResolvedErpInvoiceType = {
  kind: 'resolved';
  invoiceType: ErpInvoiceType;
  invoiceTypeSource: typeof MAPPED_INVOICE_TYPE_SOURCE | typeof EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE;
};

export type UnresolvedErpInvoiceType = {
  kind: 'choice_required';
  choices: readonly ErpInvoiceType[];
};

export type ErpInvoiceTypeResolution = ResolvedErpInvoiceType | UnresolvedErpInvoiceType;

// The parsed layouts use both the full face labels and the common short labels. The three confirmed mappings are
// 增值税专用发票 → 增值税发票, 增值税普通发票 → 普通发票, and 铁路电子客票 → 火车票.
export const ERP_INVOICE_TYPE_OF: Readonly<Record<string, ErpInvoiceType>> = {
  专票: '增值税发票',
  增值税专用发票: '增值税发票',
  增值税发票: '增值税发票',
  普票: '普通发票',
  增值税普通发票: '普通发票',
  普通发票: '普通发票',
  火车票: '火车票',
  铁路电子客票: '火车票',
};

/** Is this a 发票类型 baox may write? */
export const writableInvoiceType = (value: unknown): boolean => WRITABLE.has(String(value ?? '').trim());

/**
 * Resolve a parsed face 票种 to ERP's enum. A stored employee choice only applies when the face kind has no known
 * mapping; otherwise the caller receives the choice requirement instead of an ordinary-invoice default.
 */
export function erpInvoiceTypeOf(faceType: unknown, employeeChoice?: unknown): ErpInvoiceTypeResolution {
  const mapped = ERP_INVOICE_TYPE_OF[String(faceType ?? '').trim()];
  if (mapped) return { kind: 'resolved', invoiceType: mapped, invoiceTypeSource: MAPPED_INVOICE_TYPE_SOURCE };
  const selected = typeof employeeChoice === 'string' ? employeeChoice.trim() : '';
  if (writableInvoiceType(selected)) {
    return { kind: 'resolved', invoiceType: selected as ErpInvoiceType, invoiceTypeSource: EMPLOYEE_SELECTED_INVOICE_TYPE_SOURCE };
  }
  return { kind: 'choice_required', choices: ERP_INVOICE_TYPES };
}

/** Does this source name a real, confirmed origin for the ERP type? */
export function validInvoiceTypeSource(value: unknown): boolean {
  const source = typeof value === 'string' ? value.trim() : '';
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
}
