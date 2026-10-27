// Money and date helpers shared by recognition (layouts) and downstream modules (allocation, stays, kind policy).

// Money as integer cents, so sums conserve exactly. Two readers on purpose:
// - `cents` reads an amount as printed on a face (layouts, allocation): accepts `¥3,433.96`, `-1.94`, stray spaces;
//   null when not a 2-decimal amount.
// - `slotCents` reads a resolved slot value, which layouts and the manual-fill form always write as `-?0.00`; anything
//   else is not a value of that slot and reads as null, rather than being coaxed into one.

export function cents(text: string): number | null {
  const match = /^¥?(-)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text.replace(/\s+/g, ''));
  if (!match) return null;
  const value = Number((match[2] ?? '').replace(/,/g, '')) * 100 + Number(match[3]);
  return match[1] ? -value : value;
}

export function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;
// Whole days from one `YYYY-MM-DD` date to another (a stay's nights).
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// Strict `0.00`-shaped money (a resolved slot value) as integer cents; null otherwise. See `cents` above.
export const slotCents = (value: string | undefined): number | null => (value !== undefined && /^-?\d+\.\d{2}$/.test(value) ? Math.round(Number(value) * 100) : null);

// `YYYY-MM-DD` for a year, month and day that make a calendar date (no 02-30); null otherwise.
export function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}
