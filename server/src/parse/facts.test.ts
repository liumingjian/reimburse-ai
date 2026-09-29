import { describe, expect, it } from 'vitest';
import { factsOf } from './facts';
import type { Candidate } from './layout';

// #311: candidate precedence is decided once, in recognition; the inventory view and the private-corpus gate read it.

const FACE = 'rule:vat_invoice/einvoice';
const QR = 'rule:vat_invoice/einvoice_qr';
const DERIVED = 'rule:taxi_receipt/machine_printed.year_from_suffix';

const c = (key: string, value: string, source: string): Candidate => ({ key, value, source, parserVersion: '1', evidence: 'explicit', refs: [] });

describe('factsOf', () => {
  it('prefers the face read over the QR, wherever the QR sits in candidate order', () => {
    const facts = factsOf({ kind: 'vat_invoice', layout: 'einvoice', candidates: [c('totalAmount', '99.00', QR), c('totalAmount', '32.50', FACE)] });
    expect(facts.values).toEqual({ totalAmount: '32.50' });
    expect(facts.sources).toEqual({ totalAmount: FACE });
  });

  it('lets the QR fill what the face lacks, and skips empty values', () => {
    const facts = factsOf({ kind: 'vat_invoice', layout: 'einvoice', candidates: [c('issueDate', '', FACE), c('issueDate', '2026-08-18', QR), c('invoiceNumber', '1', FACE)] });
    expect(facts.values).toEqual({ issueDate: '2026-08-18', invoiceNumber: '1' });
    expect(facts.sources.issueDate).toBe(QR);
  });

  it('prefers the face over a derivation, and a derivation over a second source', () => {
    const facts = factsOf({
      kind: 'taxi_receipt',
      layout: 'machine_printed',
      candidates: [c('city', '上海', 'rule:taxi_receipt/other'), c('city', '北京', 'rule:taxi_receipt/machine_printed.city_from_code_region'), c('travelDate', '2026-01-02', DERIVED)],
    });
    expect(facts.values).toEqual({ city: '北京', travelDate: '2026-01-02' });
    expect(facts.sources.travelDate).toBe(DERIVED);
  });

  it('reports a key the layout reads two ways as a conflict, the face value still winning', () => {
    const facts = factsOf({ kind: 'taxi_receipt', layout: 'machine_printed', candidates: [c('travelDate', '2026-01-02', 'rule:taxi_receipt/machine_printed'), c('travelDate', '2026-01-03', DERIVED)] });
    expect(facts.values.travelDate).toBe('2026-01-02');
    expect(facts.conflicts).toEqual(['travelDate']);
  });

  it('does not count a QR disagreeing with the face as a conflict, nor a repeated identical read', () => {
    const facts = factsOf({ kind: 'vat_invoice', layout: 'einvoice', candidates: [c('totalAmount', '32.50', FACE), c('totalAmount', '32.50', FACE), c('totalAmount', '99.00', QR)] });
    expect(facts.conflicts).toEqual([]);
  });

  it('takes a manual fill (no layout) in candidate order', () => {
    const facts = factsOf({ kind: 'vat_invoice', layout: null, candidates: [c('totalAmount', '10.00', 'user'), c('invoiceNumber', '7', 'user')] });
    expect(facts).toEqual({ values: { totalAmount: '10.00', invoiceNumber: '7' }, sources: { totalAmount: 'user', invoiceNumber: 'user' }, conflicts: [] });
  });
});
