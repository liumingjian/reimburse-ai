import { DINING_COPY, DINING_ITEM_CODES, type PendingItem } from '@baox/contract';
import { EXCLUDE, settle, type StoredAnswers } from './pending/answers';

// The 餐饮 (dining) check at 盘点 (inventory), #356. A dining invoice derives 招待费 (hospitality), and the company's
// evidence rule says a meal is never claimed on the invoice alone: its 餐饮小票 must back it. No material kind reads a
// slip yet, so every dining invoice carries a blocking 待确认项 「缺少餐饮小票」. Unlike the 住宿 trio there is no
// 确认没有; the only answer is exclusion.

export type DiningVoucher = { materialId: string; fileName: string; values: Readonly<Record<string, string>> };

// `invoices`: the dining invoices that formed a 招待费 line. The derived (and settled) items by the invoice they are
// raised on.
export function checkDining(invoices: readonly DiningVoucher[], answers: StoredAnswers): Map<string, PendingItem[]> {
  const items = new Map<string, PendingItem[]>();
  for (const invoice of invoices) {
    const copy = DINING_COPY.receiptMissing;
    const item: PendingItem = {
      itemId: `${DINING_ITEM_CODES.receiptMissing}.${invoice.materialId}`,
      materialId: invoice.materialId,
      title: copy.title(invoice.fileName),
      why: copy.why(invoice.values['totalAmount']),
      kind: 'choice',
      resolver: '要你处理',
      fields: [],
      choices: [EXCLUDE],
      allocation: null,
      screenshotGroup: null,
      manualKinds: [],
      status: 'open',
      answer: null,
    };
    items.set(invoice.materialId, [settle(item, answers)]);
  }
  return items;
}
