import type { ExpenseCategory, MaterialKind, MaterialRole } from '@baox/contract';
import { slotCents } from './money-date';
import { CATEGORIES, itemParts, SLOTS, vatItemCategory, type Slot } from './parse/slots';

// Kind policy for material kinds (材料种类, ADR-0017): the role a kind's materials take, how a material joins expense
// events (费用事件), its invoice identity (发票身份) and expense category (费用类别). Its slot schema (what a layout
// extracts) and the item map it reads categories through (`vatItemCategory`) are recognition's (`parse/slots.ts`).
// v1 kinds are fixed; #184–#186 fill the `event` of the kinds they bring layouts for.

// One candidate line's worth of facts, resolved from a material's candidates. Pairing with reference materials
// (itineraries, folios) and per-leg splitting are the kinds' job in #184/#185.
export type EventDraft = {
  category: ExpenseCategory;
  summary: string;
  description: string;
  date: string;
  endDate: string | null;
  grossAmount: string;
  netAmount: string;
  taxAmount: string;
  maskedNumber: string | null;
  // Trip facts, when the material carries them (rail ticket face, itinerary leg); null/absent otherwise.
  // `city` is the 费用发生城市 (expense city): city transport is split into local / out-of-town against the task's home
  // city by `deriveCategory` (rules/company-rules.ts); absent, the line blocks on category_city_missing.
  city?: string | null;
  origin?: string | null;
  destination?: string | null;
  route?: string | null;
  // The evidence conclusion shown on the voucher group's first event.
  evidenceNote?: string | null;
};

export type KindSpec = {
  kind: MaterialKind;
  label: string;
  role: Extract<MaterialRole, 'primary_voucher' | 'reference'>;
  slots: readonly Slot[];
  // The category label shown per material, from its resolved values; null when the kind cannot tell alone.
  categoryLabel: (values: Readonly<Record<string, string>>) => string | null;
  // The expense event a recognised material forms on its own; null when it forms none (reference materials).
  event: (values: Readonly<Record<string, string>>) => EventDraft | null;
  // Checks on resolved values that a `user` value (manual fill, correction) must pass before it is accepted; the
  // first failure as a sentence, or null. Nothing is ever back-calculated to make a check pass (ADR-0017).
  check?: (values: Readonly<Record<string, string>>) => string | null;
  // The 发票身份 (invoice identity) behind 重复发票 and 发票占用 (occupancy), e.g. `einvoice-20:<number>`; null when
  // the values carry none. Kinds without an identity never count as duplicates.
  identity?: (values: Readonly<Record<string, string>>) => string | null;
  // The parsed face 票种. `inventory-view.ts` resolves this independently into the confirmed ERP 发票类型.
  faceInvoiceType?: (values: Readonly<Record<string, string>>) => string | null;
};

function vatCategory(values: Readonly<Record<string, string>>): ExpenseCategory | null {
  return vatItemCategory(values['itemName']);
}

// Kernel maskNumber: first 4 and last 4 digits, the rest starred.
export function maskNumber(number: string): string {
  return number.length <= 8 ? number : `${number.slice(0, 4)}${'*'.repeat(number.length - 8)}${number.slice(-4)}`;
}

const noEvent = () => null;
const noCategory = () => null;

// 铁路电子客票 (rail e-ticket, #184). The face carries only the fare: net = fare and tax = 0 (the kernel's
// `rail_total_tax_zero_rule`); the expense date is the travel date, never the issue date.
const RAIL_TICKET: KindSpec = {
  kind: 'rail_ticket',
  label: '铁路电子客票',
  role: 'primary_voucher',
  slots: SLOTS.rail_ticket,
  categoryLabel: () => CATEGORIES.long_distance.label,
  event(values) {
    const { travelDate, totalAmount, departStation, arriveStation, trainNumber, invoiceNumber } = values;
    if (!travelDate || !totalAmount || !departStation || !arriveStation) return null;
    const route = `${departStation} → ${arriveStation}`;
    return {
      category: CATEGORIES.long_distance,
      summary: trainNumber ? `${trainNumber} ${route}` : route,
      description: '火车票',
      date: travelDate,
      endDate: null,
      grossAmount: totalAmount,
      netAmount: totalAmount,
      taxAmount: '0.00',
      maskedNumber: invoiceNumber ? maskNumber(invoiceNumber) : null,
      city: null,
      origin: departStation,
      destination: arriveStation,
      route,
      evidenceNote: '一张铁路电子客票就是一次费用；无需参考材料',
    };
  },
  check: (values) => (values['invoiceNumber'] && !/^\d{20}$/.test(values['invoiceNumber']) ? '发票号码应为 20 位数字。' : null),
  // Kernel invoiceIdentity: a 20-digit number is `einvoice-20` whatever the face; a rail ticket counts for 重复发票
  // and 发票占用 like any 全电发票. (Folios carry no invoice number and stay out.)
  identity: (values) => (/^\d{20}$/.test(values['invoiceNumber'] ?? '') ? `einvoice-20:${values['invoiceNumber']}` : null),
  faceInvoiceType: () => '铁路电子客票',
};

// 网约车行程单 (ride itinerary, #184): a reference material. It forms no event of its own; its legs split the paired
// ride-hailing invoice (`server/src/allocation.ts`). Leg slots are keyed `segments[i].<field>` (0-based `i`).
const RIDE_ITINERARY: KindSpec = {
  kind: 'ride_itinerary',
  label: '网约车行程单',
  role: 'reference',
  slots: SLOTS.ride_itinerary,
  categoryLabel: noCategory,
  event: noEvent,
};

