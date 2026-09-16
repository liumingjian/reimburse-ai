// Values the QA driver types into 待确认项 (pending item) forms.
//
// Kept apart from the driver so it can be checked without a browser: `node --test "qa/*.test.mjs"`.
//
// The app validates manual fill twice — in the page and again on the server — with the patterns in
// `contract/src/actions.ts` (`validatePendingAnswer`). Those patterns are the source of truth; the copies
// below exist only so this file stays browser-free, and `values.test.mjs` fails if the two drift apart.
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)\.\d{2}$/;

// A date the date check accepts: real calendar day, `YYYY-MM-DD`.
const DATE = '2026-08-15';
const TIME = '09:30';

// Amounts: two decimals, no leading zero, no thousands separator, never `0.00` (逐段分摊 rejects zero).
// 不含税金额 + 税额 add up to 价税合计 so a filled-in invoice is at least self-consistent.
const NET = '19.00';
const TAX = '1.00';
const TOTAL = '20.00';

// A money label, for the case where the page gives us a label but no declared format.
const MONEY_LABEL = /金额|税额|合计|票价|房价|价款|已付|付款|费用/;
const DATE_LABEL = /日期/;
const TIME_LABEL = /时间/;

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
// `label` its Chinese label, `format` its declared format. Only `label` is always available.
export function qaValue({ key = '', label = '', format = undefined, city = '广州' } = {}) {
  const l = label.replace(/\s*\*$/, '').trim();
  const resolved = formatOf({ format, label: l });

  if (resolved === 'money') {
    if (key === 'netAmount' || /不含税/.test(l)) return NET;
    if (key === 'taxAmount' || (/税额/.test(l) && !/价税/.test(l))) return TAX;
    return TOTAL;
  }
  if (resolved === 'date') return DATE;
  if (resolved === 'time') return TIME;

  // text — no format check, so the only requirement is that a human would recognise it as a stand-in.
  if (/^(invoiceNumber|invoiceCode)$/.test(key) || /发票号码|发票代码|票号/.test(l)) return '25442000000012345678';
  if (key === 'invoiceType' || /票种/.test(l)) return '电子发票（普通发票）';
  if (key === 'trainNumber' || /车次/.test(l)) return 'G1234';
  if (key === 'segmentCount' || /段数/.test(l)) return '1';
  if (/城市|住宿地|出发站|到达站|起点|终点/.test(l)) return city;
  if (/名称|销售方|购买方|项目|酒店/.test(l)) return 'QA 测试商户';
  if (/人$|乘车人|入住人/.test(l)) return 'QA 测试';
  return 'QA';
}
