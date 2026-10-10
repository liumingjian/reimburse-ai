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

const columnReceipt = (runs: { text: string; x: number; y?: number; width?: number; height?: number }[]): ParseDoc => {
  const doc = receipt(['结账单']);
  return { ...doc, observations: [...doc.observations, ...runs.map(({ text, x, y = 600, width = 80, height = 20 }, index) => ({ id: `amount.${index}`, page: 1, x, y, width, height, text: text.normalize('NFKC'), raw: text }))] };
};

function paid(doc: ParseDoc) {
  const outcome = dispatch(doc, LAYOUTS);
  expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt' });
  if (outcome.outcome !== 'recognised') throw new Error('receipt not recognised');
  return outcome.candidates.find((candidate) => candidate.key === 'paidAmount');
}

it.each(['实收金额', '实收金额:', '实收金额,', '实付金额：', '应付金额'])('reads %s across columns with aligned centers and unequal baselines (#370)', (label) => {
  const candidate = paid(columnReceipt([{ text: label, x: 40, height: 20 }, { text: '530.00', x: 820, y: 595.5, height: 29 }]));
  expect(candidate?.value).toBe('530.00');
  expect(candidate?.refs.flatMap((ref) => ref.observationIds)).toEqual(['amount.0', 'amount.1']);
});

it('joins a split paid label and a complete split currency value across columns', () => {
  const candidate = paid(columnReceipt([{ text: '实收', x: 40, width: 40 }, { text: '金额', x: 80, width: 40 }, { text: ':', x: 120, width: 10 }, { text: '¥', x: 700, width: 15 }, { text: '530', x: 715, width: 40 }, { text: '.00', x: 755, width: 30 }]));
  expect(candidate?.value).toBe('530.00');
  expect(candidate?.refs.flatMap((ref) => ref.observationIds)).toEqual(['amount.0', 'amount.1', 'amount.2', 'amount.3', 'amount.4', 'amount.5']);
});

it.each(['实收金额:模糊', '实收金额:'])('never falls back from present unreadable %s to a total', (label) => {
  expect(paid(receipt(['结账单', label, '合计:600.00']))).toBeUndefined();
});

it('does not replace malformed inline money with a distant readable amount', () => {
  expect(paid(columnReceipt([{ text: '实收金额:模糊', x: 40 }, { text: '530.00', x: 820 }]))).toBeUndefined();
});

it.each(['530.00', '540.00'])('refuses two separate aligned money blocks even when the second is %s', (second) => {
  expect(paid(columnReceipt([{ text: '实收金额:', x: 40 }, { text: '530.00', x: 500 }, { text: second, x: 820 }]))).toBeUndefined();
});

it('ignores a neighboring amount row without chaining center tolerances', () => {
  expect(paid(columnReceipt([{ text: '实收金额:', x: 40 }, { text: '530.00', x: 820 }, { text: '600.00', x: 820, y: 612 }]))?.value).toBe('530.00');
});

it.each(['累计实收金额:530.00', '实收金额说明', '商户:实收金额'])('does not treat embedded %s as a paid label', (label) => {
  expect(dispatch(receipt(['结账单', label]), LAYOUTS).outcome).toBe('unrecognised');
});

it.each(['实收金额:', '实收金额:540.00'])('requires every repeated paid occurrence to agree and be readable', (second) => {
  expect(paid(receipt(['结账单', '实收金额:530.00', second, '合计:600.00']))).toBeUndefined();
});

it('accepts consistent readable duplicate paid labels with both evidence references', () => {
  const candidate = paid(receipt(['结账单', '实收金额:530.00', '实收:530.00']));
  expect(candidate?.value).toBe('530.00');
  expect(candidate?.refs.flatMap((ref) => ref.observationIds)).toEqual(['p1.1', 'p1.2']);
});

it('keeps a complete paid label present when an adjacent value block is unreadable', () => {
  const doc = columnReceipt([{ text: '实收金额', x: 40, width: 80 }, { text: '模糊', x: 125 }, { text: '合计:600.00', x: 40, y: 550 }]);
  expect(paid(doc)).toBeUndefined();
});

it('stops amount search at another field label', () => {
  const doc = columnReceipt([{ text: '实收金额', x: 40 }, { text: '桌号:', x: 500 }, { text: '530.00', x: 820 }]);
  expect(paid(doc)).toBeUndefined();
});

it('rejects trailing garbage on a split delimiter-free money value', () => {
  expect(paid(columnReceipt([{ text: '实收金额', x: 40 }, { text: '530.00', x: 120, width: 80 }, { text: '错', x: 200 }]))).toBeUndefined();
});

it('reads an explicit paid label beside a complete field ahead of the total (#370)', () => {
  const candidate = paid(columnReceipt([
    { text: '桌号:8', x: 40 },
    { text: '实收:530.00', x: 125, width: 150 },
    { text: '合计:600.00', x: 40, y: 550 },
  ]));
  expect(candidate?.value).toBe('530.00');
  expect(candidate?.refs.flatMap((ref) => ref.observationIds)).toEqual(['amount.1']);
});

it.each(['实收:', '实收:模糊', '实收:540.00'])('retains an adjacent %s duplicate when deciding paid ambiguity (#370)', (second) => {
  const doc = columnReceipt([
    { text: '实收:530.00', x: 40, y: 650 },
    { text: '桌号:8', x: 40 },
    { text: second, x: 125, width: 150 },
    { text: '合计:600.00', x: 40, y: 550 },
  ]);
  expect(paid(doc)).toBeUndefined();
});

it.each(['累计', '商户:', '备注:'])('rejects a paid label embedded after the adjacent prefix %s', (prefix) => {
  const doc = columnReceipt([
    { text: prefix, x: 40 },
    { text: '实收金额:530.00', x: 125, width: 180 },
  ]);
  expect(dispatch(doc, LAYOUTS).outcome).toBe('unrecognised');
});
