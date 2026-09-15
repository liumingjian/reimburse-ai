import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { dispatch, type Recognised } from '../dispatch';
import type { ParseDoc } from '../doc';
import { KINDS } from '../kinds';
import { parseMaterial } from '../material';
import { pdfDoc } from '../pdf';
import { LAYOUTS } from '.';
import { quanji } from './quanji';

// Ported from 50931a3:kernel/test/parse.test.mjs (REFERENCES, the `hotel_folio` case: a folio is a reference material with no
// invoice identity whose stay dates are candidates) and the folio half of 50931a3:kernel/test/events.test.mjs
// ('住宿：入住日期来自结账单…'), on the real text layer of @baox/fixtures m02. The 全季 (Quanji) chain anchor is new:
// the kernel matched any 结账单.

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const folioDoc = () => pdfDoc(fixture('m02-hotel-folio.pdf'));
const SOURCE = 'rule:hotel_folio/quanji';

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));
const edit = (doc: ParseDoc, from: string, to: string | null): ParseDoc => ({
  ...doc,
  observations: doc.observations.flatMap((o) => (o.text !== from ? [o] : to === null ? [] : [{ ...o, text: to, raw: to }])),
});

describe('hotel_folio/quanji', () => {
  it('recognises m02 as a 全季 folio, a reference material with its stay dates and no invoice identity', async () => {
    const outcome = await parseMaterial({ materialId: 'm02', fileName: '全季酒店_结账单.pdf', mediaType: 'pdf', bytes: fixture('m02-hotel-folio.pdf') });
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'hotel_folio', layout: 'quanji', parserVersion: quanji.version, kindLabel: '全季酒店结账单', missing: [], findings: [] });
    if (outcome.outcome !== 'recognised') return;
    expect(KINDS.hotel_folio.role).toBe('reference');
    expect(values(outcome)).toEqual({
      hotelName: '全季酒店（上海某某店）',
      guestName: '林颂宜',
      roomNumber: '1208',
      checkIn: '2026-08-09',
      checkOut: '2026-08-22',
      nights: '13',
      roomRate: '280.00',
      folioTotal: '3640.00',
      paidAmount: '3640.00',
    });
    // Not an invoice: no invoice number, so it never takes part in 发票占用 (invoice occupancy) or duplicates.
    expect(outcome.candidates.some((c) => c.key === 'invoiceNumber')).toBe(false);
    for (const c of outcome.candidates) expect(c).toMatchObject({ source: SOURCE, evidence: 'explicit', parserVersion: quanji.version });
    expect(outcome.candidates.find((c) => c.key === 'checkIn')?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '入住日期：2026-08-09' }]);
    expect(KINDS.hotel_folio.categoryLabel(values(outcome))).toBe('住宿');
    expect(KINDS.hotel_folio.event(values(outcome))).toBeNull();
  });

  it('does not recognise the hotel invoice (m01), and the e-invoice layout does not recognise the folio', async () => {
    expect(quanji.recognise(await pdfDoc(fixture('m01-hotel-invoice.pdf')))).toBe(false);
    expect(recognised(await folioDoc()).layout).toBe('quanji');
  });

  it('leaves a folio of another chain unrecognised, for 手工补填 (manual fill)', async () => {
    const other = edit(await folioDoc(), '全季酒店(上海某某店)', '汉庭酒店(上海某某店)');
    expect(dispatch(other, LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
  });

  it('derives a missing check-out date from the check-in date and the printed night count, traceably', async () => {
    const outcome = recognised(edit(await folioDoc(), '离店日期:2026-08-22', null));
    expect(outcome.missing).toEqual([]);
    expect(outcome.candidates.find((c) => c.key === 'checkOut')).toMatchObject({ value: '2026-08-22', source: `${SOURCE}.checkout_from_nights`, evidence: 'derived' });
  });

  it('reports a check-out date it can neither read nor derive as missing', async () => {
    const doc = edit(edit(await folioDoc(), '离店日期:2026-08-22', null), '天数:13', null);
    expect(recognised(doc).missing).toEqual(['checkOut']);
  });

  it('flags dates that disagree with the night count, and charges that do not add up to the total', async () => {
    const nights = recognised(edit(await folioDoc(), '天数:13', '天数:12'));
    expect(nights.findings).toEqual([expect.objectContaining({ kind: 'validation', code: 'nights_mismatch' })]);

    const doc = await folioDoc();
    const total = recognised({ ...doc, observations: doc.observations.map((o) => (o.id === 'p1.52' ? { ...o, text: '3641.00', raw: '3641.00' } : o)) });
    expect(total.findings).toEqual([expect.objectContaining({ kind: 'validation', code: 'charges_not_conserved' })]);
  });
});
