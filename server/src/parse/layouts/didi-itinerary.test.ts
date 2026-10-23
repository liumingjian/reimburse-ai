import { describe, expect, it, vi } from 'vitest';
import { dispatch, type Recognised } from '../dispatch';
import { normalise, type ParseDoc } from '../doc';
import { caseDoc } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';
import { didiItinerary } from './didi-itinerary';

// The 滴滴 行程单 版式 (#449). The base document is a real single-page 滴滴出行-行程单, captured redacted
// (`../snapshots/didi-itinerary-single-page`, which also scores every fact it reads). The cases below edit its runs to
// reach what no real sample shows: a range crossing New Year, a year that does not fit uniquely, a count or a total that
// disagrees with the legs.

vi.mock('unpdf', () => {
  throw new Error('a layout test loaded pdfjs: read the document from a snapshot case');
});

const BASE = 'didi-itinerary-single-page';
const SOURCE = 'rule:ride_itinerary/didi';
const YEAR = 'rule:ride_itinerary/didi.year_from_range';

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));
const legKeys = (outcome: Recognised) => outcome.candidates.filter((c) => c.key.startsWith('segments['));

// The base document with whole runs replaced, each found by its printed text.
function edited(replacements: Readonly<Record<string, string>>): ParseDoc {
  const doc = caseDoc(BASE);
  for (const from of Object.keys(replacements)) if (!doc.observations.some((o) => o.raw === from)) throw new Error(`no run prints ${from}`);
  return { ...doc, observations: doc.observations.map((o) => (replacements[o.raw] === undefined ? o : { ...o, text: normalise(replacements[o.raw] ?? ''), raw: replacements[o.raw] ?? '' })) };
}
const RANGE = '· 行程起止日期：2026-07-02 至 2026-07-03';
const SUMMARY = '· 共2笔行程， 合计81.60元';
const range = (from: string, to: string) => ({ [RANGE]: `· 行程起止日期：${from} 至 ${to}` });

// #450: the two-page capture (`../snapshots/didi-itinerary-two-page-wrapped` scores every leg it reads) is judged as one
// list: the legs of page 2 count toward 共20笔 and must carry on the 序号 of page 1.
describe('ride_itinerary/didi, a table over two pages', () => {
  const TWO_PAGES = 'didi-itinerary-two-page-wrapped';
  const refusal = (doc: ParseDoc) => {
    const outcome = recognised(doc);
    return { codes: outcome.findings.map((f) => f.code), legs: legKeys(outcome).length };
  };

  it('refuses the legs when page 2 is missing: 10 legs read against 共20笔', () => {
    const doc = caseDoc(TWO_PAGES);
    expect(refusal({ ...doc, pageCount: 1, observations: doc.observations.filter((o) => o.page === 1) })).toEqual({ codes: ['segment_rows_incomplete', 'segment_total_mismatch'], legs: 0 });
  });

  it('refuses the legs when page 2 restarts its 序号 instead of carrying on', () => {
    const doc = caseDoc(TWO_PAGES);
    const restarted = { ...doc, observations: doc.observations.map((o) => (o.page === 2 && o.raw === '11' ? { ...o, text: '1', raw: '1' } : o)) };
    expect(refusal(restarted)).toEqual({ codes: ['segment_index_unexpected.11'], legs: 0 });
  });
});

