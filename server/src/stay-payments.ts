import { PAYMENT_COPY, PAYMENT_ITEM_CODES, PAYMENT_STAY_FIELD, type PaymentAssignment, type PendingItem } from '@baox/contract';
import { money, slotCents } from './money-date';
import { compact } from './parse/doc';
import { chosen, EXCLUDE, settle, type StoredAnswers } from './pending/answers';
import { editAddress, editedValue, type Editable } from './pending/edits';

// Placing 支付截图 materials with stays (ADR-0032). Nothing here is stored: every inventory derives it again from the
// screenshots' and stays' values, so it follows a changed invoice or folio. Only the filer's choices are stored, and a
// choice always beats the derivation.
//
// A screenshot fits a stay when it was paid from 30 days before check-in (a booking paid ahead) to 1 day after
// check-out. When several fit: the nearest stay, then the one whose hotel the payee names, then the one whose invoice
// the amount fits. The payee never rules a stay out: a booking platform (高德酒店) is a normal payee. Still more than
// one, or none: the filer assigns it.

const DAY_MS = 86_400_000;
const BEFORE_CHECK_IN = 30;
const AFTER_CHECK_OUT = 1;
// A payee and a hotel name are matched by containment; a shorter common run (`酒店`) says nothing.
const NAME_MIN = 4;

export type PaymentShot = { materialId: string; fileName: string; values: Readonly<Record<string, string>> };

export type PaymentStay = {
  // The 住宿 invoice's material id.
  invoiceId: string;
  totalAmount: string;
  // The paired folio's dates; without a folio the invoice's issue date stands for check-out.
  checkIn: string | null;
  checkOut: string | null;
  issueDate: string | null;
  // The folio's hotel name and the invoice's seller, as printed.
  hotelNames: readonly string[];
};

export type Duplicate = { of: string; byNumber: boolean };

export type Placement = {
  // Screenshot → the invoice it counts for.
  assigned: ReadonlyMap<string, string>;
  // The screenshots the filer placed (an answer or 改归属).
  chosen: ReadonlySet<string>;
  // A later screenshot of a payment an earlier one already shows: it is placed nowhere until it is excluded.
  duplicates: ReadonlyMap<string, Duplicate>;
  // Screenshots no stay takes, in upload order.
  unassigned: readonly string[];
};

// What inventory shows of the placement: the items it raises, the 校验 notes, 改归属 and each screenshot's assignment.
export type PaymentCheck = {
  placement: Placement;
  // Per invoice, the amounts (cents) placed with it: what the 住宿 trio checks by sum.
  paid: ReadonlyMap<string, readonly number[]>;
  // Items by the material they are raised on: an unplaced or a duplicate screenshot.
  items: ReadonlyMap<string, PendingItem[]>;
  // 改归属, one per screenshot.
  editables: readonly Editable[];
  notes: ReadonlyMap<string, string>;
  assignments: ReadonlyMap<string, PaymentAssignment>;
};

// A stay as the filer sees it, for the choices and notes.
export type LabelledStay = PaymentStay & { label: string };

const STAY_CHOICE = 'stay:';
const item = (code: string, materialId: string, title: string, why: string, choices: PendingItem['choices']): PendingItem => ({
  itemId: `${code}.${materialId}`, materialId, title, why, kind: 'choice', resolver: '要你处理', fields: [], choices, allocation: null, screenshotGroup: null, manualKinds: [], status: 'open', answer: null,
});

// `tableGroups`: invoices holding screenshots stored the #331 way, which have no amount: their sum is not shown.
export function checkPayments(shots: readonly PaymentShot[], stays: readonly LabelledStay[], tableGroups: ReadonlySet<string>, answers: StoredAnswers): PaymentCheck {
  const stayIds = stays.map((stay) => stay.invoiceId);
  const labelOf = new Map(stays.map((stay) => [stay.invoiceId, stay.label]));
  const edits = shots.map((shot) => ({
    shot,
    editable: { address: editAddress(shot.materialId, PAYMENT_STAY_FIELD), materialId: shot.materialId, field: PAYMENT_STAY_FIELD, label: '归属住宿', editClass: 'choice', format: 'text', allowed: stayIds } satisfies Editable,
  }));
  // The filer's choice: 改归属, else the answer to the screenshot's unassigned item.
  const choices = new Map<string, string>();
  for (const { shot, editable } of edits) {
    const choice = editedValue(editable, answers.get(editable.address)) ?? chosen(settle(unassignedItem(shot, stays), answers))?.slice(STAY_CHOICE.length);
    if (choice) choices.set(shot.materialId, choice);
  }
  const placement = placePayments(shots, stays, choices);
  const paid = paidByInvoice(shots, placement);

  const items = new Map<string, PendingItem[]>();
  const notes = new Map<string, string>();
  const assignments = new Map<string, PaymentAssignment>();
  const byId = new Map(shots.map((shot) => [shot.materialId, shot]));
  for (const shot of shots) {
    const duplicate = placement.duplicates.get(shot.materialId);
    const invoiceId = placement.assigned.get(shot.materialId) ?? null;
    if (duplicate) {
      const other = byId.get(duplicate.of)?.fileName ?? '';
      items.set(shot.materialId, [settle(item(PAYMENT_ITEM_CODES.duplicate, shot.materialId, PAYMENT_COPY.duplicateTitle(shot.fileName, other), PAYMENT_COPY.duplicateWhy(duplicate.byNumber), [EXCLUDE]), answers)]);
    } else if (invoiceId === null) {
      items.set(shot.materialId, [settle(unassignedItem(shot, stays), answers)]);
    }
    notes.set(shot.materialId, invoiceId ? PAYMENT_COPY.assignedNote(labelOf.get(invoiceId) ?? '') : PAYMENT_COPY.unassignedNote);
    assignments.set(shot.materialId, { invoiceId, chosen: placement.chosen.has(shot.materialId), options: stays.map((stay) => ({ invoiceId: stay.invoiceId, label: stay.label })) });
  }
  for (const stay of stays) {
    const amounts = paid.get(stay.invoiceId);
    if (!amounts || tableGroups.has(stay.invoiceId)) continue;
    notes.set(stay.invoiceId, PAYMENT_COPY.paidNote(money(amounts.reduce((acc, value) => acc + value, 0)), stay.totalAmount));
  }
  return { placement, paid, items, editables: edits.map(({ editable }) => editable), notes, assignments };
}

