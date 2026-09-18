import { cents, compact, money, type ParseDoc, type TextObservation } from '../doc';
import { ruleSource, type Candidate, type EvidenceRef, type Finding, type Layout } from '../layout';

// `taxi_receipt/machine_printed`: the paper 出租汽车发票 (taxi receipt) strip printed by the meter, read from a photo
// by the OCR adapter (`ocr.ts`) after 透视矫正 (perspective correction). Every face fact here comes from OCR, so it is
// `fact_correctable` (ADR-0017): the user may re-transcribe it from the original, and every check still applies.
//
// The strip is a two-column list: label on the left, value on the right of the same printed row.

const KIND = 'taxi_receipt';
const NAME = 'machine_printed';
const VERSION = '1';
const SOURCE = ruleSource(KIND, NAME);
// The strip prints `YY-MM-DD`; the century is supplied by rule.
export const YEAR_SOURCE = ruleSource(KIND, NAME, 'year_from_suffix');
// The 开票地区码 (invoice region code) of the 发票代码 names the city when it is a city-level code.
export const CITY_SOURCE = ruleSource(KIND, NAME, 'city_from_code_region');

// Hard anchors: the title and the 发票代码 label.
const TITLE = /^(\p{Script=Han}{2,6}?)市?出租(?:汽)?车(?:车费)?(?:统一)?发票/u;
const LABELS = {
  invoiceCode: '发票代码',
  invoiceNumber: '发票号码',
  plate: '车号',
  travelDate: '日期',
  boardTime: '上车',
  alightTime: '下车',
  distance: '里程',
  totalAmount: '金额',
} as const;

const CODE = /^\d{12}$/;
const NUMBER = /^\d{8}$/;
const SHORT_DATE = /^(\d{2})[-./](\d{2})[-./](\d{2})$/;
const LONG_DATE = /^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/;
const TIME = /^(\d{2}):(\d{2})$/;
const KM = /^(\d+(?:\.\d+)?)(?:km|公里)$/i;

// 开票地区码: digits 2–5 of a 12-digit 发票代码 are the tax region's administrative-division prefix. Only codes that
// name one city are listed (直辖市 and 计划单列市, which issue their own codes); a province-level code names no city,
// and an unlisted code yields no city candidate rather than a guess.
const CITY_OF_REGION: Readonly<Record<string, string>> = {
  '1100': '北京',
  '1200': '天津',
  '3100': '上海',
  '5000': '重庆',
  '2102': '大连',
  '3302': '宁波',
  '3502': '厦门',
  '3702': '青岛',
  '4403': '深圳',
};

export function cityOfInvoiceCode(code: string): string | null {
  return CODE.test(code) ? (CITY_OF_REGION[code.slice(1, 5)] ?? null) : null;
}

const ref = (...observations: TextObservation[]): EvidenceRef[] =>
  observations.length ? [{ page: observations[0]?.page ?? 1, observationIds: observations.map((o) => o.id), text: observations.map((o) => o.raw).join(' ') }] : [];

const find = (doc: ParseDoc, pattern: RegExp) => doc.observations.find((o) => pattern.test(compact(o.text)));
const centre = (o: TextObservation) => o.y + o.height / 2;