describe('ride_itinerary/didi', () => {
  it('recognises a 滴滴出行-行程单 as the only layout and names it 滴滴行程单; the year of each leg date is derived', () => {
    const doc = caseDoc(BASE);
    expect(LAYOUTS.filter((layout) => layout.recognise(doc)).map((layout) => layout.name)).toEqual(['didi']);
    const outcome = recognised(doc);
    expect(outcome).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', parserVersion: didiItinerary.version, kindLabel: '滴滴行程单', missing: [], findings: [] });
    for (const c of outcome.candidates) expect(c.source).toBe(c.key.endsWith('.date') ? YEAR : SOURCE);
    expect(outcome.candidates.find((c) => c.key === 'segments[0].date')).toMatchObject({ evidence: 'derived' });
  });

  it('does not take the synthetic 曹操 行程单 (m06, titled just 行程单) or the 高德 one', () => {
    for (const name of ['fixture-m06-caocao-itinerary', 'fixture-m04-amap-itinerary', 'fixture-m05-caocao-invoice']) expect(didiItinerary.recognise(caseDoc(name))).toBe(false);
    expect(dispatch(caseDoc('fixture-m06-caocao-itinerary'), LAYOUTS)).toMatchObject({ outcome: 'unrecognised', reason: 'no_layout' });
  });

  it('reads the 第三方网约车服务提供方 title the same way and names the carrier it prints: 曹操出行行程单', () => {
    // The real 曹操 face prints this title as one run, with an em dash, over the same header and table.
    const doc = edited({ '滴滴出行-行程单': '第三方网约车服务提供方曹操出行—行程单' });
    expect(LAYOUTS.filter((layout) => layout.recognise(doc)).map((layout) => layout.name)).toEqual(['didi']);
    const outcome = recognised(doc);
    expect(outcome).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', kindLabel: '曹操出行行程单', missing: [], findings: [] });
    expect(values(outcome)).toEqual({
      applyDate: '2026-10-13',
      segmentCount: '2',
      itineraryTotal: '81.60',
      'segments[0].date': '2026-07-02',
      'segments[0].time': '23:20',
      'segments[0].carType': '特惠快车',
      'segments[0].city': '西安市',
      'segments[0].origin': '长乐公园-东广场-B2层地下停车场-网约车站',
      'segments[0].destination': '华清|老街油泼面(环山路北店)',
      'segments[0].amount': '62.70',
      'segments[1].date': '2026-07-03',
      'segments[1].time': '08:00',
      'segments[1].carType': '惊喜特价',
      'segments[1].city': '西安市',
      'segments[1].origin': '华清东路|中国石化西安临潼骊山加油站',
      'segments[1].destination': '临潼区|雨金镇站',
      'segments[1].amount': '18.90',
    });
  });

  it('a third-party title without a carrier, or not ending in 行程单, is not taken', () => {
    expect(didiItinerary.recognise(edited({ '滴滴出行-行程单': '第三方网约车服务提供方—行程单' }))).toBe(false);
    expect(didiItinerary.recognise(edited({ '滴滴出行-行程单': '第三方网约车服务提供方曹操出行' }))).toBe(false);
  });

  it('needs the title and the table header: either alone is not a 滴滴 行程单', () => {
    expect(didiItinerary.recognise(edited({ '滴滴出行-行程单': '行程单' }))).toBe(false);
    expect(didiItinerary.recognise(edited({ 终点: '目的地' }))).toBe(false);
  });

  it('a range crossing New Year gives each leg its own year', () => {
    const doc = edited({ ...range('2025-12-28', '2026-01-03'), '07-02 23:20 周四': '12-30 23:20 周二', '07-03 08:00 周五': '01-02 08:00 周五' });
    const outcome = recognised(doc);
    expect(outcome.findings).toEqual([]);
    expect(values(outcome)).toMatchObject({ 'segments[0].date': '2025-12-30', 'segments[0].time': '23:20', 'segments[1].date': '2026-01-02', 'segments[1].time': '08:00' });
  });

  it('a date that fits the range in two years is left missing, and the legs are refused naming that leg', () => {
    // 07-02 lies inside 2025-07-02..2026-07-02 in both years; 07-03 only in 2025.
    const outcome = recognised(edited(range('2025-07-02', '2026-07-02')));
    expect(outcome.findings).toEqual([
      { kind: 'validation', code: 'segment_year_undecided.1', message: '第 1 段的上车日期 07-02 在行程起止日期 2025-07-02 至 2026-07-02 内对得上不止一个年份，没有采用；整块不采用。' },
    ]);
    expect(legKeys(outcome)).toEqual([]);
    expect(values(outcome)).toEqual({ applyDate: '2026-10-13', segmentCount: '2', itineraryTotal: '81.60' });
  });

  it('a date outside the range in every year is left missing, and the legs are refused naming that leg', () => {
    const outcome = recognised(edited(range('2026-07-02', '2026-07-02')));
    expect(outcome.findings).toEqual([
      { kind: 'validation', code: 'segment_year_undecided.2', message: '第 2 段的上车日期 07-03 不在行程起止日期 2026-07-02 至 2026-07-02 内，定不了年份；整块不采用。' },
    ]);
    expect(legKeys(outcome)).toEqual([]);
  });

  it('without a readable 行程起止日期 no leg gets a year, and each leg says so', () => {
    const outcome = recognised(edited({ [RANGE]: '· 行程起止日期：' }));
    expect(outcome.findings.map((f) => [f.kind, f.code])).toEqual([
      ['validation', 'segment_year_undecided.1'],
      ['validation', 'segment_year_undecided.2'],
    ]);
    expect(outcome.findings[0]?.message).toBe('第 1 段的上车日期 07-02 定不了年份：行程起止日期没读到；整块不采用。');
  });

  it('a declared count that disagrees with the legs refuses them with both counts', () => {
    const outcome = recognised(edited({ [SUMMARY]: '· 共3笔行程， 合计81.60元' }));
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_rows_incomplete', message: '逐段明细读到 2 行，行程单声明 3 笔，对不上；整块不采用。' }]);
    expect(legKeys(outcome)).toEqual([]);
    expect(values(outcome)).toMatchObject({ segmentCount: '3', itineraryTotal: '81.60' });
  });

  it('leg amounts that do not sum to 合计 to the cent refuse the legs and name both sums', () => {
    const outcome = recognised(edited({ [SUMMARY]: '· 共2笔行程， 合计81.61元' }));
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_total_mismatch', message: '逐段金额合计 81.60，行程单合计 81.61，差一分也对不上；整块不采用。' }]);
    expect(legKeys(outcome)).toEqual([]);
  });

  it('a leg whose amount is unreadable is named, and the total is not also claimed to disagree', () => {
    const outcome = recognised(edited({ '18.90': '--' }));
    expect(outcome.findings).toEqual([{ kind: 'validation', code: 'segment_field_unreadable.2.amount', message: '第 2 段的金额没读到；整块不采用。' }]);
  });
});