// `shots` in upload order; `choices`: screenshot → invoice, as the filer chose (an id no longer a stay is ignored).
export function placePayments(shots: readonly PaymentShot[], stays: readonly PaymentStay[], choices: ReadonlyMap<string, string>): Placement {
  const duplicates = new Map<string, Duplicate>();
  shots.forEach((shot, index) => {
    for (const earlier of shots.slice(0, index)) {
      if (duplicates.has(earlier.materialId)) continue;
      const same = samePayment(shot.values, earlier.values);
      if (same !== null) {
        duplicates.set(shot.materialId, { of: earlier.materialId, byNumber: same === 'number' });
        return;
      }
    }
  });

  const stayIds = new Set(stays.map((stay) => stay.invoiceId));
  const assigned = new Map<string, string>();
  const chosen = new Set<string>();
  const unassigned: string[] = [];
  for (const shot of shots) {
    if (duplicates.has(shot.materialId)) continue;
    const choice = choices.get(shot.materialId);
    if (choice !== undefined && stayIds.has(choice)) {
      assigned.set(shot.materialId, choice);
      chosen.add(shot.materialId);
      continue;
    }
    const stay = derive(shot, stays);
    if (stay) assigned.set(shot.materialId, stay);
    else unassigned.push(shot.materialId);
  }
  return { assigned, chosen, duplicates, unassigned };
}

// Per invoice, the amounts of the screenshots placed with it, in cents.
function paidByInvoice(shots: readonly PaymentShot[], placement: Placement): Map<string, number[]> {
  const paid = new Map<string, number[]>();
  for (const shot of shots) {
    const invoiceId = placement.assigned.get(shot.materialId);
    const amount = slotCents(shot.values['amount']);
    if (invoiceId !== undefined && amount !== null) paid.set(invoiceId, [...(paid.get(invoiceId) ?? []), amount]);
  }
  return paid;
}

function unassignedItem(shot: PaymentShot, stays: readonly LabelledStay[]): PendingItem {
  const { amount = '', payDate = '' } = shot.values;
  return item(PAYMENT_ITEM_CODES.unassigned, shot.materialId, PAYMENT_COPY.unassignedTitle(shot.fileName), PAYMENT_COPY.unassignedWhy(amount, payDate, stays.length > 0), [
    ...stays.map((stay) => ({ key: `${STAY_CHOICE}${stay.invoiceId}`, label: PAYMENT_COPY.assignTo(stay.label) })),
    EXCLUDE,
  ]);
}

// Two screenshots show one payment when both carry the same transaction number; failing that, the same amount paid at
// the same second. A time without seconds is too coarse to call two payments one.
function samePayment(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): 'number' | 'time' | null {
  const [numberA, numberB] = [a['transactionNumber'], b['transactionNumber']];
  if (numberA && numberB) return numberA === numberB ? 'number' : null;
  const seconds = (time: string | undefined) => (time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : null);
  const [timeA, timeB] = [seconds(a['payTime']), seconds(b['payTime'])];
  return timeA && timeA === timeB && a['payDate'] === b['payDate'] && a['amount'] === b['amount'] ? 'time' : null;
}

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

function derive(shot: PaymentShot, stays: readonly PaymentStay[]): string | null {
  const paidOn = shot.values['payDate'];
  if (!paidOn) return null;
  const paid = day(paidOn);
  const fits = stays.flatMap((stay) => {
    const from = stay.checkIn ?? stay.issueDate;
    const to = stay.checkOut ?? stay.issueDate;
    if (!from || !to) return [];
    const [start, end] = [day(from), day(to)];
    if (paid < start - BEFORE_CHECK_IN || paid > end + AFTER_CHECK_OUT) return [];
    return [{ stay, distance: paid < start ? start - paid : paid > end ? paid - end : 0 }];
  });
  const nearest = Math.min(...fits.map((fit) => fit.distance));
  let left = fits.filter((fit) => fit.distance === nearest).map((fit) => fit.stay);
  left = narrow(left, (stay) => namesHotel(shot.values['payee'], stay.hotelNames));
  const amount = slotCents(shot.values['amount']);
  left = narrow(left, (stay) => amount !== null && amount <= (slotCents(stay.totalAmount) ?? -1));
  return left.length === 1 ? (left[0]?.invoiceId ?? null) : null;
}

// Keeps the stays that pass `test`, unless none does: a tie-break only ever decides, never rules everything out.
function narrow(stays: PaymentStay[], test: (stay: PaymentStay) => boolean): PaymentStay[] {
  if (stays.length < 2) return stays;
  const kept = stays.filter(test);
  return kept.length > 0 ? kept : stays;
}

function namesHotel(payee: string | undefined, hotelNames: readonly string[]): boolean {
  const name = compact(payee ?? '');
  if (name.length < NAME_MIN) return false;
  return hotelNames.some((hotel) => {
    const other = compact(hotel);
    return other.length >= NAME_MIN && (other.includes(name) || name.includes(other));
  });
}
