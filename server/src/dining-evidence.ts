type Invoice = { invoiceId: string; amount: string; label: string };
type Source = { receiptId: string; paidAmount: string | null; selectedInvoiceId: string | null };

type Problem =
  | { kind: 'invoice_unavailable' | 'receipt_unavailable' | 'invoice_claimed' }
  | { kind: 'amount_mismatch'; invoiceAmount: string; paidAmount: string };

export type DiningDecision =
  | { kind: 'automatic_unpaired'; receiptId: string }
  | { kind: 'automatic_paired' | 'selected_paired'; receiptId: string; invoiceId: string }
  | { kind: 'selected_failed'; receiptId: string; invoiceId: string; problem: Problem };

export function diningProblem(problem: Problem): string {
  switch (problem.kind) {
    case 'invoice_unavailable': return '所选发票已不可用，请重新选择发票或恢复按金额配对。';
    case 'receipt_unavailable': return '这份材料当前不是完整的餐饮小票，请先核对材料种类和实付金额。';
    case 'invoice_claimed': return '这张发票已被另一份餐饮小票关联或保留，请选择其他发票。';
    case 'amount_mismatch': return `发票价税合计 ${problem.invoiceAmount} 元与小票实付金额 ${problem.paidAmount} 元不一致，请对照原件核对。`;
  }
}

export function deriveDiningEvidence({ invoices, sources }: { invoices: readonly Invoice[]; sources: readonly Source[] }) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.invoiceId, invoice]));
  const sourceById = new Map(sources.map((source) => [source.receiptId, source]));
  const claims = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!source.selectedInvoiceId) continue;
    const owners = claims.get(source.selectedInvoiceId) ?? new Set<string>();
    owners.add(source.receiptId);
    claims.set(source.selectedInvoiceId, owners);
  }
  const decisions = new Map<string, DiningDecision>();
  for (const source of sources) {
    const invoiceId = source.selectedInvoiceId;
    if (!invoiceId) {
      decisions.set(source.receiptId, { kind: 'automatic_unpaired', receiptId: source.receiptId });
      continue;
    }
    const invoice = invoiceById.get(invoiceId);
    const problem: Problem | null = (claims.get(invoiceId)?.size ?? 0) > 1 ? { kind: 'invoice_claimed' }
      : !invoice ? { kind: 'invoice_unavailable' }
      : source.paidAmount === null ? { kind: 'receipt_unavailable' }
      : invoice.amount !== source.paidAmount ? { kind: 'amount_mismatch', invoiceAmount: invoice.amount, paidAmount: source.paidAmount }
      : null;
    decisions.set(source.receiptId, problem
      ? { kind: 'selected_failed', receiptId: source.receiptId, invoiceId, problem }
      : { kind: 'selected_paired', receiptId: source.receiptId, invoiceId });
  }
  const buckets = new Map<string, { invoices: string[]; receipts: string[] }>();
  const bucket = (amount: string) => {
    const found = buckets.get(amount) ?? { invoices: [], receipts: [] };
    buckets.set(amount, found);
    return found;
  };
  for (const invoice of invoices) if (!claims.has(invoice.invoiceId)) bucket(invoice.amount).invoices.push(invoice.invoiceId);
  for (const source of sources) if (!source.selectedInvoiceId && source.paidAmount !== null) bucket(source.paidAmount).receipts.push(source.receiptId);
  for (const { invoices, receipts } of buckets.values()) {
    if (invoices.length !== 1 || receipts.length !== 1) continue;
    const invoiceId = invoices[0];
    const receiptId = receipts[0];
    if (invoiceId && receiptId) decisions.set(receiptId, { kind: 'automatic_paired', receiptId, invoiceId });
  }
  const pairs = [...decisions.values()].flatMap((decision) => decision.kind === 'automatic_paired' || decision.kind === 'selected_paired' ? [{ invoiceId: decision.invoiceId, receiptId: decision.receiptId }] : []);
  const occupied = new Map(pairs.map((pair) => [pair.invoiceId, pair.receiptId]));
  const claimedByOther = (receiptId: string, invoiceId: string) => {
    const owner = occupied.get(invoiceId);
    return (owner !== undefined && owner !== receiptId) || [...(claims.get(invoiceId) ?? [])].some((id) => id !== receiptId);
  };
  return {
    decisions,
    pairs,
    invoiceChoices: (receiptId: string) => invoices.filter((invoice) => !claimedByOther(receiptId, invoice.invoiceId)),
    judgeAssignment(receiptId: string, invoiceId: string, paidAmount = sourceById.get(receiptId)?.paidAmount ?? null): string | null {
      if (invoiceId === 'auto') return null;
      const invoice = invoiceById.get(invoiceId);
      if (!invoice) return diningProblem({ kind: 'invoice_unavailable' });
      if (claimedByOther(receiptId, invoiceId)) return diningProblem({ kind: 'invoice_claimed' });
      if (paidAmount !== null && paidAmount !== invoice.amount) return diningProblem({ kind: 'amount_mismatch', invoiceAmount: invoice.amount, paidAmount });
      return null;
    },
  };
}
