import { slotCents } from './money-date';

// One-to-one pairing of vouchers (an invoice) with reference materials (a 结账单, …) by amount (#357): the one rule
// every invoice ↔ reference-material pairing uses, hotel stays (`hotel-stay.ts`) among them.
//
// A pair forms only when the amounts agree to the cent and that amount is unique on both sides: exactly one voucher
// and exactly one reference carry it. Two vouchers, or two references, of one amount pair nothing on that amount, so
// the outcome never depends on upload order. A material with no amount pairs with nothing and claims nothing.

export type Pairable = { materialId: string; amount: string | undefined };

export type AmountPair = { voucherId: string; referenceId: string; amount: string };

// Pairs in the order of `references`.
export function pairByAmount(vouchers: readonly Pairable[], references: readonly Pairable[]): AmountPair[] {
  const byCents = (materials: readonly Pairable[]) => {
    const groups = new Map<number, Pairable[]>();
    for (const material of materials) {
      const value = slotCents(material.amount);
      if (value !== null) groups.set(value, [...(groups.get(value) ?? []), material]);
    }
    return groups;
  };
  const voucherGroups = byCents(vouchers);
  const referenceGroups = byCents(references);
  return [...referenceGroups].flatMap(([value, [reference, ...others]]) => {
    const [voucher, ...rivals] = voucherGroups.get(value) ?? [];
    if (!reference || !voucher || others.length > 0 || rivals.length > 0) return [];
    return [{ voucherId: voucher.materialId, referenceId: reference.materialId, amount: reference.amount! }];
  });
}
