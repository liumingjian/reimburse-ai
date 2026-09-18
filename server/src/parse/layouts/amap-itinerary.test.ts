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

  it('a leg row count that disagrees with the declared count discards the legs and raises a validation finding', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const thirdRowY = doc.observations.find((o) => o.text === '21.65')?.y;
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => o.y !== thirdRowY) });
    expect(outcome.candidates.some((c) => c.key.startsWith('segments['))).toBe(false);
    expect(outcome.findings).toEqual([expect.objectContaining({ kind: 'validation', code: 'segment_rows_incomplete' })]);
  });

  it('reports a declared total it could not read as missing', async () => {
    const doc = await pdfDoc(fixture('m04-amap-itinerary.pdf'));
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => !o.text.startsWith('共计')) });
    expect(outcome.missing).toEqual(['segmentCount', 'itineraryTotal']);
  });
});
