import { fieldAnswer, confirmsNone, PAYMENT_COPY, PAYMENT_SCREENSHOT_ERRORS, STAY_TRIO_CONFIRM_NONE, STAY_TRIO_CONFIRM_PAID, STAY_TRIO_COPY, stayTrioElementOf, stayTrioItemId, stayTrioMaterialOf, type PendingAnswer, type PendingItem, type StayTrioElement } from '@baox/contract';
import type { Stay, StayVoucher } from './hotel-stay';
import { missingReference } from './pending/missing-reference';
import { money, slotCents } from './money-date';
import { CATEGORIES } from './parse/slots';
import { chosen, EXCLUDE, settle, type AnswerCheck, type StoredAnswers } from './pending/answers';

// Lodging references enrich an invoice; actual stay dates remain mandatory without a folio.
export type TrioPart = {
  present: boolean;
  // Absence is independent of the required expense details. Screenshots retain legacy absence answers.
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

export function manualStayDates(invoiceId: string, answers: StoredAnswers): { checkIn: string; checkOut: string } | null {
  const values = fieldAnswer(answers.get(stayTrioItemId('folio', invoiceId)) ?? null);
  return values['choice'] === 'manual_fill' && values['checkIn'] && values['checkOut'] && values['checkOut'] >= values['checkIn']
    ? { checkIn: values['checkIn'], checkOut: values['checkOut'] } : null;
}
export const folioAdoptionId = (stay: Stay): string => `stay_dates_conflict.${stay.folioId}.${stay.checkIn}.${stay.checkOut}`;
export function adoptedStayDates(invoiceId: string, stay: Stay | undefined, answers: StoredAnswers): { checkIn: string; checkOut: string } | null {
  const manual = manualStayDates(invoiceId, answers);
  return stay && (!manual || (stay.checkIn === manual.checkIn && stay.checkOut === manual.checkOut) || fieldAnswer(answers.get(folioAdoptionId(stay)) ?? null)['choice'] === 'adopt_folio') ? stay : manual;
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
    choices: 'confirmNone' in copy ? [{ key: STAY_TRIO_CONFIRM_NONE, label: copy.confirmNone }, EXCLUDE] : [EXCLUDE],
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
    const base = missingItem(element, material);
    const proposed = element === 'folio' ? missingReference(base, [
      { key: 'checkIn', label: '实际入住日期', required: true, format: 'date', placeholder: 'YYYY-MM-DD' },
      { key: 'checkOut', label: '实际离店日期', required: true, format: 'date', placeholder: 'YYYY-MM-DD' },
    ]) : base;
    const check: AnswerCheck = (answer) => {
      const values = fieldAnswer(answer);
      return values['choice'] === 'manual_fill' && values['checkOut']! < values['checkIn']! ? '离店日期不能早于入住日期' : null;
    };
    const settled = settle(proposed, answers, check);
    if (element === 'folio') {
      if (manualStayDates(material.materialId, answers)) settled.choices = settled.choices.filter((choice) => choice.key !== 'confirm_none');
      checks.set(settled.itemId, check);
      if (confirmsNone(settled.answer)) settled.status = 'open';
    }
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
    const done = count === 0 || group.complete || (byAmount && owed === null);
    raise(invoice, settled.status === 'open' && done ? { ...settled, status: 'resolved' } : settled);
    checks.set(settled.itemId, check);
    return { present: count > 0, noneConfirmed: chosen(settled) === STAY_TRIO_CONFIRM_NONE };
  };
  const pairedFolio = new Map(stays.map((stay) => [stay.invoiceId, stay.folioId]));
  const pairedInvoice = new Set(stays.map((stay) => stay.folioId));

  for (const invoice of invoices) {
    const folioId = pairedFolio.get(invoice.materialId) ?? null;
    const stay = stays.find((stay) => stay.invoiceId === invoice.materialId);
    const manual = manualStayDates(invoice.materialId, answers);
    if (stay && manual && (stay.checkIn !== manual.checkIn || stay.checkOut !== manual.checkOut)) {
      const folio = folios.find((folio) => folio.materialId === stay.folioId)!;
      raise(folio, settle({ ...missingItem('folio', folio), itemId: folioAdoptionId(stay),
        title: '结账单日期与手工填写的住宿日期不同',
        why: `手工填写：${manual.checkIn} 至 ${manual.checkOut}；结账单：${stay.checkIn} 至 ${stay.checkOut}`,
        choices: [{ key: 'adopt_folio', label: '采用结账单日期' }, { ...EXCLUDE, label: '忽略结账单，保留手工日期' }],
      }, answers));
    }
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
