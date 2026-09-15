import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { dispatch, type Recognised } from '../dispatch';
import { KINDS } from '../kinds';
import { pdfDoc } from '../pdf';
import { LAYOUTS } from '.';
import { rail12306 } from './rail12306';

// Origin: kernel/test/parse.test.mjs (case `长途/26349119423005877606.pdf`: rail e-ticket, only the fare on the face,
// net/tax absent as a face fact) and kernel/test/events.test.mjs (`铁路电子客票：一张票一个事件，乘车日期来自票面`:
// the travel date, not the issue date, is the expense date; net = fare, tax = 0). Inputs are @baox/fixtures m07/m08.

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const SOURCE = 'rule:rail_ticket/12306';

async function recognised(file: string): Promise<Recognised> {
  const outcome = dispatch(await pdfDoc(fixture(file)), LAYOUTS);
  if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
  return outcome;
}
const values = (outcome: Recognised) => Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]));

describe('rail_ticket/12306', () => {
  it('recognises m07 and reads the face: number, issue date, train, stations, travel date and fare', async () => {
    const outcome = await recognised('m07-rail-0809.pdf');
    expect(outcome).toMatchObject({ kind: 'rail_ticket', layout: '12306', parserVersion: rail12306.version, kindLabel: '铁路电子客票', missing: [], findings: [] });
    expect(values(outcome)).toEqual({
      invoiceNumber: '26312000000102200731',
      issueDate: '2026-08-09',
      trainNumber: 'G7522',
      departStation: '杭州东',
      arriveStation: '上海虹桥',
      travelDate: '2026-08-09',
      departTime: '08:30',
      seatClass: '二等座',
      passengerName: '林颂宜',
      totalAmount: '73.00',
    });
    for (const c of outcome.candidates) expect(c).toMatchObject({ source: SOURCE, evidence: 'explicit', refs: [expect.objectContaining({ page: 1 })] });
  });

  it('m08 is the return ticket', async () => {
    expect(values(await recognised('m08-rail-0822.pdf'))).toMatchObject({ invoiceNumber: '26312000000102200744', trainNumber: 'G7539', departStation: '上海虹桥', arriveStation: '杭州东', travelDate: '2026-08-22', totalAmount: '73.00' });
  });

  it('no net amount or tax is read: they are not on the face (kernel: absent, not a parse failure)', async () => {
    const keys = (await recognised('m07-rail-0809.pdf')).candidates.map((c) => c.key);
    expect(keys).not.toContain('netAmount');
    expect(keys).not.toContain('taxAmount');
  });

  it('the kernel 12306 wording also parses: `<站> <车次> <站>` on one line and `YYYY年M月D日HH:MM开`', () => {
    const doc = textDoc(['电子发票(铁路电子客票)', '发票号码:26349119423005877606', '开票日期:2026年09月02日', '合肥南站 G1234 上海虹桥站', '2026年08月22日 07:05开', '票价:¥703.00']);
    const outcome = dispatch(doc, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'rail_ticket', missing: [] });
    if (outcome.outcome !== 'recognised') return;
    // 乘车日期 2026-08-22, not the 开票日期 2026-09-02.
    expect(values(outcome)).toMatchObject({ departStation: '合肥南', trainNumber: 'G1234', arriveStation: '上海虹桥', travelDate: '2026-08-22', departTime: '07:05', totalAmount: '703.00', issueDate: '2026-09-02' });
  });

  it('forms one event: date = travel date, route from the face, net = fare and tax 0, long-distance category', async () => {
    const draft = KINDS.rail_ticket.event(values(await recognised('m07-rail-0809.pdf')));
    expect(draft).toMatchObject({
      category: { code: 'long_distance', label: '长途交通' },
      summary: 'G7522 杭州东 → 上海虹桥',
      date: '2026-08-09',
      endDate: null,
      grossAmount: '73.00',
      netAmount: '73.00',
      taxAmount: '0.00',
      maskedNumber: '2631************0731',
      route: '杭州东 → 上海虹桥',
      origin: '杭州东',
      destination: '上海虹桥',
    });
    expect(KINDS.rail_ticket.categoryLabel(values(await recognised('m07-rail-0809.pdf')))).toBe('长途交通');
  });

  it('is not recognised on e-invoices or itineraries, and no other layout recognises a rail ticket', async () => {
    for (const file of ['m01-hotel-invoice.pdf', 'm03-amap-invoice.pdf', 'm04-amap-itinerary.pdf']) expect(rail12306.recognise(await pdfDoc(fixture(file)))).toBe(false);
    const doc = await pdfDoc(fixture('m07-rail-0809.pdf'));
    expect(LAYOUTS.filter((layout) => layout.recognise(doc)).map((layout) => layout.name)).toEqual(['12306']);
  });

  it('reports an unreadable fare as missing instead of guessing it', async () => {
    const doc = await pdfDoc(fixture('m07-rail-0809.pdf'));
    expect(dispatch({ ...doc, observations: doc.observations.filter((o) => !o.text.startsWith('票价')) }, LAYOUTS)).toMatchObject({ outcome: 'recognised', missing: ['totalAmount'] });
  });
});

// A one-column text document, one observation per line, top to bottom.
function textDoc(lines: string[]) {
  return {
    mediaType: 'pdf' as const,
    pageCount: 1,
    codes: [],
    observations: lines.map((text, i) => ({ id: `p1.${i + 1}`, page: 1, x: 40, y: 800 - i * 20, width: 200, height: 12, text, raw: text })),
  };
}
