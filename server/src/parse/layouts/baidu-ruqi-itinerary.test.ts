import { describe, expect, it } from 'vitest';
import { planTransport, type TransportMaterial } from '../../allocation';
import { dispatch, type Recognised } from '../dispatch';
import { normalise, type ParseDoc } from '../doc';
import { factsOf } from '../facts';
import { caseDoc, editedCase } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';

const BAIDU = 'baidu-itinerary-wrapped';
const RUQI = 'ruqi-itinerary-wrapped';
function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${outcome.outcome}`);
  return outcome;
}
const legCandidates = (outcome: Recognised) => outcome.candidates.filter((c) => c.key.startsWith('segments['));

describe.each([['baidu', BAIDU, 'p1.19'], ['ruqi', RUQI, 'p1.18']])('%s itinerary recognition', (name, base, header) => {
  it('requires its own title, complete table header and an original PDF', () => {
    const doc = caseDoc(base!);
    expect(recognised(doc)).toMatchObject({ layout: name, missing: [], findings: [] });
    expect(dispatch(editedCase(base!, { 'p1.1': '行程单' }), LAYOUTS).outcome).toBe('unrecognised');
    expect(dispatch(editedCase(base!, { [header!]: '费用' }), LAYOUTS).outcome).toBe('unrecognised');
    expect(dispatch({ ...doc, mediaType: 'image' }, LAYOUTS).outcome).toBe('unrecognised');
  });
});

describe('dated itinerary table refusals', () => {
  it.each([
    [BAIDU, { 'p1.10': '共2笔行程，合计37.28元（不含附加费、已减免优惠金额）' }, 'segment_rows_incomplete'],
    [BAIDU, { 'p1.29': '￥37.29' }, 'segment_total_mismatch'],
    [BAIDU, { 'p1.21': '2026-02-30' }, 'segment_field_unreadable.1.date'],
    [RUQI, { 'p1.9': '4' }, 'segment_rows_incomplete'],
    [RUQI, { 'p1.32': '4' }, 'segment_index_unexpected.2'],
    [RUQI, { 'p1.42': '待结算' }, 'segment_field_unreadable.2.amount'],
    [RUQI, { 'p1.10': '72.70' }, 'segment_total_mismatch'],
  ] as const)('%s refuses the whole table on %s', (base, edits, code) => {
    const result = recognised(editedCase(base, edits));
    expect(result.findings.map((f) => f.code)).toEqual([code]);
    expect(legCandidates(result)).toEqual([]);
  });

  it('does not adopt a table whose declared total could not be read', () => {
    const result = recognised(editedCase(RUQI, { 'p1.10': '--' }));
    expect(result.missing).toEqual(['segmentCount', 'itineraryTotal']);
    expect(legCandidates(result)).toEqual([]);
  });
});

describe('Ruqi city evidence', () => {
  it('derives a city separately for each trip from both wrapped endpoints and records both as evidence', () => {
    const result = recognised(caseDoc(RUQI));
    expect(result.candidates.filter((c) => c.key.endsWith('.city')).map((c) => [c.value, c.source, c.evidence])).toEqual([
      ['广州市', 'rule:ride_itinerary/ruqi.city_from_endpoints', 'derived'],
      ['佛山市', 'rule:ride_itinerary/ruqi.city_from_endpoints', 'derived'],
      ['广州市', 'rule:ride_itinerary/ruqi.city_from_endpoints', 'derived'],
    ]);
    expect(result.candidates.find((c) => c.key === 'segments[1].city')?.refs[0]?.observationIds).toEqual(['p1.36', 'p1.37', 'p1.38', 'p1.39', 'p1.40']);
  });

  it.each(['测试地点', '佛山市测试地点', '测试广州市地点'])('leaves city unresolved when the destination starts with %s', (destination) => {
    const result = recognised(editedCase(RUQI, { 'p1.27': destination }));
    const facts = factsOf(result).values;
    expect(facts['segments[0].city']).toBeUndefined();
    expect(facts['segments[0].amount']).toBe('35.12');
    expect(facts['segments[1].city']).toBe('佛山市');
  });

  it('does not adopt a province-prefixed address as the municipal city name', () => {
    const result = recognised(editedCase(RUQI, { 'p1.24': '广东省广州市测试起点', 'p1.27': '广东省广州市测试终点' }));
    expect(factsOf(result).values['segments[0].city']).toBeUndefined();
  });
});

describe('Baidu platform and per-trip carrier', () => {
  function plan(doc: ParseDoc, total = '37.28') {
    const outcome = recognised(doc);
    const materials: TransportMaterial[] = [
      { materialId: 'invoice', fileName: 'invoice.pdf', kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票', ok: true, values: { itemName: '*交通运输服务*客运服务费', issueDate: '2026-06-25', sellerName: '示例开票公司', netAmount: total, taxAmount: '0.00', totalAmount: total } },
      { materialId: 'itinerary', fileName: 'itinerary.pdf', kind: outcome.kind, layout: outcome.layout, kindLabel: outcome.kindLabel, values: factsOf(outcome).values, ok: outcome.findings.length === 0 && outcome.missing.length === 0 },
    ];
    return planTransport(materials).lines.get('invoice') ?? [];
  }

  it('names the material after Baidu but its expense after the printed carrier; missing carrier falls back to Baidu', () => {
    const doc = caseDoc(BAIDU);
    expect(recognised(doc).kindLabel).toBe('百度地图行程单');
    expect(plan(doc)[0]?.draft.summary).toMatch(/^曹操出行 · /);
    expect(plan(editedCase(BAIDU, { 'p1.23': '' }))[0]?.draft.summary).toMatch(/^百度地图 · /);
  });

  it('keeps different carriers on separate trips in the same itinerary', () => {
    const doc = editedCase(BAIDU, { 'p1.10': '共2笔行程，合计74.56元（不含附加费、已减免优惠金额）' });
    const trip = doc.observations.filter((o) => /^p1\.(2[0-9])$/.test(o.id));
    const second = trip.map((o) => {
      const raw = o.id === 'p1.20' ? '2' : o.id === 'p1.23' ? '示例出行' : o.raw;
      return { ...o, id: `${o.id}-second`, y: o.y - 50, raw, text: normalise(raw) };
    });
    const double = { ...doc, observations: [...doc.observations.filter((o) => o.y > 500), ...second] };
    expect(plan(double, '74.56').map((line) => line.draft.summary.split(' · ')[0])).toEqual(['曹操出行', '示例出行']);
  });
});
