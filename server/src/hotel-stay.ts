// Hotel stays (#185): a 住宿 (accommodation) invoice and a 酒店结账单 (hotel folio) prove one continuous stay, so they
// form one expense event dated from the folio's check-in to its check-out (kernel `events.mjs` single_stay). The
// invoice's issue date is not the stay date.
//
// Pairing is on amounts only: the folio's 消费合计 must equal the invoice's 价税合计 to the cent, one-to-one. Anything
// else stays unpaired (the invoice keeps its own event, the folio stays ungrouped reference material).

export type StayVoucher = { materialId: string; values: Readonly<Record<string, string>> };

export type Stay = { invoiceId: string; folioId: string; checkIn: string; checkOut: string; note: string };

const DAY_MS = 86_400_000;
const nightsOf = (checkIn: string, checkOut: string) => Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);

// `invoices`: recognised, clean accommodation invoices; `folios`: recognised, clean hotel folios.
export function pairHotelStays(invoices: readonly StayVoucher[], folios: readonly StayVoucher[]): Stay[] {
  const stays: Stay[] = [];
  for (const folio of folios) {
    const { folioTotal, checkIn, checkOut } = folio.values;
    if (!folioTotal || !checkIn || !checkOut) continue;
    const matches = invoices.filter((invoice) => invoice.values['totalAmount'] === folioTotal);
    const [invoice] = matches;
    if (!invoice || matches.length > 1) continue;
    if (folios.filter((other) => other.values['folioTotal'] === folioTotal).length > 1) continue;
    stays.push({
      invoiceId: invoice.materialId,
      folioId: folio.materialId,
      checkIn,
      checkOut,
      note: `住宿发票与酒店结账单配对：金额 ${folioTotal} 一致；入住 ${checkIn}，离店 ${checkOut}，共 ${nightsOf(checkIn, checkOut)} 晚`,
    });
  }
  return stays;
}
