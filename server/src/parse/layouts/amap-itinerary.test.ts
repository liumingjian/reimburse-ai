import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { dispatch, type Recognised } from '../dispatch';
import type { ParseDoc, TextObservation } from '../doc';
import { pdfDoc } from '../pdf';
import { LAYOUTS } from '.';
import { amapItinerary } from './amap-itinerary';

// Origin: 50931a3:kernel/test/parse.test.mjs (reference case `高德打车电子行程单`: kind ride_itinerary, role reference, no
// invoice identity, `segmentCount` read from `共计N单行程`) and 50931a3:kernel/test/events.test.mjs
// (`行程单逐段明细取得出来，段数与它自己声明的一致`; the route columns are merged by coordinates so a wrapped address is
// never split on spaces; a row count that disagrees with the declared count discards the rows). Inputs: m04 (高德),
// m06 (曹操, not a v1 layout).

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const SOURCE = 'rule:ride_itinerary/amap';

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));

describe('ride_itinerary/amap', () => {
  it('recognises m04 and reads the declared count and total plus every leg, keyed segments[i].<field>', async () => {
    const outcome = recognised(await pdfDoc(fixture('m04-amap-itinerary.pdf')));
    expect(outcome).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', parserVersion: amapItinerary.version, kindLabel: '高德行程单', missing: [], findings: [] });
    expect(values(outcome)).toEqual({
      applyDate: '2026-08-13',
      segmentCount: '3',
      itineraryTotal: '69.19',
      'segments[0].date': '2026-08-10',
      'segments[0].time': '08:52',
      'segments[0].carType': '经济型',
      'segments[0].city': '上海市',
      'segments[0].origin': '虹桥枢纽',
      'segments[0].destination': '漕河泾',
      'segments[0].amount': '26.69',
      'segments[1].date': '2026-08-10',
      'segments[1].time': '18:20',
      'segments[1].carType': '经济型',
      'segments[1].city': '上海市',
      'segments[1].origin': '漕河泾',
      'segments[1].destination': '静安寺',
      'segments[1].amount': '20.85',
      'segments[2].date': '2026-08-12',
      'segments[2].time': '09:15',
      'segments[2].carType': '经济型',
      'segments[2].city': '上海市',
      'segments[2].origin': '静安寺',
      'segments[2].destination': '张江',
      'segments[2].amount': '21.65',
    });
    for (const c of outcome.candidates) expect(c.source).toBe(SOURCE);
    expect(outcome.candidates.find((c) => c.key === 'segments[1].origin')?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '漕河泾' }]);
  });

  it('is the only layout that recognises m04; the 曹操 itinerary (m06) and invoices are not this layout', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    expect(LAYOUTS.filter((layout) => layout.recognise(doc)).map((layout) => layout.name)).toEqual(['amap']);
    for (const file of ['m06-caocao-itinerary.pdf', 'm03-amap-invoice.pdf', 'm07-rail-0809.pdf']) expect(amapItinerary.recognise(await pdfDoc(fixture(file)))).toBe(false);
    expect(dispatch(await pdfDoc(fixture('m06-caocao-itinerary.pdf')), LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
  });

  it('reads the same observations from an image (the OCR adapter, #186, fills the same model)', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const outcome = recognised({ ...doc, mediaType: 'image' });
    expect(values(outcome)).toMatchObject({ segmentCount: '3', 'segments[2].amount': '21.65' });
  });

  it('merges a wrapped origin/destination cell by coordinates instead of cutting it', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    // Leg 1's origin printed on two lines inside its row: `虹桥枢纽` + `P9停车场` a few points lower.
    const origin = doc.observations.find((o) => o.text === '虹桥枢纽') as TextObservation;
    const wrapped = { ...origin, id: 'p1.99', y: origin.y - 9, text: 'P9停车场', raw: 'P9停车场' };
    expect(values(recognised({ ...doc, observations: [...doc.observations, wrapped] }))['segments[0].origin']).toBe('虹桥枢纽P9停车场');
  });

  // The message wording is what the user reads and acts on, so these cases assert it verbatim: each refusal has to name
  // the clause that actually failed, and a count mismatch may only be claimed when the counts really differ (#202).
  it('a leg row count that disagrees with the declared count discards the legs and says so with both counts', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const thirdRowY = doc.observations.find((o) => o.text === '21.65')?.y;
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => o.y !== thirdRowY) });
    expect(outcome.candidates.some((c) => c.key.startsWith('segments['))).toBe(false);
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_rows_incomplete', message: '逐段明细读到 2 行，行程单声明 3 段，对不上；整块不采用。' }]);
  });

  it('names the leg and the field when the counts agree but a leg amount is unreadable (m12), never a count mismatch', async () => {
    const outcome = recognised(await pdfDoc(fixture('m12-amap-itinerary-gap.pdf')));
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_field_unreadable.1.amount', message: '第 1 段的金额没读到；整块不采用。' }]);
    expect(values(outcome)).toEqual({ applyDate: '2026-08-13', segmentCount: '1', itineraryTotal: '32.50' });
  });

  it('names the leg whose 上车时间 is unreadable while the counts agree', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => !o.text.includes('18:20')) });
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_field_unreadable.2.date', message: '第 2 段的上车时间没读到；整块不采用。' }]);
  });

  it('names the leg whose 序号 is not the one expected there', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const thirdRowY = doc.observations.find((o) => o.text === '21.65')?.y;
    const observations = doc.observations.map((o) => (o.y === thirdRowY && o.text === '3' ? { ...o, text: '4', raw: '4' } : o));
    expect(recognised({ ...doc, observations }).findings).toEqual([
      { kind: 'validation', code: 'segment_index_unexpected.3', message: '第 3 段的序号读成了 4；整块不采用。' },
    ]);
  });

  it('reports a declared total it could not read as missing, and does not claim a count mismatch it cannot check', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => !o.text.startsWith('共计')) });
    expect(outcome.missing).toEqual(['segmentCount', 'itineraryTotal']);
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_rows_incomplete', message: '行程单声明的段数没读到，逐段明细读到 3 行；整块不采用。' }]);
  });
});
