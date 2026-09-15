import type { ExpenseCategory, MaterialKind, MaterialRole } from '@baox/contract';

// 材料种类 (material kinds, ADR-0017). A kind owns its slot schema (what a layout of that kind extracts and what the
// manual-fill form asks for), the role its materials take, and how a material joins 费用事件 (expense events).
// v1 kinds are fixed; #184–#186 fill the slots and `event` of the kinds they bring layouts for.

export type SlotFormat = 'text' | 'date' | 'money';
export type Slot = { key: string; label: string; required: boolean; format: SlotFormat };

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
  invoiceType: string;
  maskedNumber: string | null;
  // Trip facts, when the material carries them (rail ticket face, itinerary leg); null/absent otherwise.
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
};

// Kernel category codes (contract ExpenseCategorySchema).
export const CATEGORIES = {
  accommodation: { code: 'accommodation', label: '住宿' },
  long_distance: { code: 'long_distance', label: '长途交通' },
  // Ride-hailing on an invoice alone: local vs out-of-town needs the itinerary's city (#184) and the task's home city
  // (#188), so it stays undivided until those land.
  city_transport: { code: 'city_transport', label: '市内交通' },
} as const satisfies Record<string, ExpenseCategory>;

const VAT_INVOICE_SLOTS: readonly Slot[] = [
  { key: 'invoiceNumber', label: '发票号码', required: true, format: 'text' },
  { key: 'issueDate', label: '开票日期', required: true, format: 'date' },
  { key: 'invoiceType', label: '发票票种', required: true, format: 'text' },
  { key: 'buyerName', label: '购买方名称', required: false, format: 'text' },
  { key: 'buyerTaxId', label: '购买方纳税人识别号', required: false, format: 'text' },
  { key: 'sellerName', label: '销售方名称', required: true, format: 'text' },
  { key: 'sellerTaxId', label: '销售方纳税人识别号', required: false, format: 'text' },
  { key: 'itemName', label: '项目名称', required: true, format: 'text' },
  { key: 'netAmount', label: '不含税金额', required: true, format: 'money' },
  { key: 'taxAmount', label: '税额', required: true, format: 'money' },
  { key: 'totalAmount', label: '价税合计', required: true, format: 'money' },
];

// `*住宿服务*住宿费` → 住宿费; the 税收分类 (tax class) between the asterisks decides the category.
const itemParts = (itemName: string | undefined) => /^\*([^*]+)\*(.*)$/.exec(itemName ?? '');

function vatCategory(values: Readonly<Record<string, string>>): ExpenseCategory | null {
  const taxClass = itemParts(values['itemName'])?.[1];
  if (taxClass === '住宿服务') return CATEGORIES.accommodation;
  if (taxClass === '运输服务') return CATEGORIES.city_transport;
  return null;
}

// Kernel maskNumber: first 4 and last 4 digits, the rest starred.
export function maskNumber(number: string): string {
  return number.length <= 8 ? number : `${number.slice(0, 4)}${'*'.repeat(number.length - 8)}${number.slice(-4)}`;
}

const INVOICE_TYPES: Readonly<Record<string, string>> = { 专票: '增值税专用发票', 普票: '增值税普通发票' };

const noEvent = () => null;
const noCategory = () => null;

// 铁路电子客票 (rail e-ticket, #184). The face carries only the fare: net = fare and tax = 0 (the kernel's
// `rail_total_tax_zero_rule`); the expense date is the travel date, never the issue date.
const RAIL_TICKET: KindSpec = {
  kind: 'rail_ticket',
  label: '铁路电子客票',
  role: 'primary_voucher',
  slots: [
    { key: 'invoiceNumber', label: '发票号码', required: true, format: 'text' },
    { key: 'issueDate', label: '开票日期', required: true, format: 'date' },
    { key: 'trainNumber', label: '车次', required: true, format: 'text' },
    { key: 'departStation', label: '出发站', required: true, format: 'text' },
    { key: 'arriveStation', label: '到达站', required: true, format: 'text' },
    { key: 'travelDate', label: '乘车日期', required: true, format: 'date' },
    { key: 'departTime', label: '开车时间', required: false, format: 'text' },
    { key: 'seatClass', label: '席别', required: false, format: 'text' },
    { key: 'passengerName', label: '乘车人', required: false, format: 'text' },
    { key: 'totalAmount', label: '票价', required: true, format: 'money' },
  ],
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
      invoiceType: '铁路电子客票',
      maskedNumber: invoiceNumber ? maskNumber(invoiceNumber) : null,
      city: null,
      origin: departStation,
      destination: arriveStation,
      route,
      evidenceNote: '一张铁路电子客票就是一次费用；无需参考材料',
    };
  },
};

// 网约车行程单 (ride itinerary, #184): a reference material. It forms no event of its own; its legs split the paired
// ride-hailing invoice (`server/src/allocation.ts`). Leg slots are keyed `segments[i].<field>` (0-based `i`).
const RIDE_ITINERARY: KindSpec = {
  kind: 'ride_itinerary',
  label: '网约车行程单',
  role: 'reference',
  slots: [
    { key: 'applyDate', label: '申请日期', required: false, format: 'date' },
    { key: 'segmentCount', label: '行程段数', required: true, format: 'text' },
    { key: 'itineraryTotal', label: '行程单合计', required: true, format: 'money' },
  ],
  categoryLabel: noCategory,
  event: noEvent,
};

export const KINDS: Readonly<Record<MaterialKind, KindSpec>> = {
  vat_invoice: {
    kind: 'vat_invoice',
    label: '全电发票',
    role: 'primary_voucher',
    slots: VAT_INVOICE_SLOTS,
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
        invoiceType: INVOICE_TYPES[invoiceType ?? ''] ?? '增值税发票',
        maskedNumber: invoiceNumber ? maskNumber(invoiceNumber) : null,
      };
    },
  },
  // Slots, categories and events arrive with their layouts: rail #184, ride itinerary #184, folio #185, taxi #186.
  rail_ticket: RAIL_TICKET,
  ride_itinerary: RIDE_ITINERARY,
  hotel_folio: { kind: 'hotel_folio', label: '酒店结账单', role: 'reference', slots: [], categoryLabel: noCategory, event: noEvent },
  taxi_receipt: { kind: 'taxi_receipt', label: '出租车票', role: 'primary_voucher', slots: [], categoryLabel: noCategory, event: noEvent },
};

export function slotOf(kind: MaterialKind, key: string): Slot | undefined {
  return KINDS[kind].slots.find((slot) => slot.key === key);
}
