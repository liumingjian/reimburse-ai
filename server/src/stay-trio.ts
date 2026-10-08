import { confirmsNone, PAYMENT_COPY, PAYMENT_SCREENSHOT_ERRORS, STAY_TRIO_CONFIRM_NONE, STAY_TRIO_CONFIRM_PAID, STAY_TRIO_COPY, stayTrioElementOf, stayTrioItemId, stayTrioMaterialOf, type PendingAnswer, type PendingItem, type StayTrioElement } from '@baox/contract';
import type { Stay, StayVoucher } from './hotel-stay';
import { money, slotCents } from './money-date';
import { CATEGORIES } from './parse/slots';
import { chosen, EXCLUDE, settle, type AnswerCheck, type StoredAnswers } from './pending/answers';

// The 住宿 (accommodation) trio check at 盘点 (inventory), #213. 住宿 reimbursement takes a 发票 (invoice), a 结账单
// (hotel folio) and a 支付截图 (payment screenshot); this module says, per stay, which of them are there and raises
// one 待确认项 per missing element while the filer can still fetch it.
//
// Nothing about the trio is inferred (#213). An invoice is a clean 住宿 invoice that formed its own event; a folio is present
// only when a material resolved to `hotel_folio` is paired with that invoice (`pairHotelStays`, amounts to the
// cent); a screenshot is present only when one is stored for that invoice. A folio no invoice pairs with is a stay
// missing its invoice; it has no voucher, so no screenshot is asked of it.
//
// A missing invoice or folio is answered by supplying it (the item is then not derived at all) or by the choice
// `STAY_TRIO_CONFIRM_NONE`, which records the absence. That record is what the print stage reads.
//
// The 支付截图 is a group per invoice (#331), so its item is derived for every invoice, supplied or not: the filer may
// add several over several visits, and the item stays open until the group is declared complete (「已传齐」) or the
// absence is confirmed. A 确认没有 given before a screenshot was uploaded is superseded for good (#332): emptying the group
// again leaves the item open, and the filer may choose 确认没有 again.
//
// 支付截图 materials (ADR-0032) carry their amounts, so an invoice whose screenshots are all materials is checked by
// sum instead: at least its 价税合计 settles the item by itself; less keeps it open with 「已传齐」 to confirm that is
// all. Screenshots stored the #331 way have no amount; an invoice with any of them keeps the group rule above.

