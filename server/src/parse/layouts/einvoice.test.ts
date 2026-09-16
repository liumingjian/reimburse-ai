import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { compact } from '../doc';
import { dispatch } from '../dispatch';
import { parseMaterial } from '../material';
import { pdfDoc } from '../pdf';
import { einvoice, QR_SOURCE, readQr } from './einvoice';
import { LAYOUTS } from '.';

// Unit tests of the `vat_invoice/einvoice` layout on the real text layer of @baox/fixtures (the PDF adapter inline,
// no worker), with QR payloads injected into the document model.

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const AMAP_QR = '01,32,,26312000000101557402,69.19,20260813,,A1B2C3D4';

describe('vat_invoice/einvoice', () => {
  it('recognises m01 and fills every required slot', async () => {
    const outcome = await parseMaterial({ materialId: 'm01', fileName: '全季酒店_发票.pdf', mediaType: 'pdf', bytes: fixture('m01-hotel-invoice.pdf') });
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', parserVersion: einvoice.version, kindLabel: '全电发票（专票）', missing: [] });
  });

  it('keeps evidence refs to the text observations a value came from', async () => {
    const outcome = dispatch(await pdfDoc(fixture('m03-amap-invoice.pdf')), LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    const number = outcome.candidates.find((c) => c.key === 'invoiceNumber');
    expect(number?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '发票号码：26312000000101557402' }]);
  });

  // #200: anchors match joined rows, so a face split into several text runs reads like any other.
  it('recognises r01, whose 发票号码 label and digits are separate text runs', async () => {
    const doc = await pdfDoc(fixture('r01-einvoice-split-number.pdf'));
    // The fixture really splits them: no single observation carries label and digits together.
    expect(doc.observations.some((o) => /^发票号码:\d{20}$/.test(compact(o.text)))).toBe(false);

    const outcome = dispatch(doc, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（专票）', missing: [] });
    if (outcome.outcome !== 'recognised') throw new Error('expected recognised');
    const number = outcome.candidates.find((c) => c.key === 'invoiceNumber');
    expect(number?.value).toBe('26312000000098127801');
    // Evidence names every observation the row was joined from, and only real ones.
    const ids = new Set(doc.observations.map((o) => o.id));
    expect(number?.refs[0]?.observationIds.length).toBeGreaterThan(1);
    for (const id of number?.refs[0]?.observationIds ?? []) expect(ids.has(id)).toBe(true);
  });

  it('recognises r02, whose title is letter-spaced across runs', async () => {
    const doc = await pdfDoc(fixture('r02-einvoice-spaced-title.pdf'));
    expect(doc.observations.some((o) => /^电子发票\(.+\)$/.test(compact(o.text)))).toBe(false);

    const outcome = dispatch(doc, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（普票）', missing: [] });
  });

  it('recognises an invoice that bundles an unrelated fee row beside a v1 service row, and takes its totals from the 合计 row', async () => {
    const doc = await pdfDoc(fixture('r201-bundled-fee-invoice.pdf'));
    const outcome = dispatch(doc, LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', missing: [] });
    // 47.38 + 1.60 is the 合计 row over both item rows; the leading 运输服务 row alone is 41.55 + 1.25.
    expect(Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]))).toMatchObject({
      itemName: '*运输服务*客运服务费',
      netAmount: '47.38',
      taxAmount: '1.60',
      totalAmount: '48.98',
    });
    expect(outcome.findings.filter((f) => f.kind === 'validation')).toEqual([]);

    // Take the v1 service row away and nothing is left that this layout covers.
    const noV1 = { ...doc, observations: doc.observations.map((o) => (o.text.includes('运输服务') ? { ...o, text: o.text.replace('运输服务', '餐饮服务') } : o)) };
    expect(einvoice.recognise(noV1)).toBe(false);
  });

  it('does not recognise an e-invoice outside the v1 kinds (m11, 餐饮) or a document without the invoice title (m06)', async () => {
    expect(einvoice.recognise(await pdfDoc(fixture('m11-other-invoice.pdf')))).toBe(false);
    expect(einvoice.recognise(await pdfDoc(fixture('m06-caocao-itinerary.pdf')))).toBe(false);
  });

  it('reads a 全电 QR payload; anything else is not one', () => {
    expect(readQr(AMAP_QR)).toEqual({ invoiceNumber: '26312000000101557402', issueDate: '2026-08-13', totalAmount: '69.19', invoiceType: '普票' });
    expect(readQr('01,31,,26312000000098127734,3640,20260822,,X')).toMatchObject({ totalAmount: '3640.00', invoiceType: '专票' });
    expect(readQr('https://example.com/not-an-invoice')).toBeNull();
  });

  it('a QR that agrees with the face adds its candidates and a note; one that disagrees is a conflict; none is advisory', async () => {
    const doc = await pdfDoc(fixture('m03-amap-invoice.pdf'));

    const agreed = dispatch({ ...doc, codes: [AMAP_QR] }, LAYOUTS);
    if (agreed.outcome !== 'recognised') throw new Error('expected recognised');
    expect(agreed.candidates.filter((c) => c.source === QR_SOURCE).map((c) => c.key).sort()).toEqual(['invoiceNumber', 'invoiceType', 'issueDate', 'totalAmount']);
    expect(agreed.findings).toEqual([{ kind: 'advisory', code: 'qr_match', message: '二维码核对一致：发票号码、开票日期、价税合计、票种' }]);

    const tampered = dispatch({ ...doc, codes: [AMAP_QR.replace('69.19', '96.19')] }, LAYOUTS);
    if (tampered.outcome !== 'recognised') throw new Error('expected recognised');
    expect(tampered.findings).toEqual([
      { kind: 'conflict', key: 'totalAmount', values: [{ source: 'rule:vat_invoice/einvoice', value: '69.19' }, { source: QR_SOURCE, value: '96.19' }] },
    ]);

    const unreadable = dispatch(doc, LAYOUTS);
    if (unreadable.outcome !== 'recognised') throw new Error('expected recognised');
    expect(unreadable.findings).toEqual([expect.objectContaining({ kind: 'advisory', code: 'qr_unreadable' })]);
  });

  it('reports a required slot it could not read as missing instead of guessing it', async () => {
    const doc = await pdfDoc(fixture('m05-caocao-invoice.pdf'));
    const withoutGross = { ...doc, observations: doc.observations.filter((o) => o.text !== '¥38.40') };
    expect(dispatch(withoutGross, LAYOUTS)).toMatchObject({ outcome: 'recognised', missing: ['totalAmount'] });
  });

  it('flags amounts that do not conserve as a validation finding', async () => {
    const doc = await pdfDoc(fixture('m05-caocao-invoice.pdf'));
    const altered = { ...doc, observations: doc.observations.map((o) => (o.text === '¥38.40' ? { ...o, text: '¥38.41' } : o)) };
    const outcome = dispatch(altered, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', findings: expect.arrayContaining([expect.objectContaining({ kind: 'validation', code: 'total_not_conserved' })]) });
  });
});
