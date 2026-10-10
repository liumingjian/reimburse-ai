import { describe, expect, it } from 'vitest';
import { deriveDiningEvidence } from './dining-evidence';

const invoices = ['i1', 'i2', 'i3'].map((invoiceId) => ({ invoiceId, amount: '240.00', label: invoiceId }));
const receipt = (receiptId: string, selectedInvoiceId: string | null = null, paidAmount: string | null = '240.00') => ({ receiptId, selectedInvoiceId, paidAmount });

describe('dining evidence intent', () => {
  it('leaves a two-by-two residual group ambiguous after one choice in a three-by-three group', () => {
    const result = deriveDiningEvidence({ invoices, sources: [receipt('r1', 'i2'), receipt('r2'), receipt('r3')] });
    expect(result.pairs).toEqual([{ receiptId: 'r1', invoiceId: 'i2' }]);
    expect(result.judgeAssignment('r2', 'i2')).toContain('另一份');
    expect(result.invoiceChoices('r2').map((invoice) => invoice.invoiceId)).toEqual(['i1', 'i3']);
    expect(deriveDiningEvidence({ invoices, sources: [receipt('r1', 'i2'), receipt('r2', 'i3'), receipt('r3')] }).pairs).toEqual([
      { receiptId: 'r1', invoiceId: 'i2' }, { receiptId: 'r2', invoiceId: 'i3' }, { receiptId: 'r3', invoiceId: 'i1' },
    ]);
  });

  it('retains conflicting claims without choosing an upload-order winner', () => {
    for (const sources of [[receipt('r1', 'i1'), receipt('r2', 'i1')], [receipt('r2', 'i1'), receipt('r1', 'i1')]]) {
      const result = deriveDiningEvidence({ invoices, sources });
      expect(result.pairs).toEqual([]);
      for (const source of sources) expect(result.decisions.get(source.receiptId)).toMatchObject({ kind: 'selected_failed', invoiceId: 'i1', problem: { kind: 'invoice_claimed' } });
    }
  });

  it.each(['239.99', null])('reserves an invalid explicit target with receipt amount %s until reset or exclusion', (paidAmount) => {
    const sources = [receipt('r1', 'i1', paidAmount), receipt('r2')];
    const result = deriveDiningEvidence({ invoices: invoices.slice(0, 1), sources });
    expect(result.pairs).toEqual([]);
    expect(result.decisions.get('r1')).toMatchObject({ kind: 'selected_failed', invoiceId: 'i1' });
    expect(result.judgeAssignment('r2', 'i1')).toContain('另一份');
    expect(result.judgeAssignment('r1', 'auto')).toBeNull();
    expect(deriveDiningEvidence({ invoices: invoices.slice(0, 1), sources: [receipt('r2')] }).pairs).toEqual([{ receiptId: 'r2', invoiceId: 'i1' }]);
  });

  it('permits replacement of an unavailable receipt target without pretending its evidence is valid', () => {
    const result = deriveDiningEvidence({ invoices, sources: [receipt('r1', 'removed', null)] });
    expect(result.decisions.get('r1')).toMatchObject({ kind: 'selected_failed', invoiceId: 'removed', problem: { kind: 'invoice_unavailable' } });
    expect(result.judgeAssignment('r1', 'i2')).toBeNull();
    expect(deriveDiningEvidence({ invoices, sources: [receipt('r1', 'i2', null)] }).decisions.get('r1')).toMatchObject({ kind: 'selected_failed', invoiceId: 'i2', problem: { kind: 'receipt_unavailable' } });
  });
});
