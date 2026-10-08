import { DINING_COPY, DINING_ITEM_CODES, type PendingItem } from '@baox/contract';
import { pairByAmount } from './amount-pairing';
import { EXCLUDE, settle, type StoredAnswers } from './pending/answers';

// The 餐饮 (dining) check at 盘点 (inventory), #356. A dining invoice derives 招待费 (hospitality), and the company's
// evidence rule says a meal is never claimed on the invoice alone: its 餐饮小票 must back it. An invoice pairs one to
// one with a slip by the shared amount rule (`amount-pairing.ts`): the invoice's 价税合计 against the slip's amount
// actually paid, to the cent. Merchant and date are not compared. A dining invoice left unpaired carries a blocking
// 待确认项 「缺少餐饮小票」, answered by supplying the slip (an upload and a new inventory) or by exclusion; unlike the
// 住宿 trio there is no 确认没有.

export type DiningVoucher = { materialId: string; fileName: string; values: Readonly<Record<string, string>> };

export type Meal = { invoiceId: string; receiptId: string; note: string };

export type DiningCheck = {
  meals: Meal[];
  // The derived (and settled) items by the invoice they are raised on.
  items: Map<string, PendingItem[]>;
};

// `invoices`: the dining invoices that formed a 招待费 line; `receipts`: recognised, clean 餐饮小票.
export function checkDining(invoices: readonly DiningVoucher[], receipts: readonly DiningVoucher[], answers: StoredAnswers): DiningCheck {
  const meals = pairByAmount(
    invoices.map((invoice) => ({ materialId: invoice.materialId, amount: invoice.values['totalAmount'] })),
    receipts.map((receipt) => ({ materialId: receipt.materialId, amount: receipt.values['paidAmount'] })),
  ).map(({ voucherId, referenceId, amount }) => ({ invoiceId: voucherId, receiptId: referenceId, note: `餐饮发票与餐饮小票配对：金额 ${amount} 一致` }));
  const paired = new Set(meals.map((meal) => meal.invoiceId));
  const items = new Map<string, PendingItem[]>();
  for (const invoice of invoices) {
    if (paired.has(invoice.materialId)) continue;
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
  return { meals, items };
}
