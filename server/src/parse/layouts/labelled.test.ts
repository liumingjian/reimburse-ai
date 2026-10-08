import { describe, expect, it, vi } from 'vitest';
import { KINDS } from '../../kind-policy';
import { dispatch, type Recognised } from '../dispatch';
import type { ParseDoc, TextObservation } from '../doc';
import { caseDoc } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';
import { labelled } from './labelled';

// Ported from 50931a3:kernel/test/parse.test.mjs (REFERENCES, the `hotel_folio` case: a folio is a reference material with no
// invoice identity whose stay dates are candidates) and the folio half of 50931a3:kernel/test/events.test.mjs
// ('住宿：入住日期来自结账单…'), on the real text layer of @baox/fixtures m02. #212: recognition is on the folio's own
// labels, not a chain name, and a photo's values are read by position from their labels (r210 and the synthetic docs).
// m02 and r210 are read from their snapshot cases (`../snapshots/fixture-*`, which also score their values): no pdfjs,
// no OCR.

vi.mock('unpdf', () => {
  throw new Error('a layout test loaded pdfjs: read the document from a snapshot case');
});
vi.mock('../ocr', () => {
  throw new Error('a layout test loaded OCR: read the document from a snapshot case');
});

const folioDoc = () => caseDoc('fixture-m02-hotel-folio');
const SOURCE = 'rule:hotel_folio/labelled';

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

// A photographed folio as OCR returns it: every label and every value its own box, 40px text on rows 60px apart, values
// a column (300px) right of their labels. `rows` are `[label, value]`; a null value prints the label alone.
const H = 40;
const PITCH = 60;
function photo(rows: readonly (readonly [string, string | null])[], extra: readonly TextObservation[] = []): ParseDoc {
  const observations: TextObservation[] = [box('结账单', 200, 1000)];
  rows.forEach(([label, value], i) => {
    const y = 900 - i * PITCH;
    observations.push(box(label, 40, y));
    if (value !== null) observations.push(box(value, 340, y));
  });
  observations.push(...extra);
  return { mediaType: 'image', pageCount: 1, observations: observations.map((o, n) => ({ ...o, id: `p1.${n}` })), codes: [] };
}
function box(text: string, x: number, y: number, height = H): TextObservation {
  return { id: '', page: 1, x, y, width: text.length * height, height, text, raw: text };
}
const STAY = (checkIn: string | null, checkOut: string | null) =>
  [
    ['房号', '0816'],
    ['入住日期', checkIn],
    ['离店日期', checkOut],
    ['消费合计', '3,640.00'],
  ] as const;

describe('hotel_folio/labelled on the PDF text layer', () => {
  // Every value m02 reads as is scored by its snapshot case (`fixture-m02-hotel-folio`).
  it('recognises m02 as a folio, a reference material with its stay dates and no invoice identity', () => {
    const outcome = recognised(folioDoc());
    expect(outcome).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', parserVersion: labelled.version, kindLabel: '酒店结账单', missing: [], findings: [] });
    expect(KINDS.hotel_folio.role).toBe('reference');
    // Not an invoice: no invoice number, so it never takes part in 发票占用 (invoice occupancy) or duplicates.
    expect(outcome.candidates.some((c) => c.key === 'invoiceNumber')).toBe(false);
    for (const c of outcome.candidates) expect(c).toMatchObject({ source: SOURCE, evidence: 'explicit', parserVersion: labelled.version });
    expect(outcome.candidates.find((c) => c.key === 'checkIn')?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '入住日期：2026-08-09' }]);
    expect(KINDS.hotel_folio.categoryLabel(values(outcome))).toBe('住宿');
    expect(KINDS.hotel_folio.event(values(outcome))).toBeNull();
  });

  it('does not recognise the hotel invoice (m01), and the e-invoice layout does not recognise the folio', () => {
    expect(labelled.recognise(caseDoc('fixture-m01-hotel-invoice'))).toBe(false);
    expect(recognised(folioDoc()).layout).toBe('labelled');
  });

  it('recognises a folio of any chain: no chain name takes part in recognition', () => {
    const other = recognised(edit(folioDoc(), '全季酒店(上海某某店)', '汉庭酒店(上海某某店)'));
    expect(values(other)).toMatchObject({ hotelName: '汉庭酒店(上海某某店)', checkIn: '2026-08-09', checkOut: '2026-08-22' });
    const unnamed = recognised(edit(folioDoc(), '全季酒店(上海某某店)', null));
    expect(unnamed.missing).toEqual([]);
    expect(values(unnamed)).not.toHaveProperty('hotelName');
  });

  it('never derives a check-out date from the check-in date and the night count', () => {
    const outcome = recognised(edit(folioDoc(), '离店日期:2026-08-22', '离店日期:'));
    expect(outcome.missing).toEqual(['checkOut']);
    expect(outcome.candidates.some((c) => c.key === 'checkOut')).toBe(false);
  });

  it('flags dates that disagree with the night count, and charges that do not add up to the total', () => {
    const nights = recognised(edit(folioDoc(), '天数:13', '天数:12'));
    expect(nights.findings).toEqual([expect.objectContaining({ kind: 'validation', code: 'nights_mismatch' })]);

    const doc = folioDoc();
    const total = recognised({ ...doc, observations: doc.observations.map((o) => (o.id === 'p1.52' ? { ...o, text: '3641.00', raw: '3641.00' } : o)) });
    expect(total.findings).toEqual([expect.objectContaining({ kind: 'validation', code: 'charges_not_conserved' })]);
  });
});