export type TrioPart = {
  present: boolean;
  // A stored 确认没有 answer stands for this element. For a folio it stands whether or not the folio is present right
  // now (it keeps the item settled if the folio goes away); for a screenshot only while the group is empty (#332).
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

// An invoice's 支付截图 group: how many it holds and whether it was declared complete (「已传齐」, never while empty).
export type ScreenshotGroup = { count: number; complete: boolean };
const NO_GROUP: ScreenshotGroup = { count: 0, complete: false };

export type TrioCheck = {
  trios: StayTrio[];
  // The derived (and settled) items by the material they are raised on.
  items: ReadonlyMap<string, PendingItem[]>;
  // What an answer to an item must also pass, by item id.
  checks: ReadonlyMap<string, AnswerCheck>;
};

const PRESENT: TrioPart = { present: true, noneConfirmed: false };

// Which vouchers the trio covers: those the print stage composes as a 住宿 page. A page takes its category from the
// voucher's first line in business order (`planPages`), so a voucher is a 住宿 voucher exactly when that line is 住宿.
// `lines` must be in that order.
export function stayVoucherIds(lines: readonly { voucherMaterialId: string; category: { code: string } }[]): Set<string> {
  const first = new Map<string, string>();
  for (const line of lines) if (!first.has(line.voucherMaterialId)) first.set(line.voucherMaterialId, line.category.code);
  return new Set([...first].flatMap(([id, code]) => (code === CATEGORIES.accommodation.code ? [id] : [])));
}

function missingItem(element: StayTrioElement, material: TrioVoucher): PendingItem {
  const copy = STAY_TRIO_COPY[element];
  const amount = element === 'invoice' ? material.values['folioTotal'] : material.values['totalAmount'];
  return {
    itemId: stayTrioItemId(element, material.materialId),
    materialId: material.materialId,
    title: copy.title(material.fileName),
    why: copy.why(amount),
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: [{ key: STAY_TRIO_CONFIRM_NONE, label: copy.confirmNone }, EXCLUDE],
    allocation: null,
    screenshotGroup: null,
    manualKinds: [],
    status: 'open',
    answer: null,
  };
}

// Whether a stored answer (given at `revision`) is a 确认没有 on a screenshot item that a later upload to its invoice
// superseded. `uploads`: per invoice, the revision of its latest upload, removed since or not.
export function supersededByScreenshot(itemId: string, answer: PendingAnswer, revision: number, uploads: ReadonlyMap<string, number>): boolean {
  const invoiceId = stayTrioMaterialOf(itemId);
  if (stayTrioElementOf(itemId) !== 'screenshot' || !invoiceId || !confirmsNone(answer)) return false;
  return (uploads.get(invoiceId) ?? -Infinity) > revision;
}

// `invoices`: clean 住宿 invoices that formed an event; `folios`: clean hotel folios; `stays`: their pairing;
// `screenshots`: the invoices' 支付截图 groups (an invoice with none may be absent); `paid`: per invoice, the amounts
// (cents) of the 支付截图 materials placed with it.
export function checkStayTrios(invoices: readonly TrioVoucher[], folios: readonly TrioVoucher[], stays: readonly Stay[], screenshots: ReadonlyMap<string, ScreenshotGroup>, paid: ReadonlyMap<string, readonly number[]>, answers: StoredAnswers): TrioCheck {
  const items = new Map<string, PendingItem[]>();
  const checks = new Map<string, AnswerCheck>();
  const trios: StayTrio[] = [];
  const raise = (material: TrioVoucher, item: PendingItem) => items.set(material.materialId, [...(items.get(material.materialId) ?? []), item]);
  // Settles the element's item against the stored answers; the item is raised only when the element is missing.
  const part = (element: StayTrioElement, material: TrioVoucher, present: boolean): TrioPart => {
    const settled = settle(missingItem(element, material), answers);
    if (!present) raise(material, settled);
    return { present, noneConfirmed: chosen(settled) === STAY_TRIO_CONFIRM_NONE };
  };
  // The screenshot item is always raised; a stored answer settles it, and so does a complete group. A screenshot
  // supersedes 确认没有 (#332): while the group is not empty that choice does not fit, so a stored one leaves the item
  // open until 「已传齐」 and a new one is refused.
  const screenshotPart = (invoice: TrioVoucher): TrioPart => {
    const group = screenshots.get(invoice.materialId) ?? NO_GROUP;
    const amounts = paid.get(invoice.materialId) ?? [];
    const count = group.count + amounts.length;
    const sum = amounts.reduce((acc, value) => acc + value, 0);
    const total = slotCents(invoice.values['totalAmount']);
    const byAmount = group.count === 0 && amounts.length > 0 && total !== null;
    const owed = byAmount && total !== null && sum < total ? total : null;
    const item = missingItem('screenshot', invoice);
    const asked = owed !== null
      ? { ...item, title: PAYMENT_COPY.shortfallTitle(invoice.fileName), why: PAYMENT_COPY.shortfallWhy(money(sum), money(owed), money(owed - sum)), choices: [{ key: STAY_TRIO_CONFIRM_PAID, label: PAYMENT_COPY.confirmPaid }, EXCLUDE] }
      : item;
    const check: AnswerCheck = (answer) => (count > 0 && confirmsNone(answer) ? PAYMENT_SCREENSHOT_ERRORS.noneWithScreenshots : null);
    const settled = settle(asked, answers, check);
    const done = group.complete || (byAmount && owed === null);
    raise(invoice, settled.status === 'open' && done ? { ...settled, status: 'resolved' } : settled);
    checks.set(settled.itemId, check);
    return { present: count > 0, noneConfirmed: chosen(settled) === STAY_TRIO_CONFIRM_NONE };
  };
  const pairedFolio = new Map(stays.map((stay) => [stay.invoiceId, stay.folioId]));
  const pairedInvoice = new Set(stays.map((stay) => stay.folioId));

  for (const invoice of invoices) {
    const folioId = pairedFolio.get(invoice.materialId) ?? null;
    trios.push({
      invoiceId: invoice.materialId,
      folioId,
      invoice: PRESENT,
      folio: part('folio', invoice, folioId !== null),
      screenshot: screenshotPart(invoice),
    });
  }
  for (const folio of folios) {
    if (pairedInvoice.has(folio.materialId)) continue;
    trios.push({ invoiceId: null, folioId: folio.materialId, invoice: part('invoice', folio, false), folio: PRESENT, screenshot: null });
  }
  return { trios, items, checks };
}
