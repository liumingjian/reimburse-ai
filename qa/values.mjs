// Values the QA driver types into 待确认项 (pending item) forms.
//
// Kept apart from the driver so it can be checked without a browser: `node --test "qa/*.test.mjs"`.
//
// The app validates manual fill twice — in the page and again on the server — with the patterns in
// `contract/src/actions.ts` (`validatePendingAnswer`) and the per-kind `check()` in
// `server/src/kind-policy.ts`. Those are the source of truth; the copies below exist only so this file
// stays browser-free, and `values.test.mjs` fails if the two drift apart.
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/;

// A date the date check accepts: real calendar day, `YYYY-MM-DD`.
const DATE = '2026-08-15';
const TIME = '09:30';

// Amount used when the material's own 价税合计 (tax-inclusive total, 原文 价税合计) is unknown.
const DEFAULT_TOTAL = '20.00';
// 6% is the rate these faces usually carry; any rate works as long as the three amounts conserve.
const TAX_NUMERATOR = 6;
const TAX_DENOMINATOR = 106;

// A money label, for the case where the page gives us a label but no declared format.
const MONEY_LABEL = /金额|税额|合计|票价|房价|价款|已付|付款|费用/;
const DATE_LABEL = /日期/;
const TIME_LABEL = /时间/;

const NET_LABEL = /不含税/;
const TAX_LABEL = /税额/;

// Cents of a `12.34`-shaped amount; null when it is not one. Mirrors `slotCents` in
// `server/src/money-date.ts`, which is what decides whether the amounts conserve.
export function toCents(amount) {
  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) return null;
  const [yuan, fen] = amount.split('.');
  return Number(yuan) * 100 + Number(fen);
}

const fromCents = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

// 不含税金额 (net amount, 原文 不含税金额) + 税额 (tax, 原文 税额) = 价税合计, to the cent. The server
// refuses any other triple and never back-calculates one for us (ADR-0017), so the driver has to hand it
// amounts that already add up. `total` is the material's own 价税合计 when it is already known.
export function amountTriple(total) {
  const gross = toCents(total) === null ? toCents(DEFAULT_TOTAL) : toCents(total);
  let tax = Math.round((gross * TAX_NUMERATOR) / TAX_DENOMINATOR);
  // Keep both parts positive whenever the total leaves room for it: an amount of `0.00` is refused
  // outright elsewhere (逐段分摊), and a zero part reads as a mistake on a face.
  if (gross >= 2) tax = Math.min(Math.max(tax, 1), gross - 1);
  else tax = 0;
  return { net: fromCents(gross - tax), tax: fromCents(tax), total: fromCents(gross) };
}

// The invoice-number shapes the per-kind `check()` enforces. 出租车车费发票 (paper taxi receipt, 原文
// 出租车车费发票) is the odd one: 10 or 12 digit 发票代码 plus an 8 digit 发票号码; every other kind wants
// the 20 digit number of a 全电发票 (fully digitalised e-invoice, 原文 全电发票).
const INVOICE_NUMBER_20 = '25442000000012345678';
const INVOICE_NUMBER_8 = '12345678';

// Two materials filled with the same 发票号码 are the same invoice as far as the app is concerned, and it
// says so — correctly. `seed` (the material's id) keeps every stand-in number distinct so the driver never
// manufactures a duplicate it then has to answer for.
function seededDigits(seed, length) {
  let hash = 2166136261;
  for (const ch of String(seed)) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  let digits = '';
  while (digits.length < length) {
    hash = Math.imul(hash ^ (hash >>> 13), 16777619) >>> 0;
    digits += String(hash).padStart(10, '0').slice(-9);
  }
  return digits.slice(0, length);
}

const invoiceNumber20 = (seed) => (seed ? `2544${seededDigits(seed, 16)}` : INVOICE_NUMBER_20);
const INVOICE_CODE_12 = '144031539110';

