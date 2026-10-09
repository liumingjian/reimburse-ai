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
