import { describe, expect, it, vi } from 'vitest';
import { dispatch, type Recognised } from '../dispatch';
import { compact, type ParseDoc, type TextObservation } from '../doc';
import { caseDoc } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';
import { amapItinerary } from './amap-itinerary';

// Origin: 50931a3:kernel/test/parse.test.mjs (reference case `高德打车电子行程单`: kind ride_itinerary, role reference, no
// invoice identity, `segmentCount` read from `共计N单行程`) and 50931a3:kernel/test/events.test.mjs
// (`行程单逐段明细取得出来，段数与它自己声明的一致`; the route columns are merged by coordinates so a wrapped address is
// never split on spaces; a row count that disagrees with the declared count discards the rows). Inputs: m04 (高德),
// m06 (曹操, not a v1 layout). They are read from their snapshot cases (`../snapshots/fixture-*`, which also score
// what each one reads as), never through pdfjs.

vi.mock('unpdf', () => {
  throw new Error('a layout test loaded pdfjs: read the document from a snapshot case');
});

const SOURCE ='rule:ride_itinerary/amap';

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));

describe('ride_itinerary/amap', () => {
  // What m04 reads as, leg by leg, is scored by its snapshot case (`fixture-m04-amap-itinerary`).
  it('recognises m04 and reads the declared count and total plus every leg, keyed segments[i].<field>', () => {
    const outcome = recognised(caseDoc('fixture-m04-amap-itinerary'));
    expect(outcome).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', parserVersion: amapItinerary.version, kindLabel: '高德行程单', missing: [], findings: [] });
    expect(Object.keys(values(outcome))).toHaveLength(3 + 3 * 7);
    for (const c of outcome.candidates) expect(c.source).toBe(SOURCE);
    expect(outcome.candidates.find((c) => c.key === 'segments[1].origin')?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '漕河泾' }]);
  });

  it('is the only layout that recognises m04; the 曹操 itinerary (m06) and invoices are not this layout', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    expect(LAYOUTS.filter((layout) => layout.recognise(doc)).map((layout) => layout.name)).toEqual(['amap']);
    for (const name of ['fixture-m06-caocao-itinerary', 'fixture-m03-amap-invoice', 'fixture-m07-rail-0809']) expect(amapItinerary.recognise(caseDoc(name))).toBe(false);
    expect(dispatch(caseDoc('fixture-m06-caocao-itinerary'), LAYOUTS)).toMatchObject({ outcome: 'unrecognised', reason: 'no_layout' });
  });

  it('reads the same observations from an image (the OCR adapter, #186, fills the same model)', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    const outcome = recognised({ ...doc, mediaType: 'image' });
    expect(values(outcome)).toMatchObject({ segmentCount: '3', 'segments[2].amount': '21.65' });
  });

  it('merges a wrapped origin/destination cell by coordinates instead of cutting it', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    // Leg 1's origin printed on two lines inside its row: `虹桥枢纽` + `P9停车场` a few points lower.
    const origin = doc.observations.find((o) => o.text === '虹桥枢纽') as TextObservation;
    const wrapped = { ...origin, id: 'p1.99', y: origin.y - 9, text: 'P9停车场', raw: 'P9停车场' };
    expect(values(recognised({ ...doc, observations: [...doc.observations, wrapped] }))['segments[0].origin']).toBe('虹桥枢纽P9停车场');
  });

  // Every leg value of r205 is scored by its snapshot case (`fixture-r205-amap-itinerary-wrapped`).
  it('reads a wrapped 上车时间 cell and amounts printed as 26.69元 / ¥42.50 (r205)', () => {
    const doc = caseDoc('fixture-r205-amap-itinerary-wrapped');
    // The fixture really wraps leg 1's 上车时间: its date and its `HH:MM` are two observations on two baselines, and
    // no single observation carries both. The summary line is split the same way.
    expect(doc.observations.some((o) => /^\d{4}-\d{2}-\d{2}\s*08:52$/.test(o.text))).toBe(false);
    const at = (text: string) => doc.observations.find((o) => o.text === text) as TextObservation;
    expect(at('2026-08-10').y).toBeGreaterThan(at('08:52').y);
    expect(doc.observations.some((o) => /^共计\d+单行程/.test(compact(o.text)))).toBe(false);

    // The date and the `HH:MM` are two text blocks on two lines of the same cell; they read as one value.
    const outcome = recognised(doc);
    expect(outcome).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', missing: [], findings: [] });
    expect(values(outcome)).toMatchObject({ 'segments[0].date': '2026-08-10', 'segments[0].time': '08:52' });
  });

  // The message wording is what the user reads and acts on, so these cases assert it verbatim: each refusal has to name
  // the clause that actually failed, and a count mismatch may only be claimed when the counts really differ (#202).
  it('a leg row count that disagrees with the declared count discards the legs and says so with both counts', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    const thirdRowY = doc.observations.find((o) => o.text === '21.65')?.y;
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => o.y !== thirdRowY) });
    expect(outcome.candidates.some((c) => c.key.startsWith('segments['))).toBe(false);
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_rows_incomplete', message: '逐段明细读到 2 行，行程单声明 3 段，对不上；整块不采用。' }]);
  });

  it('names the leg and the field when the counts agree but a leg amount is unreadable (r202), never a count mismatch', () => {
    const outcome = recognised(caseDoc('fixture-r202-amap-itinerary-gap'));
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_field_unreadable.1.amount', message: '第 1 段的金额没读到；整块不采用。' }]);
    expect(values(outcome)).toEqual({ applyDate: '2026-08-13', segmentCount: '1', itineraryTotal: '32.50' });
  });

  // The last leg's row band reaches half a pitch below its baseline and its amount column has no right bound, so
  // whatever is printed under the table is a candidate for that cell. A cell that reads as no amount refuses the whole
  // block, so a table total line under the last leg used to discard every leg of the itinerary.
  it('a total line printed under the last leg does not join its amount cell', () => {
    const doc = itineraryDoc();
    const parsed = recognised(doc);
    expect(parsed.findings).toEqual([]);
    expect(values(parsed)['segments[1].amount']).toBe('30.00');

    const last = doc.observations.find((o) => o.text === '2') as TextObservation;
    const belowTable: TextObservation = { id: 'p1.99', page: 1, x: 540, y: last.y - 25, width: 60, height: 10, text: '合计60.00元', raw: '合计60.00元' };
    const withTotal = recognised({ ...doc, observations: [...doc.observations, belowTable] });
    expect(withTotal.findings).toEqual([]);
    expect(values(withTotal)['segments[1].amount']).toBe('30.00');
  });

  it('names the leg whose 上车时间 is unreadable while the counts agree', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => !o.text.includes('18:20')) });
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_field_unreadable.2.date', message: '第 2 段的上车时间没读到；整块不采用。' }]);
  });

  it('names the leg whose 序号 is not the one expected there', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    const thirdRowY = doc.observations.find((o) => o.text === '21.65')?.y;
    const observations = doc.observations.map((o) => (o.y === thirdRowY && o.text === '3' ? { ...o, text: '4', raw: '4' } : o));
    expect(recognised({ ...doc, observations }).findings).toEqual([
      { kind: 'validation', code: 'segment_index_unexpected.3', message: '第 3 段的序号读成了 4；整块不采用。' },
    ]);
  });

  it('reports a declared total it could not read as missing, and does not claim a count mismatch it cannot check', () => {
    const doc = caseDoc('fixture-m04-amap-itinerary');
    const outcome = recognised({ ...doc, observations: doc.observations.filter((o) => !o.text.startsWith('共计')) });
    expect(outcome.missing).toEqual(['segmentCount', 'itineraryTotal']);
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_rows_incomplete', message: '行程单声明的段数没读到，逐段明细读到 3 行；整块不采用。' }]);
  });
});

