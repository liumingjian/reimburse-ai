import type { MaterialKind, PendingItem } from '@baox/contract';
import { cents, money } from './parse/doc';
import { KINDS, type EventDraft } from './parse/kinds';

// 逐段分摊 (per-leg allocation) and the ride-hailing invoice ↔ itinerary pairing, ported from kernel/src/events.mjs
// (`linkEvidence`, `conservingSegments`, `splitTax`, `buildEvents`). Two rules:
//   1. Splitting needs evidence: an invoice becomes several legs only because its paired itinerary lists them.
//   2. The system never makes up an amount: nothing is averaged or apportioned (by count, distance or time). Itinerary
//      leg amounts are adopted only when they sum to the invoice's 价税合计 exactly, to the cent (AA splits included);
//      otherwise the user gives each leg's total (an `allocation` 待确认项). Net and tax are then cut by the invoice's
//      own net/total ratio, each conserving to the face.
// Pure: the inventory view (`inventory-view.ts`) calls `planTransport` once per projection.

// One leg as the itinerary lists it (0-based candidate index `i` → 1-based `index`).
export type Leg = { index: number; date: string | null; time: string | null; city: string | null; origin: string | null; destination: string | null; amount: string | null };
export type LegAmount = { index: number; gross: string; net: string; tax: string };
export type FaceAmounts = { netAmount?: string; taxAmount?: string; totalAmount?: string };

export type Allocation =
  | { status: 'adopted'; source: 'itinerary_conserved' | 'user_allocation'; legs: LegAmount[]; residueCents: number; residueOn: number | null }
  | { status: 'required'; total: string; legs: Leg[]; suggested: (string | null)[]; reason: 'not_conserving' | 'answer_not_conserving' | 'face_not_conserving' };

const MONEY = /^\d{1,9}\.\d{2}$/;
const positiveCents = (text: string | null | undefined): number | null => {
  const value = text && MONEY.test(text.trim()) ? cents(text.trim()) : null;
  return value !== null && value > 0 ? value : null;
};

// The leg amounts in cents when every one is a positive two-decimal amount and they sum to `totalCents` exactly.
export function conservingLegs(amounts: readonly (string | null)[], totalCents: number): number[] | null {
  const values = amounts.map(positiveCents);
  if (values.length === 0 || values.some((v) => v === null)) return null;
  const legs = values as number[];
  return legs.reduce((a, b) => a + b, 0) === totalCents ? legs : null;
}

// Cuts each settled leg total into net and tax by the invoice's net/total ratio. The rounding residue goes to the
// largest leg (the first on a tie) and is reported, never hidden. Null when the three face amounts do not conserve.
export function splitTax(legTotals: readonly number[], netTotal: number, taxTotal: number): { nets: number[]; taxes: number[]; residueCents: number; residueOn: number | null } | null {
  const total = legTotals.reduce((a, b) => a + b, 0);
  if (total !== netTotal + taxTotal || total === 0) return null;
  const nets = legTotals.map((t) => Math.round((t * netTotal) / total));
  const residue = netTotal - nets.reduce((a, b) => a + b, 0);
  let residueOn: number | null = null;
  if (residue !== 0) {
    let largest = 0;
    for (let i = 1; i < legTotals.length; i += 1) if ((legTotals[i] ?? 0) > (legTotals[largest] ?? 0)) largest = i;
    nets[largest] = (nets[largest] ?? 0) + residue;
    residueOn = largest;
  }
  const taxes = legTotals.map((t, i) => t - (nets[i] ?? 0));
  if (nets.some((n) => n < 0) || taxes.some((t) => t < 0)) return null;
  return { nets, taxes, residueCents: residue, residueOn };
}

// Per-leg amounts of one invoice. `answer`: the per-leg totals the user gave (#187 feeds them); they win over the
// itinerary — the user read them off the originals.
export function allocate(face: FaceAmounts, legs: readonly Leg[], answer: readonly string[] | null = null): Allocation {
  const total = cents(face.totalAmount ?? '');
  const net = cents(face.netAmount ?? '');
  const tax = cents(face.taxAmount ?? '');
  const suggested = legs.map((leg) => leg.amount);
  const required = (reason: Extract<Allocation, { status: 'required' }>['reason']): Allocation => ({ status: 'required', total: face.totalAmount ?? '', legs: [...legs], suggested, reason });
  if (total === null || net === null || tax === null) return required('face_not_conserving');

  const given = answer ? (answer.length === legs.length ? conservingLegs(answer, total) : null) : null;
  if (answer && !given) return required('answer_not_conserving');
  const settled = given ?? conservingLegs(suggested, total);
  if (!settled) return required('not_conserving');
  const split = splitTax(settled, net, tax);
  if (!split) return required('face_not_conserving');
  return {
    status: 'adopted',
    source: given ? 'user_allocation' : 'itinerary_conserved',
    legs: settled.map((gross, i) => ({ index: legs[i]?.index ?? i + 1, gross: money(gross), net: money(split.nets[i] ?? 0), tax: money(split.taxes[i] ?? 0) })),
    residueCents: split.residueCents,
    residueOn: split.residueOn,
  };
}

