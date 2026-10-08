import { pairByAmount } from './amount-pairing';
import { daysBetween } from './money-date';

// Hotel stays (#185): a 住宿 (accommodation) invoice and a 酒店结账单 (hotel folio) prove one continuous stay, so they
// form one expense event dated from the folio's check-in to its check-out (kernel `events.mjs` single_stay). The
// invoice's issue date is not the stay date.
//
// Pairing is the shared one-to-one amount rule (`amount-pairing.ts`): the folio's 消费合计 against the invoice's
// 价税合计. A folio also needs its check-in and check-out to form a stay; one without them still claims its amount, so
// another folio of the same total does not pair either. Anything else stays unpaired (the invoice keeps its own
// event, the folio stays ungrouped reference material).

export type StayVoucher = { materialId: string; values: Readonly<Record<string, string>> };

export type Stay = { invoiceId: string; folioId: string; checkIn: string; checkOut: string; note: string };

// `invoices`: recognised, clean accommodation invoices; `folios`: recognised, clean hotel folios.
export function pairHotelStays(invoices: readonly StayVoucher[], folios: readonly StayVoucher[]): Stay[] {
  const folioValues = new Map(folios.map((folio) => [folio.materialId, folio.values]));
  const pairs = pairByAmount(
    invoices.map((invoice) => ({ materialId: invoice.materialId, amount: invoice.values['totalAmount'] })),
    folios.map((folio) => ({ materialId: folio.materialId, amount: folio.values['folioTotal'] })),
  );
  return pairs.flatMap(({ voucherId, referenceId, amount }) => {
    const { checkIn, checkOut } = folioValues.get(referenceId) ?? {};
    if (!checkIn || !checkOut) return [];
    return [
      {
        invoiceId: voucherId,
        folioId: referenceId,
        checkIn,
        checkOut,
        note: `住宿发票与酒店结账单配对：金额 ${amount} 一致；入住 ${checkIn}，离店 ${checkOut}，共 ${daysBetween(checkIn, checkOut)} 晚`,
      },
    ];
  });
}
