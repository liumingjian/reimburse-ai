import { daysBetween } from './money-date';
import type { Clues } from './parse/clues';

// An unrecognised image that may be a 住宿 invoice's 酒店结账单 (#336 decision 7c). No rule reads every hotel's folio,
// but a folio always prints the invoice's total and the stay's dates. When the image's text holds a 住宿 invoice's exact
// 价税合计 and at least two dates from 30 days before its issue date to 1 day after, the inventory proposes it as that
// invoice's folio: the earliest of those dates as check-in, the latest as check-out. The filer confirms or fills it by
// hand; nothing is assumed. A total that fits more than one invoice proposes nothing, as pairing would not take it.

const BEFORE_ISSUE = 30;
const AFTER_ISSUE = 1;

// A 住宿 invoice that has no folio yet.
export type ProposalStay = { invoiceId: string; fileName: string; totalAmount: string; issueDate: string };

export type FolioProposal = { invoiceId: string; fileName: string; checkIn: string; checkOut: string; folioTotal: string };

export function proposeFolio(clues: Clues, stays: readonly ProposalStay[]): FolioProposal | null {
  const fits = stays.flatMap((stay): FolioProposal[] => {
    if (!clues.amounts.includes(stay.totalAmount)) return [];
    const near = clues.dates.filter((date) => {
      const before = daysBetween(date, stay.issueDate);
      return before >= -AFTER_ISSUE && before <= BEFORE_ISSUE;
    });
    const [checkIn, checkOut] = [near[0], near.at(-1)];
    if (!checkIn || !checkOut || checkIn === checkOut) return [];
    return [{ invoiceId: stay.invoiceId, fileName: stay.fileName, checkIn, checkOut, folioTotal: stay.totalAmount }];
  });
  return fits.length === 1 ? (fits[0] ?? null) : null;
}