// The legs of a resolved itinerary (`segments[i].<field>` values), in order.
export function legsOf(values: Readonly<Record<string, string>>): Leg[] {
  const legs: Leg[] = [];
  for (let i = 0; Object.keys(values).some((key) => key.startsWith(`segments[${i}].`)); i += 1) {
    const at = (field: string) => values[`segments[${i}].${field}`] ?? null;
    legs.push({ index: i + 1, date: at('date'), time: at('time'), city: at('city'), origin: at('origin'), destination: at('destination'), amount: at('amount') });
  }
  return legs;
}

export type RideInvoice = { materialId: string; values: Readonly<Record<string, string>> };
export type ItineraryRef = { materialId: string; values: Readonly<Record<string, string>> };
export type Pairing = { pairs: Map<string, string>; ambiguous: { itineraryId: string; invoiceIds: string[] }[]; unlinked: string[] };

// Links an itinerary to the invoice whose 价税合计 equals the itinerary's declared total — only when unique both ways.
// An itinerary matching several invoices, or an invoice matching several itineraries, is ambiguous: none is picked.
export function pairItineraries(invoices: readonly RideInvoice[], itineraries: readonly ItineraryRef[]): Pairing {
  const hitsOf = new Map(
    itineraries.map((it) => {
      const total = cents(it.values['itineraryTotal'] ?? '');
      return [it.materialId, total === null ? [] : invoices.filter((inv) => cents(inv.values['totalAmount'] ?? '') === total).map((inv) => inv.materialId)];
    }),
  );
  const candidatesOf = new Map<string, string[]>();
  for (const [itineraryId, hits] of hitsOf) if (hits.length === 1 && hits[0]) candidatesOf.set(hits[0], [...(candidatesOf.get(hits[0]) ?? []), itineraryId]);

  const pairs = new Map<string, string>();
  const ambiguous: Pairing['ambiguous'] = [];
  const unlinked: string[] = [];
  for (const { materialId: itineraryId } of itineraries) {
    const hits = hitsOf.get(itineraryId) ?? [];
    const invoiceId = hits[0];
    if (!invoiceId) unlinked.push(itineraryId);
    else if (hits.length > 1 || (candidatesOf.get(invoiceId)?.length ?? 0) > 1) ambiguous.push({ itineraryId, invoiceIds: hits });
    else pairs.set(invoiceId, itineraryId);
  }
  return { pairs, ambiguous, unlinked };
}

// ---- the inventory-view hook ----

// A recognised, included material, with `ok` when it raised no 待确认项 of its own.
export type TransportMaterial = { materialId: string; fileName: string; kind: MaterialKind; layout: string; values: Readonly<Record<string, string>>; ok: boolean };
// One candidate line's facts; `leg` is null when the voucher forms a single line.
export type PlannedLine = { draft: EventDraft; leg: number | null; referenceMaterialIds: string[]; evidenceNote: string | null };
export type TransportPlan = {
  // Per voucher whose lines this module decides; vouchers absent here keep the kind's single event.
  lines: Map<string, PlannedLine[]>;
  items: Map<string, PendingItem[]>;
  links: Map<string, string[]>;
  notes: Map<string, string>;
};

const BRANDS: Readonly<Record<string, string>> = { amap: '高德' };
const RIDE_HAILING = /^\*运输服务\*/;
export const ALLOCATION_GIVE_UP_NOTE = '放弃后这张发票不形成明细：请把它连同行程单排除，或补充能逐段核对的行程单后重新盘点。';

const arrow = (from: string | null, to: string | null) => (from && to ? `${from} → ${to}` : null);
const push = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);

