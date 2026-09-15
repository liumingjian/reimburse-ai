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
  // The ERP 发票类型 (ERP invoice type) values the company rules allow for these values (a `choice` edit).
  // Defaults to the one the event draft derived.
  erpInvoiceTypes?: (values: Readonly<Record<string, string>>) => string[];
};

const toCents = (value: string | undefined): number | null => (value !== undefined && /^-?\d+\.\d{2}$/.test(value) ? Math.round(Number(value) * 100) : null);

// Kernel category codes (contract ExpenseCategorySchema).
export const CATEGORIES = {
  accommodation: { code: 'accommodation', label: '住宿' },
  long_distance: { code: 'long_distance', label: '长途交通' },
  // Undivided 市内交通: `deriveCategory` (rules/company-rules.ts) splits it into local / out-of-town from the expense
  // city and the task's home city; a line never carries this code.
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

// 酒店结账单 (hotel folio): reference material for a hotel invoice. `folioTotal` is not an invoice amount; it only
// pairs the folio with its invoice. `checkOut` may be derived from 入住日期 + 天数.
const HOTEL_FOLIO_SLOTS: readonly Slot[] = [
  { key: 'hotelName', label: '酒店名称', required: true, format: 'text' },
  { key: 'guestName', label: '入住人', required: false, format: 'text' },
  { key: 'roomNumber', label: '房号', required: false, format: 'text' },
  { key: 'checkIn', label: '入住日期', required: true, format: 'date' },
  { key: 'checkOut', label: '离店日期', required: true, format: 'date' },
  { key: 'nights', label: '天数', required: false, format: 'text' },
  { key: 'roomRate', label: '房价', required: false, format: 'money' },
  { key: 'folioTotal', label: '消费合计', required: true, format: 'money' },
  { key: 'paidAmount', label: '已付款', required: false, format: 'money' },
];

// 出租车车费发票 (taxi receipt): every slot is read by OCR, so each is `fact_correctable` (ADR-0017).
const TAXI_RECEIPT_SLOTS: readonly Slot[] = [
  { key: 'invoiceCode', label: '发票代码', required: true, format: 'text' },
  { key: 'invoiceNumber', label: '发票号码', required: true, format: 'text' },
  { key: 'travelDate', label: '日期', required: true, format: 'date' },
  { key: 'totalAmount', label: '金额', required: true, format: 'money' },
  { key: 'plate', label: '车号', required: false, format: 'text' },
  { key: 'boardTime', label: '上车时间', required: false, format: 'text' },
  { key: 'alightTime', label: '下车时间', required: false, format: 'text' },
  { key: 'distance', label: '里程', required: false, format: 'text' },
  { key: 'city', label: '城市', required: false, format: 'text' },
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
  check: (values) => (values['invoiceNumber'] && !/^\d{20}$/.test(values['invoiceNumber']) ? '发票号码应为 20 位数字。' : null),
  // Kernel invoiceIdentity: a 20-digit number is `einvoice-20` whatever the face; a rail ticket counts for 重复发票
  // and 发票占用 like any 全电发票. (Folios carry no invoice number and stay out.)
  identity: (values) => (/^\d{20}$/.test(values['invoiceNumber'] ?? '') ? `einvoice-20:${values['invoiceNumber']}` : null),
  erpInvoiceTypes: () => ['铁路电子客票'],
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
    check(values) {
      const number = values['invoiceNumber'];
      if (number && !/^\d{20}$/.test(number)) return '发票号码应为 20 位数字。';
      const [net, tax, total] = [values['netAmount'], values['taxAmount'], values['totalAmount']];
      const [n, t, g] = [toCents(net), toCents(tax), toCents(total)];
      if (n !== null && t !== null && g !== null && n + t !== g) {
        return `不含税金额 ${net} 加税额 ${tax} 与价税合计 ${total} 对不上。系统不会倒算或调整任何金额，请对照原件重新填写。`;
      }
      return null;
    },
    // Kernel invoiceIdentity (parse.mjs:319): a 全电发票 is identified by its 20-digit number.
    identity: (values) => (/^\d{20}$/.test(values['invoiceNumber'] ?? '') ? `einvoice-20:${values['invoiceNumber']}` : null),
    // The face 票种 decides the ERP invoice type; no company rule allows another one yet (#188 pins the rules).
    erpInvoiceTypes: (values) => [INVOICE_TYPES[values['invoiceType'] ?? ''] ?? '增值税发票'],
  },
  rail_ticket: RAIL_TICKET,
  ride_itinerary: RIDE_ITINERARY,
  // A folio forms no event of its own: `hotel-stay.ts` pairs it with its hotel invoice for the stay dates.
  hotel_folio: { kind: 'hotel_folio', label: '酒店结账单', role: 'reference', slots: HOTEL_FOLIO_SLOTS, categoryLabel: () => CATEGORIES.accommodation.label, event: noEvent },
  taxi_receipt: {
    kind: 'taxi_receipt',
    label: '出租车车费发票',
    role: 'primary_voucher',
    slots: TAXI_RECEIPT_SLOTS,
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
        invoiceType: '普通发票',
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
    erpInvoiceTypes: () => ['普通发票'],
  },
};

export function slotOf(kind: MaterialKind, key: string): Slot | undefined {
  return KINDS[kind].slots.find((slot) => slot.key === key);
}
