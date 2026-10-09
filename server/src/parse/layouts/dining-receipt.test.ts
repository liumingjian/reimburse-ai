import { describe, expect, it } from 'vitest';
import { dispatch } from '../dispatch';
import type { ParseDoc } from '../doc';
import { LAYOUTS } from '.';

const receipt = (text: readonly string[]): ParseDoc => ({
  mediaType: 'pdf', pageCount: 1, codes: [],
  observations: text.map((raw, index) => ({ id: `p1.${index}`, page: 1, x: 40, y: 800 - index * 25, width: 180, height: 12, text: raw.normalize('NFKC'), raw })),
});

describe('dining receipt recognition', () => {
  it('reads a restaurant checkout slip as reference evidence with its paid amount', () => {
    const outcome = dispatch(receipt(['结账单', '商户：小河餐厅', '日期：2026-08-18', '时间：19:20:00', '实付：240.00']), LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', layout: 'labelled', kindLabel: '餐饮小票', missing: [], findings: [] });
    if (outcome.outcome !== 'recognised') throw new Error('receipt not recognised');
    expect(Object.fromEntries(outcome.candidates.map((candidate) => [candidate.key, candidate.value]))).toEqual({ merchantName: '小河餐厅', receiptDate: '2026-08-18', receiptTime: '19:20:00', paidAmount: '240.00' });
  });

  it('uses the amount actually paid ahead of the original total, without calculating it', () => {
    const outcome = dispatch(receipt(['消费清单', '合计：300.00', '优惠：60.00', '实收：240.00']), LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', missing: [] });
    if (outcome.outcome !== 'recognised') throw new Error('receipt not recognised');
    expect(Object.fromEntries(outcome.candidates.map((candidate) => [candidate.key, candidate.value]))).toEqual({ paidAmount: '240.00', originalTotal: '300.00', discount: '60.00' });
    const unreadable = dispatch(receipt(['消费清单', '合计：300.00', '优惠：60.00', '实收：']), LAYOUTS);
    expect(unreadable).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', missing: ['paidAmount'] });
  });

  it.each(['小票', '餐饮小票', '结账单', '消费小票', '消费清单', '顾客联'])('requires title %s and an amount label', (title) => {
    expect(dispatch(receipt([title, '应付：240.00']), LAYOUTS)).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt' });
    expect(dispatch(receipt([title, '240.00']), LAYOUTS).outcome).toBe('unrecognised');
    expect(dispatch(receipt(['支付成功', '实付：240.00']), LAYOUTS).outcome).toBe('unrecognised');
  });

  it('keeps a hotel compound field observation out of dining recognition', () => {
    const outcome = dispatch(receipt(['结账单', '合计：240.00', '姓名:甲,入住日期:2026-08-18,离店日期:2026-08-19,消费合计:240.00']), LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'hotel_folio', layout: 'labelled' });
  });

  it('keeps long compound hotel observations out of dining dispatch (#360)', () => {
    const outcome = dispatch(receipt(['结账单', '合计:240.00', '姓名:张三,入住日期:2026-08-18,离店日期:2026-08-19,房号:101,天数:1,房价:240.00,消费合计:240.00']), LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'hotel_folio', layout: 'labelled' });
  });

  it.each(['pdf', 'image'] satisfies ParseDoc['mediaType'][])('rejects an attached room label in %s observations', (mediaType) => {
    const doc = { ...receipt(['结账单', '实付:240.00', '房号 101']), mediaType };
    expect(dispatch(doc, LAYOUTS).outcome).toBe('unrecognised');
  });

  it.each(['入住日期', '离店日期', '房号'])('rejects %s on the second page', (anchor) => {
    const doc = receipt(['结账单', '实付:240.00', anchor]);
    const observations = doc.observations.map((observation, index) => index === 2 ? { ...observation, page: 2, id: 'p2.0' } : observation);
    expect(dispatch({ ...doc, pageCount: 2, observations }, LAYOUTS).outcome).toBe('unrecognised');
  });

  it('rejects a hotel anchor split across observations beyond the field span limit', () => {
    const doc = receipt(['结账单', '实付:240.00']);
    const text = '备注:' + '说明'.repeat(40) + ',入住日期:2026-08-18';
    const observations = [...doc.observations, ...Array.from(text, (raw, index) => ({ id: 'p2.' + index, page: 2, x: 40 + index * 8, y: 750, width: 8, height: 12, text: raw, raw }))];
    expect(dispatch({ ...doc, pageCount: 2, observations }, LAYOUTS).outcome).toBe('unrecognised');
  });

  it('rejects a split hotel label after another field on the same row', () => {
    const doc = receipt(['结账单', '实付:240.00']);
    const observations = [...doc.observations, ...['桌号:8', '房', '号', ':101'].map((raw, index) => ({ id: 'p1.field.' + index, page: 1, x: 40 + index * 40, y: 700, width: 40, height: 12, text: raw, raw }))];
    expect(dispatch({ ...doc, observations }, LAYOUTS).outcome).toBe('unrecognised');
  });

  it('does not read an impossible optional date as a calendar date', () => {
    const outcome = dispatch(receipt(['餐饮小票', '日期：2026-02-30', '实付：240.00']), LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', missing: [] });
    if (outcome.outcome !== 'recognised') throw new Error('receipt not recognised');
    expect(outcome.candidates.map((candidate) => candidate.key)).toEqual(['paidAmount']);
  });

  it.each(['入住日期', '到店日期', '抵店日期', '离店日期', '退房日期', '房号', '房间号'])('rejects the hotel anchor %s', (anchor) => {
    expect(dispatch(receipt(['结账单', '实付：240.00', `${anchor}：2026-08-18`]), LAYOUTS).outcome).toBe('unrecognised');
  });
});