describe('hotel_folio/labelled recognition anchors', () => {
  it('needs check-in, check-out and the total, and neither the 结账单 title nor 房号', () => {
    expect(recognised(photo(STAY('2026-08-09', '2026-08-22'))).layout).toBe('labelled');
    for (const label of ['入住日期', '离店日期', '消费合计']) {
      const doc = photo(STAY('2026-08-09', '2026-08-22').filter(([l]) => l !== label));
      expect(dispatch(doc, LAYOUTS), label).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
    }
    const untitled = photo(STAY('2026-08-09', '2026-08-22'));
    expect(recognised({ ...untitled, observations: untitled.observations.filter((o) => o.text !== '结账单') }).layout).toBe('labelled');
    expect(recognised(photo(STAY('2026-08-09', '2026-08-22').filter(([l]) => l !== '房号'))).layout).toBe('labelled');
  });

  it('takes each field under any label hotels print for it', () => {
    const doc = photo([
      ['房间号', '0816'],
      ['到店日期', '2026-08-09'],
      ['退房日期', '2026-08-22'],
      ['收费', '3,640.00'],
    ]);
    expect(values(recognised(doc))).toEqual({ roomNumber: '0816', checkIn: '2026-08-09', checkOut: '2026-08-22', folioTotal: '3640.00' });
  });

  it('reads several fields from one run, splitting only where a label follows', () => {
    const doc = photo([
      ['入住日期:2026-08-09,房号:0816入住13天', null],
      ['离店日期:2026-08-22;房价:280.00/间/天', null],
      ['消费合计:3,640.00元', null],
    ]);
    expect(values(recognised(doc))).toEqual({ checkIn: '2026-08-09', roomNumber: '0816', checkOut: '2026-08-22', roomRate: '280.00', folioTotal: '3640.00' });
  });

  it('leaves a 结账单 without accommodation labels unrecognised: the title alone never recognises', () => {
    const restaurant = photo([
      ['桌号', 'A12'],
      ['人数', '4'],
      ['合计', '386.00'],
    ]);
    expect(dispatch(restaurant, LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
    const stripped = folioDoc().observations.filter((o) => !/^(入住日期|离店日期|房号|消费合计)/.test(o.text));
    expect(dispatch({ ...folioDoc(), observations: stripped }, LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
  });

  it('anchors on the label itself, not on a longer word that starts with it', () => {
    const renamed = (from: string, to: string) => photo(STAY('2026-08-09', '2026-08-22').map(([label, value]) => [label === from ? to : label, value] as const));
    expect(dispatch(renamed('离店日期', '离店日期时间'), LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
    expect(dispatch(renamed('消费合计', '消费合计金额'), LAYOUTS)).toEqual({ outcome: 'unrecognised', reason: 'no_layout' });
    // The label with its colon, alone or with its value in one run, is still the label.
    expect(values(recognised(renamed('房号', '房号:')))).toMatchObject({ roomNumber: '0816' });
    const joined = photo(STAY('2026-08-09', '2026-08-22').map(([label, value]) => (label === '房号' ? (['房号：0816', null] as const) : ([label, value] as const))));
    expect(values(recognised(joined))).toMatchObject({ roomNumber: '0816' });
  });

  it('never takes a longer word that starts with a label as that label', () => {
    // 房号类型 sits above 房号 on the page and comes first in reading order; the 房号 value is still the real label's.
    const doc = photo(STAY('2026-08-09', '2026-08-22'), [box('房号类型', 40, 960), box('大床房', 340, 960)]);
    const firstWord = { ...doc, observations: [...doc.observations.slice(-2), ...doc.observations.slice(0, -2)] };
    expect(values(recognised(firstWord))).toMatchObject({ roomNumber: '0816' });
  });
});

describe('hotel_folio/labelled reads each value by position from its label', () => {
  it('reads the value right of the label within its row band, with both boxes as evidence', () => {
    const outcome = recognised(photo(STAY('2026-08-09', '2026-08-22')));
    expect(values(outcome)).toEqual({ roomNumber: '0816', checkIn: '2026-08-09', checkOut: '2026-08-22', folioTotal: '3640.00' });
    expect(outcome.missing).toEqual([]);
    expect(outcome.candidates.find((c) => c.key === 'checkIn')?.refs).toEqual([{ page: 1, observationIds: ['p1.3', 'p1.4'], text: '入住日期 2026-08-09' }]);
  });

  it('does not take a value from the neighbouring row, only from within half a text height', () => {
    // The check-out value sits 0.6 text heights below its label's centre: outside the band, and not below the label.
    const doc = photo(STAY('2026-08-09', null), [box('2026-08-22', 340, 900 - 2 * PITCH - 0.6 * H)]);
    expect(recognised(doc).missing).toEqual(['checkOut']);
    const within = photo(STAY('2026-08-09', null), [box('2026-08-22', 340, 900 - 2 * PITCH - 0.4 * H)]);
    expect(values(recognised(within))).toMatchObject({ checkOut: '2026-08-22' });
  });

  it('else reads the box directly below the label, within one text height of gap', () => {
    const below = (gap: number) =>
      photo(
        [
          ['房号', '0816'],
          ['消费合计', '3640.00'],
          ['入住日期', '2026-08-09'],
        ],
        [box('离店日期', 40, 500), box('2026-08-22', 40, 500 - gap - H)],
      );
    expect(values(recognised(below(0.9 * H)))).toMatchObject({ checkOut: '2026-08-22' });
    expect(recognised(below(1.2 * H)).missing).toEqual(['checkOut']);
  });

  it('never reads another label as a value', () => {
    // 入住日期 has no value on its row; the box below it is the 离店日期 label, which is not its value.
    const doc = photo(
      [
        ['房号', '0816'],
        ['消费合计', '3640.00'],
        ['入住日期', null],
      ],
      [box('离店日期', 40, 900 - 3 * PITCH), box('2026-08-22', 340, 900 - 3 * PITCH)],
    );
    const outcome = recognised(doc);
    expect(outcome.missing).toEqual(['checkIn']);
    expect(values(outcome)).toMatchObject({ checkOut: '2026-08-22' });
  });
});

describe('hotel_folio/labelled date shapes', () => {
  it.each([
    ['2026-08-09', '2026-08-09'],
    ['2026/08/09', '2026-08-09'],
    ['2026/8/9', '2026-08-09'],
    ['2026.08.09', '2026-08-09'],
    ['2026年8月9日', '2026-08-09'],
    ['20260809', '2026-08-09'],
    ['2026-0809', '2026-08-09'],
    ['202608-09', '2026-08-09'],
  ])('reads %s as %s', (printed, date) => {
    expect(values(recognised(photo(STAY(printed, '2026-08-22'))))).toMatchObject({ checkIn: date });
  });

  it.each(['09/08/2026', '2026-8-9', '26-08-09', '2026-02-30', '20260230', '2026年08月09', '入住 2026-08-09'])('leaves %s missing: no looser pattern, no scoring', (printed) => {
    const outcome = recognised(photo(STAY(printed, '2026-08-22')));
    expect(outcome.missing).toEqual(['checkIn']);
    expect(outcome.candidates.some((c) => c.key === 'checkIn')).toBe(false);
  });

  it('back-calculates nothing: no check-in from 天数, no 天数 from the dates', () => {
    const doc = photo([...STAY(null, '2026-08-22'), ['天数', '13']]);
    const outcome = recognised(doc);
    expect(outcome.missing).toEqual(['checkIn']);
    expect(outcome.candidates.map((c) => c.key).sort()).toEqual(['checkOut', 'folioTotal', 'nights', 'roomNumber']);
    expect(values(recognised(photo(STAY('2026-08-09', '2026-08-22'))))).not.toHaveProperty('nights');
  });
});

describe('hotel_folio/labelled on the r210 photo', () => {
  // The OCR boxes of the photo as captured (`fixture-r210-hotel-folio-photo`, whose case scores the values: printed as
  // 2026/08/09 and 2026年08月22日). Here: each value's evidence is its label's box and its own.
  it('reads the stay dates of a photographed folio whose labels and values are separate boxes', () => {
    const outcome = recognised(caseDoc('fixture-r210-hotel-folio-photo'));
    expect(outcome).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', missing: [], findings: [] });
    for (const key of ['checkIn', 'checkOut', 'folioTotal']) expect(outcome.candidates.find((c) => c.key === key)?.refs[0]?.observationIds).toHaveLength(2);
  });
});