// The value printed on the same row as a label: the right-most observation right of it whose vertical centre lies
// within the label's height. OCR sometimes keeps the label and value in one box; then the rest of that box counts.
function valueOf(doc: ParseDoc, label: string): TextObservation | null {
  const labelObservation = doc.observations.find((o) => compact(o.text) === label || (compact(o.text).startsWith(label) && compact(o.text).length > label.length));
  if (!labelObservation) return null;
  const text = compact(labelObservation.text);
  if (text !== label) return { ...labelObservation, text: text.slice(label.length).replace(/^[:：]/, ''), raw: compact(labelObservation.raw).slice(label.length).replace(/^[:：]/, '') };
  const tolerance = Math.max(labelObservation.height * 0.6, 4);
  const sameRow = doc.observations.filter((o) => o !== labelObservation && o.x > labelObservation.x + labelObservation.width && Math.abs(centre(o) - centre(labelObservation)) <= tolerance);
  return sameRow.sort((a, b) => b.x - a.x)[0] ?? null;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const pad = (value: string | number) => String(value).padStart(2, '0');

export const machinePrinted: Layout = {
  kind: KIND,
  name: NAME,
  version: VERSION,
  label: '出租车车费发票（机打）',

  recognise(doc) {
    return doc.mediaType === 'image' && Boolean(find(doc, TITLE)) && valueOf(doc, LABELS.invoiceCode) !== null;
  },

  parse(doc) {
    const candidates: Candidate[] = [];
    const findings: Finding[] = [];
    const add = (key: string, value: string, source: string, evidence: Candidate['evidence'], ...observations: TextObservation[]) => {
      candidates.push({ key, value, source, parserVersion: VERSION, evidence, refs: ref(...observations) });
    };
    const read = (key: keyof typeof LABELS) => {
      const observation = valueOf(doc, LABELS[key]);
      return observation ? { observation, text: compact(observation.text) } : null;
    };

    const code = read('invoiceCode');
    if (code && CODE.test(code.text)) add('invoiceCode', code.text, SOURCE, 'explicit', code.observation);
    const number = read('invoiceNumber');
    if (number && NUMBER.test(number.text)) add('invoiceNumber', number.text, SOURCE, 'explicit', number.observation);
    const plate = read('plate');
    if (plate) add('plate', compact(plate.observation.raw), SOURCE, 'explicit', plate.observation);

    const date = read('travelDate');
    if (date) {
      const long = LONG_DATE.exec(date.text);
      const short = SHORT_DATE.exec(date.text);
      const [year, month, day, source] = long
        ? [Number(long[1]), Number(long[2]), Number(long[3]), SOURCE]
        : short
          ? [2000 + Number(short[1]), Number(short[2]), Number(short[3]), YEAR_SOURCE]
          : [0, 0, 0, SOURCE];
      if (year && validDate(year, month, day)) add('travelDate', `${year}-${pad(month)}-${pad(day)}`, source, source === SOURCE ? 'explicit' : 'derived', date.observation);
      else findings.push({ kind: 'validation', code: 'invalid_date', message: `日期「${compact(date.observation.raw)}」不是有效日期，请对照原件修正。` });
    }

    for (const key of ['boardTime', 'alightTime'] as const) {
      const time = read(key);
      const match = time ? TIME.exec(time.text) : null;
      if (time && match && Number(match[1]) < 24 && Number(match[2]) < 60) add(key, time.text, SOURCE, 'explicit', time.observation);
    }

    const km = read('distance');
    const kmMatch = km ? KM.exec(km.text) : null;
    if (km && kmMatch) add('distance', `${kmMatch[1]} km`, SOURCE, 'explicit', km.observation);

    // 金额: OCR may read the ¥ sign as another glyph, so everything before the digits is dropped.
    const amount = read('totalAmount');
    const amountCents = amount ? cents(amount.text.replace(/^[^\d-]+/, '')) : null;
    if (amount && amountCents !== null) add('totalAmount', money(amountCents), SOURCE, 'explicit', amount.observation);

    const title = find(doc, TITLE);
    const titleCity = title ? (TITLE.exec(compact(title.text))?.[1] ?? null) : null;
    const codeCity = code ? cityOfInvoiceCode(code.text) : null;
    if (codeCity && code) add('city', codeCity, CITY_SOURCE, 'derived', code.observation);
    if (codeCity && titleCity && titleCity !== codeCity) {
      findings.push({ kind: 'advisory', code: 'city_mismatch', message: `发票代码的开票地区是${codeCity}，票头印的是${titleCity}；城市按发票代码。` });
    }

    return { kindLabel: '出租车车费发票（照片）', candidates, findings };
  },
};
