import { daysBetween } from './money-date';
import { pairInvoiceReferences } from './invoice-reference';

// Hotel stays (#185): a 住宿 (accommodation) invoice and a 酒店结账单 (hotel folio) prove one continuous stay, so they
// form one expense event dated from the folio's check-in to its check-out (kernel `events.mjs` single_stay). The
// invoice's issue date is not the stay date.
//
// Pairing is on amounts only: the folio's 消费合计 must equal the invoice's 价税合计 to the cent, one-to-one. Anything
// else stays unpaired (the invoice keeps its own event, the folio stays ungrouped reference material).

export type StayVoucher = { materialId: string; values: Readonly<Record<string, string>> };

export type Stay = { invoiceId: string; folioId: string; checkIn: string; checkOut: string; note: string };

// `invoices`: recognised, clean accommodation invoices; `folios`: recognised, clean hotel folios.
export function pairHotelStays(invoices: readonly StayVoucher[], folios: readonly StayVoucher[]): Stay[] {
  const stays: Stay[] = [];
  const pairs = pairInvoiceReferences({
    invoices,
    references: folios,
    invoiceAmount: (invoice) => invoice.values['totalAmount'],
    referenceAmount: (folio) => folio.values['folioTotal'],
  });
  for (const { invoice, reference: folio } of pairs) {
    const { folioTotal, checkIn, checkOut } = folio.values;
    if (!folioTotal || !checkIn || !checkOut) continue;
    stays.push({
      invoiceId: invoice.materialId,
      folioId: folio.materialId,
      checkIn,
      checkOut,
      note: `住宿发票与酒店结账单配对：金额 ${folioTotal} 一致；入住 ${checkIn}，离店 ${checkOut}，共 ${daysBetween(checkIn, checkOut)} 晚`,
    });
  }
  return stays;
}
