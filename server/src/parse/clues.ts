import { cents, money } from '../money-date';
import type { ParseDoc } from './doc';

// What an unrecognised document still says: every amount and every calendar date printed on it, as found anywhere in
// its text. No layout claims the document, so nothing says which is which; the inventory compares them with the task's
// invoices (`folio-proposal.ts`). Amounts are positive `0.00` strings, dates `YYYY-MM-DD`, each listed once, sorted.

export type Clues = { amounts: readonly string[]; dates: readonly string[] };

const AMOUNT = /(?<![-\d.,])¥?(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d.])/g;
// Spaces stay: compacting would run a date into the time after it, or two amounts into one.
const DATE = /(?<!\d)(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})(?!\d)/g;

export function cluesOf(doc: ParseDoc): Clues {
  const amounts = new Set<string>();
  const dates = new Set<string>();
  for (const observation of doc.observations) {
    const { text } = observation;
    for (const [found] of text.matchAll(AMOUNT)) {
      const value = cents(found);
      if (value !== null && value > 0) amounts.add(money(value));
    }
    for (const [, year, month, day] of text.matchAll(DATE)) {
      const date = isoDate(Number(year), Number(month), Number(day));
      if (date) dates.add(date);
    }
  }
  return { amounts: [...amounts].sort(), dates: [...dates].sort() };
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}
