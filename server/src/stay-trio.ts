import { STAY_TRIO_CONFIRM_NONE, STAY_TRIO_COPY, STAY_TRIO_ITEM_CODES, type PendingItem, type StayTrioElement } from '@baox/contract';
import type { Stay, StayVoucher } from './hotel-stay';
import { chosen, EXCLUDE_CHOICE, settle, type StoredAnswers } from './pending/answers';

// The 住宿 (accommodation) trio check at 盘点 (inventory), #213. 住宿 reimbursement takes a 发票 (invoice), a 结账单
// (hotel folio) and a 支付截图 (payment screenshot); this module says, per stay, which of them are there and raises
// one 待确认项 per missing element while the filer can still fetch it.
//
// Nothing is inferred (ADR-0017). An invoice is a clean 住宿 invoice that formed its own event; a folio is present
// only when a material resolved to `hotel_folio` is paired with that invoice (`pairHotelStays`, amounts to the
// cent); a screenshot is present only when one is stored for that invoice. A folio no invoice pairs with is a stay
// missing its invoice; it has no voucher, so no screenshot is asked of it.
//
// A missing element is answered by supplying it (the item is then not derived at all) or by the choice
// `STAY_TRIO_CONFIRM_NONE`, which records the absence. That record is what the print stage reads.

export type TrioPart = {
  present: boolean;
  // A stored 确认没有 answer stands for this element, whether or not the element is present right now: it is what
  // keeps the item settled if a present element goes away.
  noneConfirmed: boolean;
};

export type StayTrio = {
  // The invoice's material id; null for a folio without an invoice.
  invoiceId: string | null;
  folioId: string | null;
  invoice: TrioPart;
  folio: TrioPart;
  // null when there is no invoice to attach a screenshot to.
  screenshot: TrioPart | null;
};

export type TrioVoucher = StayVoucher & { fileName: string };

export type TrioCheck = {
  trios: StayTrio[];
  // The derived (and settled) items by the material they are raised on.
  items: ReadonlyMap<string, PendingItem[]>;
};

const EXCLUDE = { key: EXCLUDE_CHOICE, label: '排除这份材料' };

function missingItem(element: StayTrioElement, material: TrioVoucher): PendingItem {
  const copy = STAY_TRIO_COPY[element];
  const amount = element === 'invoice' ? material.values['folioTotal'] : material.values['totalAmount'];
  return {
    itemId: `${STAY_TRIO_ITEM_CODES[element]}.${material.materialId}`,
    materialId: material.materialId,
    title: copy.title(material.fileName),
    why: copy.why(amount),
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: [{ key: STAY_TRIO_CONFIRM_NONE, label: copy.confirmNone }, EXCLUDE],
    allocation: null,
    status: 'open',
    answer: null,
  };
}

// `invoices`: clean 住宿 invoices that formed an event; `folios`: clean hotel folios; `stays`: their pairing;
// `screenshots`: invoice material ids with a current payment screenshot.
export function checkStayTrios(invoices: readonly TrioVoucher[], folios: readonly TrioVoucher[], stays: readonly Stay[], screenshots: ReadonlySet<string>, answers: StoredAnswers): TrioCheck {
  const items = new Map<string, PendingItem[]>();
  const trios: StayTrio[] = [];
  // Settles the element's item against the stored answers; the item is raised only when the element is missing.
  const part = (element: StayTrioElement, material: TrioVoucher, present: boolean): TrioPart => {
    const settled = settle(missingItem(element, material), answers);
    if (!present) items.set(material.materialId, [...(items.get(material.materialId) ?? []), settled]);
    return { present, noneConfirmed: chosen(settled) === STAY_TRIO_CONFIRM_NONE };
  };
  const pairedFolio = new Map(stays.map((stay) => [stay.invoiceId, stay.folioId]));
  const pairedInvoice = new Set(stays.map((stay) => stay.folioId));

  for (const invoice of invoices) {
    const folioId = pairedFolio.get(invoice.materialId) ?? null;
    trios.push({
      invoiceId: invoice.materialId,
      folioId,
      invoice: { present: true, noneConfirmed: false },
      folio: part('folio', invoice, folioId !== null),
      screenshot: part('screenshot', invoice, screenshots.has(invoice.materialId)),
    });
  }
  for (const folio of folios) {
    if (pairedInvoice.has(folio.materialId)) continue;
    trios.push({ invoiceId: null, folioId: folio.materialId, invoice: part('invoice', folio, false), folio: { present: true, noneConfirmed: false }, screenshot: null });
  }
  return { trios, items };
}
