import { cents, money } from '../../money-date';
import { compact, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type Layout } from '../layout';
import { dateOf, labelReader, ref, type Read } from './labels';
import { STAY_LABELS } from './labelled';

// `dining_receipt/labelled`: a restaurant's 餐饮小票 (itemised checkout slip) of any restaurant, read through its field
// labels, from a PDF text layer or a photo (#356). A slip is reference material: it backs a dining invoice, paired by
// the amount actually paid (`../../dining.ts`), and is never an invoice itself.
//
// Hard anchors, all three: a receipt-style title; an amount under a paid or total label; and none of the labels of a
// hotel stay. A hotel 结账单 shares the title and often a total, but always prints its stay, so it is refused here and
// read by `hotel_folio/labelled`; that layout in turn needs stay dates no restaurant prints, so the two never both
// match one document.
//
// The paid amount is the one under a paid label (实付, 实收, 应付). A slip that prints none of them states its 合计 as
// what was paid, unless it also prints a discount: then the paid amount is missing, never worked out from the total and
// the discount (ADR-0017).

const KIND = 'dining_receipt';
const NAME = 'labelled';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
const LABEL = '餐饮小票';

// The titles a restaurant prints on its slip, matched anywhere in a text run (`某某餐厅结账单`, `结账单（顾客联）`).
const TITLES = ['结账单', '消费小票', '消费清单', '顾客联'] as const;

const LABELS = {
  merchantName: ['门店名称', '门店', '商户名称', '商户', '店名', '餐厅'],
  dateTime: ['结账时间', '消费时间', '下单时间', '日期', '时间'],
  paidAmount: ['实付金额', '实付', '实收金额', '实收', '应付金额', '应付'],
  total: ['消费合计', '合计', '原价', '消费金额', '总计'],
  discount: ['优惠金额', '优惠', '折扣金额', '折扣'],
} as const satisfies Record<string, readonly string[]>;
// The total labels that also anchor recognition (`合计`); 原价 or 总计 alone do not make a slip.
const TOTAL_ANCHORS: readonly string[] = ['消费合计', '合计'];

const { carries, labelOf, valueOf } = labelReader(LABELS);

// A date with an optional clock time after it: `2026-08-14 12:36` reads as `2026-08-1412:36` once compacted.
const DATE_TIME = /^(.+?)((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/;

const hasTitle = (o: TextObservation) => TITLES.some((title) => compact(o.text).includes(title));
const isStay = (o: TextObservation) => STAY_LABELS.some((label) => compact(o.text).includes(label));
const hasAmount = (o: TextObservation) => [...LABELS.paidAmount, ...TOTAL_ANCHORS].some((label) => carries(o, label));

export const diningReceipt: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: LABEL,

  recognise(doc) {
    const { observations } = doc;
    return observations.some(hasTitle) && observations.some(hasAmount) && !observations.some(isStay);
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const add = (key: string, value: string | null | undefined, observations: TextObservation[]) => {
      if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(observations) });
    };
    const amountOf = (value: Read | null) => (value ? cents(value.text.replace(/[¥元]/g, '')) : null);

    const merchant = valueOf(doc, 'merchantName');
    if (merchant) add('merchantName', merchant.raw, merchant.observations);
    const when = valueOf(doc, 'dateTime');
    const parts = when ? DATE_TIME.exec(when.text) : null;
    if (when && parts) {
      add('date', dateOf(parts[1] ?? ''), when.observations);
      add('time', parts[2], when.observations);
    }

    const amount = (key: string, value: Read | null, read: number | null = amountOf(value)) => {
      if (value && read !== null) add(key, money(read), value.observations);
    };
    const paid = valueOf(doc, 'paidAmount');
    const total = valueOf(doc, 'total');
    const discount = valueOf(doc, 'discount');
    // A discount is printed as `-28.00` or `28.00`; it is kept as the amount taken off.
    const off = amountOf(discount);
    amount('discount', discount, off === null ? null : Math.abs(off));
    amount('paidAmount', paid);
    // With no paid label and no discount, the 合计 is what was paid; otherwise it is the total before the discount.
    const totalIsPaid = !paid && !discount && TOTAL_ANCHORS.includes(labelOf(doc, 'total')?.label ?? '');
    amount(totalIsPaid ? 'paidAmount' : 'originalTotal', total);

    return { kindLabel: LABEL, candidates, findings: [] };
  },
};