// 项目名称 (item name, 原文 项目名称) on a 全电发票 is a 税收分类 in `*类别*说明` form, and the app reads the
// 费用类别 (expense category, 原文 费用类别) out of it (`vatItemCategory` in server/src/parse/slots.ts). A free-text
// marker leaves the invoice uncategorised, so it forms no 费用事件 and never reaches the 整单明细 — the stand-in
// therefore keeps the real shape of a passenger-transport item row.
// A recognised face the app already read is a ride-hailing invoice, so the transport class is the truthful
// shape there. A file nothing could recognise tells the driver nothing at all: the accommodation class is no
// less of a guess and, unlike 市内交通, it needs no 费用发生城市 (city of the expense, 原文 费用发生城市) —
// which a lone invoice without its 行程单 can never have, and which the app is right to refuse to invent.
const ITEM_NAME_TRANSPORT = '*运输服务*客运服务费';
const ITEM_NAME_STAY = '*住宿服务*住宿费';

// `format` is the field's declared `PendingField.format` (contract/src/snapshot.ts); when the page does not
// carry it, fall back to the label. `text` fields are unvalidated, so their value only has to be plausible.
export function formatOf({ format, label = '' }) {
  if (format) return format;
  if (MONEY_LABEL.test(label)) return 'money';
  if (DATE_LABEL.test(label)) return 'date';
  if (TIME_LABEL.test(label)) return 'time';
  return 'text';
}

// One value for one manual-fill field. `key` is the slot key (`invoiceNumber`, `totalAmount`, ...),
// `label` its Chinese label, `format` its declared format. `kind` and `total` are what the driver already
// knows about the material from the snapshot: its 材料种类 (material kind, 原文 材料种类) and its read
// 价税合计; `seed` is the material's id, which keeps invented invoice numbers apart. Only `label` is always
// available.
export function qaValue({ key = '', label = '', format = undefined, city = '广州', kind = undefined, total = undefined, seed = '' } = {}) {
  const l = label.replace(/\s*\*$/, '').trim();
  const resolved = formatOf({ format, label: l });

  if (resolved === 'money') {
    const triple = amountTriple(total);
    if (key === 'netAmount' || NET_LABEL.test(l)) return triple.net;
    if (key === 'taxAmount' || (TAX_LABEL.test(l) && !/价税/.test(l))) return triple.tax;
    return triple.total;
  }
  if (resolved === 'date') return DATE;
  if (resolved === 'time') return TIME;

  // text — no format check, so the only requirement is that a human would recognise it as a stand-in.
  if (key === 'invoiceCode' || /发票代码/.test(l)) return INVOICE_CODE_12;
  if (key === 'invoiceNumber' || /发票号码|票号/.test(l)) return kind === 'taxi_receipt' ? INVOICE_NUMBER_8 : invoiceNumber20(seed);
  if (key === 'invoiceType' || /票种/.test(l)) return '电子发票（普通发票）';
  if (key === 'itemName' || /项目名称/.test(l)) return kind === undefined ? ITEM_NAME_STAY : ITEM_NAME_TRANSPORT;
  if (key === 'trainNumber' || /车次/.test(l)) return 'G1234';
  if (key === 'segmentCount' || /段数/.test(l)) return '1';
  if (/城市|住宿地|出发站|到达站|起点|终点/.test(l)) return city;
  if (/名称|销售方|购买方|项目|酒店/.test(l)) return 'QA 测试商户';
  if (/人$|乘车人|入住人/.test(l)) return 'QA 测试';
  return 'QA';
}

// What the driver can tell about its own submission before the server sees it, mirroring the per-kind
// `check()` of `server/src/kind-policy.ts`. `values` is the material's known values merged with what the
// driver just typed. Returns null when the driver has no reason to expect a refusal — which is what turns
// a refusal into a real defect rather than the driver's own fault.
export function qaSelfCheck(values = {}, kind = undefined) {
  const number = values['invoiceNumber'];
  const code = values['invoiceCode'];
  if (kind === 'taxi_receipt') {
    if (code && !/^(?:\d{10}|\d{12})$/.test(code)) return `发票代码 is not 10 or 12 digits`;
    if (number && !/^\d{8}$/.test(number)) return `发票号码 is not 8 digits`;
  } else if (number && !/^\d{20}$/.test(number)) {
    return `发票号码 is not 20 digits`;
  }
  const [net, tax, gross] = [toCents(values['netAmount']), toCents(values['taxAmount']), toCents(values['totalAmount'])];
  if (net !== null && tax !== null && gross !== null && net + tax !== gross) {
    return '不含税金额 + 税额 does not equal 价税合计 (the conservation check)';
  }
  return null;
}