// A hand-built itinerary with a generous row pitch: a header row, two legs, and leg 1's 上车时间 wrapped onto a second
// line. Geometry is explicit so the row bands are, too.
function itineraryDoc(): ParseDoc {
  const observations: TextObservation[] = [];
  const at = (x: number, y: number, text: string, width = text.length * 9) => {
    observations.push({ id: `p1.${observations.length + 1}`, page: 1, x, y, width, height: 10, text, raw: text });
  };
  at(40, 780, '高德地图电子行程单');
  at(40, 740, '申请日期:2026-08-13');
  at(40, 720, '共计2单行程,合计60.00元');
  const columns: [number, string][] = [[40, '序号'], [90, '车型'], [160, '上车时间'], [250, '城市'], [320, '起点'], [430, '终点'], [540, '金额']];
  for (const [x, text] of columns) at(x, 700, text);
  // Legs 60 points apart, so half a pitch below the last one reaches well past any wrapped line.
  const legs = [
    { y: 660, no: '1', from: '虹桥枢纽', to: '漕河泾' },
    { y: 600, no: '2', from: '静安寺', to: '张江' },
  ];
  for (const leg of legs) {
    at(40, leg.y, leg.no);
    at(90, leg.y, '经济型');
    at(160, leg.y, '2026-08-10');
    at(160, leg.y - 12, '08:52');
    at(250, leg.y, '上海市');
    at(320, leg.y, leg.from);
    at(430, leg.y, leg.to);
    at(540, leg.y, '30.00元');
  }
  return { mediaType: 'pdf', pageCount: 1, codes: [], observations };
}
