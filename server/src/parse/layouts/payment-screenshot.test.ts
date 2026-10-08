import { describe, expect, it, vi } from 'vitest';
import { KINDS } from '../../kind-policy';
import { dispatch, type Recognised } from '../dispatch';
import type { ParseDoc } from '../doc';
import { caseDoc } from '../testing/snapshot-cases';
import { LAYOUTS } from '.';
import { paymentScreenshot } from './payment-screenshot';

// ADR-0032: one rule for every payment app's success page. The QA screenshots (Alipay, WeChat Pay) are read from their
// snapshot cases (`../snapshots/payment-screenshot-day*`, which also score every value); the edits below take one
// anchor away at a time.

vi.mock('unpdf', () => {
  throw new Error('a layout test loaded pdfjs: read the document from a snapshot case');
});
vi.mock('../ocr', () => {
  throw new Error('a layout test loaded OCR: read the document from a snapshot case');
});

const alipay = () => caseDoc('payment-screenshot-day1');
const wechat = () => caseDoc('payment-screenshot-day2');

function recognised(doc: ParseDoc): Recognised {
  const outcome = dispatch(doc, LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));
const edit = (doc: ParseDoc, from: string, to: string | null): ParseDoc => {
  if (!doc.observations.some((o) => o.text === from)) throw new Error(`no box reads ${from}`);
  return { ...doc, observations: doc.observations.flatMap((o) => (o.text !== from ? [o] : to === null ? [] : [{ ...o, text: to, raw: to }])) };
};

describe('payment_screenshot/labelled', () => {
  it('recognises the Alipay and the WeChat Pay success page with the one rule', () => {
    expect(recognised(alipay()).layout).toBe('labelled');
    expect(recognised(wechat()).layout).toBe('labelled');
    expect(recognised(alipay()).kind).toBe('payment_screenshot');
  });

  it.each([
    ['the success word', '交易成功'],
    ['the payment-time label', '支付时间'],
    ['the negative amount', '-178.48'],
  ])('needs %s', (_, anchor) => {
    expect(paymentScreenshot.recognise(edit(alipay(), anchor, null))).toBe(false);
  });

  it('does not take a refund, which prints a positive amount', () => {
    const refund = edit(edit(alipay(), '-178.48', '+178.48'), '交易成功', '退款成功');
    expect(paymentScreenshot.recognise(refund)).toBe(false);
  });

  it('reads the amount positive, with a typographic minus or a ¥ sign', () => {
    expect(values(recognised(edit(alipay(), '-178.48', '−178.48')))['amount']).toBe('178.48');
    expect(values(recognised(edit(alipay(), '-178.48', '-¥1,178.48')))['amount']).toBe('1178.48');
  });

  it('takes the tallest negative amount, not a smaller discount line', () => {
    const doc = alipay();
    const headline = doc.observations.find((o) => o.text === '-178.48');
    if (!headline) throw new Error('no amount box');
    const discount = { ...headline, id: 'p1.discount', y: headline.y - 400, height: headline.height / 2, text: '-5.00', raw: '-5.00' };
    expect(values(recognised({ ...doc, observations: [...doc.observations, discount] }))['amount']).toBe('178.48');
  });

  it('reads a payment time printed as a date alone, and leaves the time out', () => {
    const doc = edit(wechat(), '2026年9月17日08:46:16', '2026年9月17日');
    expect(values(recognised(doc))).toMatchObject({ payDate: '2026-09-17' });
    expect(values(recognised(doc))['payTime']).toBeUndefined();
  });

  it('leaves the date missing when the payment time is not a calendar date', () => {
    const outcome = recognised(edit(alipay(), '2026-09-16 13:01:12', '2026-02-30 13:01:12'));
    expect(outcome.missing).toContain('payDate');
  });

  it('takes the payee from 商户全称 when printed, else the name above the amount', () => {
    expect(values(recognised(wechat()))['payee']).toBe('示例某某酒店管理有限公司');
    expect(values(recognised(alipay()))['payee']).toBe('高德酒店');
  });

  it('reads 交易单号 or 订单号, never a merchant-side number', () => {
    expect(values(recognised(wechat()))['transactionNumber']).toBe('4200000000202609170000000003');
    const noOrder = edit(alipay(), '订单号', null);
    expect(values(recognised(noOrder))['transactionNumber']).toBeUndefined();
  });

  it('is reference material: it forms no line and has no invoice identity', () => {
    const spec = KINDS.payment_screenshot;
    const read = values(recognised(alipay()));
    expect(spec.role).toBe('reference');
    expect(spec.event(read)).toBeNull();
    expect(spec.identity).toBeUndefined();
  });

  it('checks a hand-filled amount and time', () => {
    const check = KINDS.payment_screenshot.check;
    expect(check?.({ amount: '178.48', payDate: '2026-09-16', payTime: '13:01' })).toBeNull();
    expect(check?.({ amount: '0.00', payDate: '2026-09-16' })).toBe('支付金额应大于 0。');
    expect(check?.({ amount: '178.48', payDate: '2026-09-16', payTime: '1点' })).toMatch(/^支付时间应写成/);
  });
});
