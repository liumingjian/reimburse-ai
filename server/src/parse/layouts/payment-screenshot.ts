import { cents, money } from '../../money-date';
import { compact, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Layout } from '../layout';

// `payment_screenshot/labelled`: the success page a payment app shows after paying (Alipay 账单详情, WeChat Pay 账单,
// a bank app's 交易详情), read from a phone screenshot by the OCR adapter (ADR-0032). One rule for every app: each
// prints a success word, a payment-time label and the amount paid as a negative number, whatever else it adds around
// them. A refund prints a positive amount, so it is not a payment and stays unrecognised.
//
// What it reads (amount, when, to whom, the transaction number) only places the screenshot with its stay and shows it;
// none of it reaches ERP. As with a photographed folio, a label and its value are separate boxes on the same row.

const KIND = 'payment_screenshot';
const NAME = 'labelled';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
const LABEL = '支付截图';

// Hard anchors: a success word, a payment-time label, and a negative amount, each as a whole box.
const SUCCESS = /^(?:交易|支付|付款)成功$/;
const LABELS = {
  paidAt: ['支付时间', '付款时间', '交易时间'],
  payee: ['商户全称', '收款方', '收款人', '对方户名'],
  transactionNumber: ['交易单号', '订单号', '交易号', '流水号'],
} as const satisfies Record<string, readonly string[]>;

// `-178.48`, `-¥1,234.00`. OCR may return a typographic minus (U+2212), which NFKC leaves alone.
const PAID = /^[-−]¥?([\d,]+\.\d{2})$/;
// `2026-09-16 13:01:12`, `2026/9/16 13:01`, `2026年9月17日08:46:16`; compacted, so the space is gone. The time is
// optional: the date alone still places a payment.
const PAID_AT = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const TRANSACTION = /^[0-9A-Za-z]{10,}$/;

// A value's vertical centre may sit this many label heights from its label's and still be on the label's row.
const ROW_BAND = 0.6;

const centre = (o: TextObservation) => o.y + o.height / 2;
const ref = (observations: readonly TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

type Read = { text: string; raw: string; observations: TextObservation[] };

// The first label of `labels` the screenshot prints, as its own box or with a colon and the value in the same box. A
// longer word that only starts with a label (`商户单号`, `商家订单号`) is not that label.
function labelOf(doc: ParseDoc, labels: readonly string[]): { box: TextObservation; label: string } | undefined {
  for (const label of labels) {
    const box = doc.observations.find((o) => {
      const text = compact(o.text);
      return text === label || (text.startsWith(label) && /^[:：]/.test(text.slice(label.length)));
    });
    if (box) return { box, label };
  }
  return undefined;
}

// A label's value: the rest of the label's own box, else the nearest box right of it on its row.
function valueOf(doc: ParseDoc, labels: readonly string[]): Read | null {
  const found = labelOf(doc, labels);
  if (!found) return null;
  const { box, label } = found;
  const rest = (text: string) => compact(text).slice(label.length).replace(/^[:：]/, '');
  if (rest(box.text)) return { text: rest(box.text), raw: rest(box.raw), observations: [box] };
  const value = doc.observations
    .filter((o) => o !== box && o.page === box.page && o.x >= box.x + box.width && Math.abs(centre(o) - centre(box)) <= box.height * ROW_BAND)
    .sort((a, b) => a.x - b.x)[0];
  return value ? { text: compact(value.text), raw: compact(value.raw), observations: [box, value] } : null;
}

// The amount paid: the tallest negative amount on the screen, which every app prints as the page's headline. A
// smaller negative figure (a discount line) is never it.
function paidOf(doc: ParseDoc): { cents: number; box: TextObservation } | null {
  const found = doc.observations
    .map((box) => ({ box, match: PAID.exec(compact(box.text)) }))
    .filter((hit) => hit.match)
    .sort((a, b) => b.box.height - a.box.height)[0];
  const value = found?.match ? cents(found.match[1] ?? '') : null;
  return found && value !== null && value > 0 ? { cents: value, box: found.box } : null;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const pad = (value: string | number) => String(value).padStart(2, '0');

// The payment time as `YYYY-MM-DD` and, when printed, `HH:MM[:SS]`; null when it is not a calendar date.
function paidAtOf(text: string): { date: string; time: string | null } | null {
  const match = PAID_AT.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(year, month, day)) return null;
  const [hour, minute, second] = [match[4], match[5], match[6]];
  const time = hour !== undefined && minute !== undefined && Number(hour) < 24 && Number(minute) < 60 && Number(second ?? 0) < 60
    ? [hour, minute, ...(second === undefined ? [] : [second])].map(pad).join(':')
    : null;
  return { date: `${year}-${pad(month)}-${pad(day)}`, time };
}

// The payee when no label names it: the nearest box above the amount that overlaps it horizontally, where Alipay prints
// the merchant. A number or a time there is not a name.
function payeeAbove(doc: ParseDoc, amount: TextObservation): TextObservation | undefined {
  return doc.observations
    .filter((o) => o.page === amount.page && o.y > amount.y + amount.height && o.x < amount.x + amount.width && o.x + o.width > amount.x && /\p{Script=Han}/u.test(o.text))
    .sort((a, b) => a.y - b.y)[0];
}

export const paymentScreenshot: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: LABEL,

  recognise(doc) {
    return doc.mediaType === 'image' && doc.observations.some((o) => SUCCESS.test(compact(o.text))) && labelOf(doc, LABELS.paidAt) !== undefined && paidOf(doc) !== null;
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const add = (key: string, value: string, observations: TextObservation[]) => {
      candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: ref(observations) });
    };

    const paid = paidOf(doc);
    if (paid) add('amount', money(paid.cents), [paid.box]);

    const at = valueOf(doc, LABELS.paidAt);
    const when = at ? paidAtOf(at.text) : null;
    if (at && when) {
      add('payDate', when.date, at.observations);
      if (when.time) add('payTime', when.time, at.observations);
    }

    const payee = valueOf(doc, LABELS.payee);
    const above = payee || !paid ? undefined : payeeAbove(doc, paid.box);
    if (payee) add('payee', payee.raw, payee.observations);
    else if (above) add('payee', compact(above.raw), [above]);

    for (const label of LABELS.transactionNumber) {
      const number = valueOf(doc, [label]);
      if (number && TRANSACTION.test(number.text)) {
        add('transactionNumber', number.text, number.observations);
        break;
      }
    }

    return { kindLabel: LABEL, candidates, findings: [] };
  },
};