export const KINDS: Readonly<Record<MaterialKind, KindSpec>> = {
  vat_invoice: {
    kind: 'vat_invoice',
    label: '全电发票',
    role: 'primary_voucher',
    slots: SLOTS.vat_invoice,
    categoryLabel: (values) => vatCategory(values)?.label ?? null,
    event(values) {
      const category = vatCategory(values);
      const { issueDate, totalAmount, netAmount, taxAmount, invoiceNumber, sellerName, invoiceType } = values;
      if (!category || !issueDate || !totalAmount || !netAmount || !taxAmount) return null;
      const description = itemParts(values['itemName'])?.[2] || category.label;
      return {
        category,
        summary: sellerName ? `${description} · ${sellerName}` : description,
        description,
        date: issueDate,
        endDate: null,
        grossAmount: totalAmount,
        netAmount,
        taxAmount,
        maskedNumber: invoiceNumber ? maskNumber(invoiceNumber) : null,
      };
    },
    check(values) {
      const number = values['invoiceNumber'];
      if (number && !/^\d{20}$/.test(number)) return '发票号码应为 20 位数字。';
      const [net, tax, total] = [values['netAmount'], values['taxAmount'], values['totalAmount']];
      const [n, t, g] = [slotCents(net), slotCents(tax), slotCents(total)];
      if (n !== null && t !== null && g !== null && n + t !== g) {
        return `不含税金额 ${net} 加税额 ${tax} 与价税合计 ${total} 对不上。系统不会倒算或调整任何金额，请对照原件重新填写。`;
      }
      return null;
    },
    // Kernel invoiceIdentity (parse.mjs:319): a 全电发票 is identified by its 20-digit number.
    identity: (values) => (/^\d{20}$/.test(values['invoiceNumber'] ?? '') ? `einvoice-20:${values['invoiceNumber']}` : null),
    faceInvoiceType: (values) => values['invoiceType'] ?? null,
  },
  rail_ticket: RAIL_TICKET,
  ride_itinerary: RIDE_ITINERARY,
  // A folio forms no event of its own: `hotel-stay.ts` pairs it with its hotel invoice for the stay dates.
  hotel_folio: { kind: 'hotel_folio', label: '酒店结账单', role: 'reference', slots: SLOTS.hotel_folio, categoryLabel: () => CATEGORIES.accommodation.label, event: noEvent },
  dining_receipt: { kind: 'dining_receipt', label: '餐饮小票', role: 'reference', slots: SLOTS.dining_receipt, categoryLabel: () => CATEGORIES.hospitality.label, event: noEvent },
  taxi_receipt: {
    kind: 'taxi_receipt',
    label: '出租车车费发票',
    role: 'primary_voucher',
    slots: SLOTS.taxi_receipt,
    categoryLabel: () => CATEGORIES.city_transport.label,
    event(values) {
      const { travelDate, totalAmount, invoiceNumber, city } = values;
      if (!travelDate || !totalAmount) return null;
      const description = city ? `出租车（${city}）` : '出租车';
      // A paper taxi receipt states one amount and no separable tax. Undivided 市内交通: `deriveCategory` splits it by
      // `city` (from the 开票地区码) against the home city; without a city the line blocks on category_city_missing.
      return {
        category: CATEGORIES.city_transport,
        summary: description,
        description,
        date: travelDate,
        endDate: null,
        grossAmount: totalAmount,
        netAmount: totalAmount,
        taxAmount: '0.00',
        maskedNumber: invoiceNumber ? maskNumber(invoiceNumber) : null,
        city: city || null,
      };
    },
    check(values) {
      const { invoiceCode, invoiceNumber } = values;
      if (invoiceCode && !/^(?:\d{10}|\d{12})$/.test(invoiceCode)) return '发票代码应为 10 或 12 位数字。';
      if (invoiceNumber && !/^\d{8}$/.test(invoiceNumber)) return '发票号码应为 8 位数字。';
      return null;
    },
    // Kernel invoiceIdentity (parse.mjs:318): a pre-全电 invoice is identified by 发票代码 + 8-digit 发票号码.
    identity: ({ invoiceCode, invoiceNumber }) =>
      /^(?:\d{10}|\d{12})$/.test(invoiceCode ?? '') && /^\d{8}$/.test(invoiceNumber ?? '') ? `vat-legacy:${invoiceCode}:${invoiceNumber}` : null,
    faceInvoiceType: () => '普通发票',
  },
  // A 支付截图 forms no event and has no invoice identity, so it never counts toward 发票占用 (ADR-0032). Its amount is
  // the payment, written positive however the app signs it.
  payment_screenshot: {
    kind: 'payment_screenshot',
    label: '支付截图',
    role: 'reference',
    slots: SLOTS.payment_screenshot,
    categoryLabel: () => CATEGORIES.accommodation.label,
    event: noEvent,
    check({ amount, payTime }) {
      if (amount !== undefined && (slotCents(amount) ?? 0) <= 0) return '支付金额应大于 0。';
      if (payTime && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(payTime)) return '支付时间应写成 时:分 或 时:分:秒，例如 13:01:12。';
      return null;
    },
  },
};