// Pairs ride-hailing 全电发票 with 高德 itineraries and decides their per-leg lines or allocation items.
// `answers`: per invoice materialId, the per-leg totals the user gave on its allocation item (#187).
export function planTransport(materials: readonly TransportMaterial[], answers: ReadonlyMap<string, readonly string[]> = new Map()): TransportPlan {
  const plan: TransportPlan = { lines: new Map(), items: new Map(), links: new Map(), notes: new Map() };
  const invoices = materials.filter((m) => m.kind === 'vat_invoice' && RIDE_HAILING.test(m.values['itemName'] ?? ''));
  const itineraries = materials.filter((m) => m.kind === 'ride_itinerary' && m.ok);
  const { pairs, ambiguous, unlinked } = pairItineraries(invoices, itineraries);
  const byId = new Map(materials.map((m) => [m.materialId, m]));

  for (const id of unlinked) plan.notes.set(id, '合计金额没有对上任何一张打车发票：它可能属于另一次报销，或对应的发票还没上传');
  for (const { itineraryId, invoiceIds } of ambiguous) {
    const name = byId.get(itineraryId)?.fileName ?? itineraryId;
    const others = invoiceIds.map((id) => `「${byId.get(id)?.fileName ?? id}」`).join('、');
    push(plan.items, itineraryId, {
      itemId: `itinerary_ambiguous.${itineraryId}`,
      materialId: itineraryId,
      title: `「${name}」对应哪张发票不唯一`,
      why: `它的合计金额和 ${others} 都对得上，或者同一张发票对上了多份行程单。系统不会替你挑一份，请排除不属于本次报销的材料。`,
      kind: 'choice',
      resolver: '要你处理',
      fields: [],
      choices: [{ key: 'exclude', label: '排除这份材料' }],
      allocation: null,
      status: 'open',
      answer: null,
    });
  }

  for (const [invoiceId, itineraryId] of pairs) {
    const invoice = byId.get(invoiceId);
    const itinerary = byId.get(itineraryId);
    if (!invoice || !itinerary) continue;
    push(plan.links, invoiceId, itineraryId);
    push(plan.links, itineraryId, invoiceId);
    const face = invoice.ok ? KINDS.vat_invoice.event(invoice.values) : null;
    const legs = legsOf(itinerary.values);
    if (!face || legs.length === 0) continue;

    const result = allocate(invoice.values, legs, answers.get(invoiceId) ?? null);
    if (result.status === 'required') {
      const all = result.suggested.every((a) => a !== null);
      const sum = all ? money(result.suggested.reduce((acc, a) => acc + (cents(a ?? '') ?? 0), 0)) : null;
      const found = all ? `逐段金额 ${result.suggested.join(' + ')} = ${sum}，和发票价税合计 ${result.total} 对不上` : '有的段没写金额';
      const why =
        result.reason === 'answer_not_conserving'
          ? `你给的逐段金额加起来不等于发票价税合计 ${result.total}，请逐段核对，不要把差额加到某一段上。`
          : `行程单列了 ${legs.length} 段行程，${found}。请对照原件逐段给出价税合计；系统不会平均、按比例或按距离分摊。`;
      push(plan.items, invoiceId, {
        itemId: `allocation.${invoiceId}`,
        materialId: invoiceId,
        title: `「${invoice.fileName}」要逐段给出金额`,
        why,
        kind: 'allocation',
        resolver: '要你处理',
        fields: [],
        choices: [],
        allocation: {
          segments: legs.map((leg) => ({ index: leg.index, date: leg.date ?? face.date, route: arrow(leg.origin, leg.destination) ?? `第 ${leg.index} 段`, suggested: leg.amount })),
          total: result.total,
          giveUpNote: ALLOCATION_GIVE_UP_NOTE,
        },
        status: 'open',
        answer: null,
      });
      continue;
    }

    const brand = BRANDS[itinerary.layout] ?? '打车';
    const expression = result.legs.length === 1 ? `1 段行程 ${result.legs[0]?.gross ?? ''} 与发票一致` : `${result.legs.map((l) => l.gross).join(' + ')} = ${invoice.values['totalAmount'] ?? ''}，按分守恒`;
    const note = result.source === 'user_allocation' ? `打车发票与行程单配对：逐段金额由你确认，${expression}` : `打车发票与行程单配对：${expression}`;
    plan.lines.set(
      invoiceId,
      result.legs.map((amounts, i) => {
        const leg = legs[i];
        const route = arrow(leg?.origin ?? null, leg?.destination ?? null);
        return {
          leg: result.legs.length === 1 ? null : amounts.index,
          referenceMaterialIds: [itineraryId],
          evidenceNote: i === 0 ? note : null,
          draft: {
            ...face,
            summary: `${brand} · ${route ?? `第 ${amounts.index} 段`}`,
            date: leg?.date ?? face.date,
            grossAmount: amounts.gross,
            netAmount: amounts.net,
            taxAmount: amounts.tax,
            city: leg?.city ?? null,
            origin: leg?.origin ?? null,
            destination: leg?.destination ?? null,
            route,
          },
        };
      }),
    );
  }
  return plan;
}
