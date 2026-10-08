import { describe, expect, it, vi } from 'vitest';
import { KINDS } from '../../kind-policy';
import { dispatch, type ParseOutcome, type Recognised } from '../dispatch';
import type { ParseDoc } from '../doc';
import { caseDoc } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';
import { diningReceipt } from './dining-receipt';
import { labelled } from './labelled';

// `dining_receipt/labelled` (#360) on the real text layers of @baox/fixtures m13 (结账单（顾客联）, 合计 and 实收) and m14
// (消费清单, discounted), read from their snapshot cases, which also score every value: no pdfjs, no OCR. Recognition
// takes a receipt-style title, a paid or total amount and no hotel stay label; the paid amount is never worked out.

vi.mock('unpdf', () => {
  throw new Error('a layout test loaded pdfjs: read the document from a snapshot case');
});
vi.mock('../ocr', () => {
  throw new Error('a layout test loaded OCR: read the document from a snapshot case');
});

const slip = () => caseDoc('fixture-m13-dining-receipt');
const discounted = () => caseDoc('fixture-m14-dining-receipt-discounted');

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const layoutOf = (outcome: ParseOutcome) => (outcome.outcome === 'recognised' ? `${outcome.kind}/${outcome.layout}` : outcome.outcome);
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));
// Replaces (or with null removes) every run whose text is `from`.
const edit = (doc: ParseDoc, from: string, to: string | null): ParseDoc => ({
  ...doc,
  observations: doc.observations.flatMap((o) => (o.text !== from ? [o] : to === null ? [] : [{ ...o, text: to, raw: to }])),
});
// Adds one run below everything else on the page.
const withRun = (doc: ParseDoc, text: string): ParseDoc => ({
  ...doc,
  observations: [...doc.observations, { id: 'p1.999', page: 1, x: 182, y: 40, width: text.length * 10, height: 10, text, raw: text }],
});

describe('dining_receipt/labelled on the PDF text layer', () => {
  it('recognises m13 as a 餐饮小票, a reference material of 招待费 that forms no event and has no invoice identity', () => {
    const outcome = recognised(slip());
    expect(outcome).toMatchObject({ kind: 'dining_receipt', layout: 'labelled', parserVersion: diningReceipt.version, kindLabel: '餐饮小票', missing: [], findings: [] });
    for (const c of outcome.candidates) expect(c).toMatchObject({ source: 'rule:dining_receipt/labelled', evidence: 'explicit' });
    expect(outcome.candidates.find((c) => c.key === 'paidAmount')?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/), expect.stringMatching(/^p1\.\d+$/)], text: '实收 240.00' }]);
    expect(KINDS.dining_receipt.role).toBe('reference');
    expect(KINDS.dining_receipt.categoryLabel(values(outcome))).toBe('招待费');
    expect(KINDS.dining_receipt.event(values(outcome))).toBeNull();
    expect(KINDS.dining_receipt.identity).toBeUndefined();
  });

  it('takes the amount under 实付 as paid when the slip also prints its total before a discount (m14)', () => {
    expect(values(recognised(discounted()))).toMatchObject({ originalTotal: '268.00', discount: '28.00', paidAmount: '240.00' });
  });

  it('reads a 合计 with no paid label and no discount as the amount paid', () => {
    const read = values(recognised(edit(slip(), '实收', null)));
    expect(read['paidAmount']).toBe('240.00');
    expect(read).not.toHaveProperty('originalTotal');
  });

  it('leaves the paid amount missing when a discounted slip prints no paid label: nothing is worked out', () => {
    const outcome = recognised(edit(discounted(), '实付', null));
    expect(outcome.missing).toEqual(['paidAmount']);
    expect(values(outcome)).toMatchObject({ originalTotal: '268.00', discount: '28.00' });
    expect(values(outcome)).not.toHaveProperty('paidAmount');
  });

  it.each(['结账单', '消费小票', '消费清单', '顾客联'])('recognises the title %s', (title) => {
    expect(layoutOf(dispatch(edit(slip(), '结账单(顾客联)', title), LAYOUTS))).toBe('dining_receipt/labelled');
  });

  it.each(['实付', '实收', '应付', '合计'])('recognises the amount label %s', (label) => {
    const only = edit(edit(slip(), '合计', null), '实收', label);
    expect(values(recognised(only))['paidAmount']).toBe('240.00');
  });

  it('does not recognise a slip without a receipt-style title, or without a paid or total amount', () => {
    expect(diningReceipt.recognise(edit(discounted(), '消费清单', '某某餐厅'))).toBe(false);
    expect(diningReceipt.recognise(edit(edit(slip(), '合计', null), '实收', null))).toBe(false);
  });
});

describe('a hotel 结账单 and a 餐饮小票 are never mistaken for each other', () => {
  // m02 and r210 carry a 结账单 title and a 消费合计, which meet the slip's title and amount anchors: only the stay
  // labels keep them out. Their own snapshot cases pin them as `hotel_folio/labelled`.
  it('refuses the hotel folios m02 and r210 although their title and total meet the slip anchors', () => {
    expect(diningReceipt.recognise(caseDoc('fixture-m02-hotel-folio'))).toBe(false);
    expect(diningReceipt.recognise(caseDoc('fixture-r210-hotel-folio-photo'))).toBe(false);
    expect(layoutOf(dispatch(caseDoc('fixture-m02-hotel-folio'), LAYOUTS))).toBe('hotel_folio/labelled');
  });

  it.each(['入住日期:2026-08-14', '到店日期:2026-08-14', '抵店日期:2026-08-14', '离店日期:2026-08-15', '退房日期:2026-08-15', '房号:1208', '房间号:1208'])(
    'refuses a slip that prints the stay label in %s',
    (run) => {
      expect(diningReceipt.recognise(withRun(slip(), run))).toBe(false);
    },
  );

  it('the hotel folio layout does not recognise either slip, nor the slip layout the dining invoice', () => {
    expect(labelled.recognise(slip())).toBe(false);
    expect(labelled.recognise(discounted())).toBe(false);
    expect(diningReceipt.recognise(caseDoc('fixture-m11-dining-invoice'))).toBe(false);
  });
});
