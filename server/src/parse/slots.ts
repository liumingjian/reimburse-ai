import type { ExpenseCategory, MaterialKind } from '@baox/contract';

// Recognition slots (ADR-0017): per material kind (材料种类), what a layout of that kind extracts and what the
// manual-fill form asks for. Recognition imports only this; what a recognised material means downstream (event
// dating, identity, which expense category (费用类别) a line gets) is kind policy (`../kind-policy.ts`).
//
// One exception, owned here on purpose: the v1 item map (`CATEGORIES`, `itemParts`, `vatItemCategory`), which reads an
// e-invoice item name as an expense category. The e-invoice layout recognises a fully-digitalised VAT e-invoice
// (全电发票) only when one of its items maps to a category, so recognition needs the map, and recognition may not
// import kind policy. Kind policy and the other downstream modules import it from here rather than through a
// re-export.

export type SlotFormat = 'text' | 'date' | 'money';
export type Slot = { key: string; label: string; required: boolean; format: SlotFormat };

// Kernel category codes (contract ExpenseCategorySchema).
export const CATEGORIES = {
  accommodation: { code: 'accommodation', label: '住宿' },
  hospitality: { code: 'hospitality', label: '招待费' },
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
// pairs the folio with its invoice. Neither date is derived from the other and 天数 (nights) (#212). The hotel name
// is not required: what a folio proves is the stay, and a photographed folio rarely yields its name as one text run
// (#211).
const HOTEL_FOLIO_SLOTS: readonly Slot[] = [
  { key: 'hotelName', label: '酒店名称', required: false, format: 'text' },
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

// 铁路电子客票 (rail e-ticket, #184).
const RAIL_TICKET_SLOTS: readonly Slot[] = [
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
];

// 网约车行程单 (ride itinerary, #184). Leg slots are keyed `segments[i].<field>` (0-based `i`).
const RIDE_ITINERARY_SLOTS: readonly Slot[] = [
  { key: 'applyDate', label: '申请日期', required: false, format: 'date' },
  { key: 'segmentCount', label: '行程段数', required: true, format: 'text' },
  { key: 'itineraryTotal', label: '行程单合计', required: true, format: 'money' },
];

// 支付截图 (payment screenshot, ADR-0032): reference material that places a stay's payments. Amount and date are what
// assignment and the sum check need; the rest is shown, never sent to ERP.
const PAYMENT_SCREENSHOT_SLOTS: readonly Slot[] = [
  { key: 'amount', label: '支付金额', required: true, format: 'money' },
  { key: 'payDate', label: '支付日期', required: true, format: 'date' },
  { key: 'payTime', label: '支付时间', required: false, format: 'text' },
  { key: 'payee', label: '收款方', required: false, format: 'text' },
  { key: 'transactionNumber', label: '交易单号', required: false, format: 'text' },
];

export const SLOTS: Readonly<Record<MaterialKind, readonly Slot[]>> = {
  vat_invoice: VAT_INVOICE_SLOTS,
  rail_ticket: RAIL_TICKET_SLOTS,
  ride_itinerary: RIDE_ITINERARY_SLOTS,
  hotel_folio: HOTEL_FOLIO_SLOTS,
  taxi_receipt: TAXI_RECEIPT_SLOTS,
  payment_screenshot: PAYMENT_SCREENSHOT_SLOTS,
};

// `*住宿服务*住宿费` → 住宿费; the 税收分类 (tax class) between the asterisks decides the category.
export const itemParts = (itemName: string | undefined) => /^\*([^*]+)\*(.*)$/.exec(itemName ?? '');

// 交通运输服务 is a parent class: it covers 货物运输 (freight transport), 航空运输 and 水路运输 as well as carrying
// people, so the class on its own does not make an invoice a 市内交通 voucher. Its description has to name a passenger
// service, the way 生产生活服务 has to name 住宿费.
const PASSENGER_TRANSPORT = /^(客运|网约车|出租车|打车|专车|快车|乘车)/;

// The v1 item rows, as they are actually printed. A face names either the fine 税收分类 (`*住宿服务*`, `*运输服务*`) or
// its parent class (`*交通运输服务*` on ride-hailing invoices, `*生产生活服务*` on hotel ones), so both spellings map
// here — a parent class only together with a description that names the v1 service, because the parent covers more
// than v1 does. The categories themselves are unchanged: this adds no 费用类别 (expense category) and no 材料种类
// (material kind) to ADR-0017's v1 matrix. `vat_invoice/einvoice` gates recognition on the same map, so what the
// layout accepts and what a line is categorised as can never drift apart.
export function vatItemCategory(itemName: string | undefined): ExpenseCategory | null {
  const parts = itemParts(itemName);
  const taxClass = parts?.[1];
  const description = parts?.[2] ?? '';
  if (taxClass === '住宿服务') return CATEGORIES.accommodation;
  if (taxClass === '餐饮服务') return CATEGORIES.hospitality;
  if (taxClass === '生产生活服务') return description.startsWith('住宿费') ? CATEGORIES.accommodation : null;
  if (taxClass === '运输服务') return CATEGORIES.city_transport;
  if (taxClass === '交通运输服务') return PASSENGER_TRANSPORT.test(description) ? CATEGORIES.city_transport : null;
  return null;
}

export function slotOf(kind: MaterialKind, key: string): Slot | undefined {
  return SLOTS[kind].find((slot) => slot.key === key);
}

// Per-leg fields of an itinerary, keyed `segments[i].<field>` with a 0-based `i` (#184).
const SEGMENT_FIELD_LABELS: Readonly<Record<string, string>> = { date: '日期', time: '上车时间', carType: '车型', city: '城市', origin: '起点', destination: '终点', amount: '金额' };
const SEGMENT_KEY = /^segments\[(\d+)\]\.(\w+)$/;

// The human label of a candidate key: the slot label, or 「第 N 段起点」 for a leg field; the raw key only as a last resort.
export function fieldLabel(kind: MaterialKind, key: string): string {
  const slot = slotOf(kind, key);
  if (slot) return slot.label;
  const leg = SEGMENT_KEY.exec(key);
  if (leg?.[1] && leg[2]) return `第 ${Number(leg[1]) + 1} 段${SEGMENT_FIELD_LABELS[leg[2]] ?? leg[2]}`;
  return key;
}
