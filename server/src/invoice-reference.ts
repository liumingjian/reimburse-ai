// Amounts are canonical money strings from resolved fields. An equal amount pairs only when it identifies
// exactly one invoice and one reference; duplicate amounts stay unpaired.
export function pairInvoiceReferences<Invoice, Reference>({
  invoices,
  references,
  invoiceAmount,
  referenceAmount,
}: {
  invoices: readonly Invoice[];
  references: readonly Reference[];
  invoiceAmount: (invoice: Invoice) => string | undefined;
  referenceAmount: (reference: Reference) => string | undefined;
}): { invoice: Invoice; reference: Reference }[] {
  const pairs: { invoice: Invoice; reference: Reference }[] = [];
  for (const reference of references) {
    const amount = referenceAmount(reference);
    if (!amount) continue;
    const matches = invoices.filter((invoice) => invoiceAmount(invoice) === amount);
    const [invoice] = matches;
    if (invoice === undefined || matches.length > 1) continue;
    if (references.filter((other) => referenceAmount(other) === amount).length > 1) continue;
    pairs.push({ invoice, reference });
  }
  return pairs;
}
