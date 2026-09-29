import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { compact, joinedRows, matchSpan, type ParseDoc, type TextObservation } from '../doc';
import { dispatch } from '../dispatch';
import { KINDS } from '../kinds';
import { parseMaterial } from '../material';
import { pdfDoc } from '../pdf';
import { productionReaders } from '../readers-production';
import { einvoice, QR_SOURCE, readQr } from './einvoice';
import { LAYOUTS } from '.';

// Unit tests of the `vat_invoice/einvoice` layout on the real text layer of @baox/fixtures (the PDF adapter inline,
// no worker), with QR payloads injected into the document model.

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const AMAP_QR = '01,32,,26312000000101557402,69.19,20260813,,A1B2C3D4';

describe('vat_invoice/einvoice', () => {
  it('recognises m01 and fills every required slot', async () => {
    const outcome = await parseMaterial({ materialId: 'm01', fileName: '全季酒店_发票.pdf', mediaType: 'pdf', bytes: fixture('m01-hotel-invoice.pdf') }, productionReaders);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', parserVersion: einvoice.version, kindLabel: '全电发票（专票）', missing: [] });
  });

  it('keeps evidence refs to the text observations a value came from', async () => {
    const outcome = dispatch(await pdfDoc(fixture('m03-amap-invoice.pdf')), LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    const number = outcome.candidates.find((c) => c.key === 'invoiceNumber');
    expect(number?.refs).toEqual([{ page: 1, observationIds: [expect.stringMatching(/^p1\.\d+$/)], text: '发票号码：26312000000101557402' }]);
  });

  // #200: anchors match joined rows, so a face split into several text runs reads like any other.
  it('recognises r01, whose 发票号码 label and digits are separate text runs', async () => {
    const doc = await pdfDoc(fixture('r01-einvoice-split-number.pdf'));
    // The fixture really splits them: no single observation carries label and digits together.
    expect(doc.observations.some((o) => /^发票号码:\d{20}$/.test(compact(o.text)))).toBe(false);

    const outcome = dispatch(doc, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（专票）', missing: [] });
    if (outcome.outcome !== 'recognised') throw new Error('expected recognised');
    const number = outcome.candidates.find((c) => c.key === 'invoiceNumber');
    expect(number?.value).toBe('26312000000098127801');
    // Evidence names every observation the row was joined from, and only real ones.
    const ids = new Set(doc.observations.map((o) => o.id));
    expect(number?.refs[0]?.observationIds.length).toBeGreaterThan(1);
    for (const id of number?.refs[0]?.observationIds ?? []) expect(ids.has(id)).toBe(true);
  });

  it('recognises r02, whose title is letter-spaced across runs', async () => {
    const doc = await pdfDoc(fixture('r02-einvoice-spaced-title.pdf'));
    expect(doc.observations.some((o) => /^电子发票\(.+\)$/.test(compact(o.text)))).toBe(false);

    const outcome = dispatch(doc, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（普票）', missing: [] });
  });

  it('recognises an invoice that bundles an unrelated fee row beside a v1 service row, and takes its totals from the 合计 row', async () => {
    const doc = await pdfDoc(fixture('r201-bundled-fee-invoice.pdf'));
    const outcome = dispatch(doc, LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', missing: [] });
    // 47.38 + 1.60 is the 合计 row over both item rows; the leading 运输服务 row alone is 41.55 + 1.25.
    expect(Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]))).toMatchObject({
      itemName: '*运输服务*客运服务费',
      netAmount: '47.38',
      taxAmount: '1.60',
      totalAmount: '48.98',
    });
    expect(outcome.findings.filter((f) => f.kind === 'validation')).toEqual([]);
    // The bundled row is inside that total, so it is said out loud rather than passed over in silence.
    expect(outcome.findings).toContainEqual({ kind: 'advisory', code: 'bundled_items', message: '这张发票还开了：*经纪代理服务*平台服务费，价税合计把它们一起算了。' });

    // Take the v1 service row away and nothing is left that this layout covers.
    const noV1 = { ...doc, observations: doc.observations.map((o) => (o.text.includes('运输服务') ? { ...o, text: o.text.replace('运输服务', '餐饮服务') } : o)) };
    expect(einvoice.recognise(noV1)).toBe(false);
  });

  // #206: the shapes the real corpus showed — a 交通运输服务 item row, and anchors that share a baseline with the field
  // printed beside them, so a whole joined row matches nothing.
  it('recognises r206, a 交通运输服务 invoice whose 发票号码 and 开票日期 share one baseline', async () => {
    const doc = await pdfDoc(fixture('r206-transport-invoice.pdf'));
    // The fixture really shares baselines: the row carrying 发票号码 carries 开票日期 too, and the title row carries the
    // 联次 beside it, so neither row reads as one anchor.
    const lines = joinedRows(doc);
    for (const pattern of [/^电子发票\((增值税专用发票|普通发票)\)$/, /^发票号码:(\d{20})$/, /^开票日期:(\d{4})年(\d{2})月(\d{2})日$/]) {
      expect(lines.some((row) => pattern.test(row.text))).toBe(false);
      expect(matchSpan(lines, pattern)).not.toBeNull();
    }

    const outcome = dispatch(doc, LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（普票）', missing: [] });
    expect(Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]))).toMatchObject({
      invoiceNumber: '26312000000104412906',
      issueDate: '2026-08-17',
      invoiceType: '普票',
      itemName: '*交通运输服务*客运服务费',
      netAmount: '26.69',
      taxAmount: '0.80',
      totalAmount: '27.49',
    });
    expect(outcome.findings.filter((f) => f.kind === 'validation')).toEqual([]);
    // 交通运输服务 lands in the same 市内交通 category 运输服务 does: no new category, no new kind.
    const values = Object.fromEntries(outcome.candidates.filter((c) => c.source === `rule:${outcome.kind}/${outcome.layout}`).map((c) => [c.key, c.value]));
    expect(KINDS.vat_invoice.categoryLabel(values)).toBe('市内交通');
  });

  // #199: the goods table of a real face is not laid out the way a hand-written HTML table is. The column header is
  // centred over a column far wider than the label, while the cell under it is left-aligned at the column's border —
  // so the 项目名称 cell and the 合计 label are printed left of the 项目名称 header's own left edge.
  it('reads the item table of r207, whose 项目名称 cell and 合计 label are drawn left of the centred header', async () => {
    const doc = await pdfDoc(fixture('r207-einvoice-wide-name-column.pdf'));
    // The fixture really carries the quirk: both cells end left of where the header label starts.
    const header = doc.observations.find((o) => compact(o.text) === '项目名称');
    const item = doc.observations.find((o) => compact(o.text).startsWith('*交通运输服务*'));
    const total = doc.observations.find((o) => compact(o.text) === '合计');
    expect(header).toBeDefined();
    for (const left of [item, total]) {
      expect(left).toBeDefined();
      expect((left?.x ?? 0) + (left?.width ?? 0) / 2).toBeLessThan(header?.x ?? 0);
    }

    const outcome = dispatch(doc, LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', missing: [] });
    expect(Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]))).toMatchObject({
      itemName: '*交通运输服务*客运服务费',
      netAmount: '31.55',
      taxAmount: '0.95',
      totalAmount: '32.50',
    });
    expect(outcome.findings.filter((f) => f.kind === 'validation')).toEqual([]);
  });

  it('reads a 项目名称 wrapped onto a second line (r208) as the whole name', async () => {
    const doc = await pdfDoc(fixture('r208-einvoice-wrapped-item-name.pdf'));
    // The fixture really wraps the name: no row carries the whole of it, and the tail is a row of its own.
    const whole = '*交通运输服务*客运服务费(含高速费、停车费、预约调度费)';
    const lines = joinedRows(doc, 1, 5);
    expect(lines.some((row) => row.text.includes(whole))).toBe(false);
    expect(lines.some((row) => whole.includes(row.text) && row.text.length > 1)).toBe(true);

    const outcome = dispatch(doc, LAYOUTS);
    if (outcome.outcome !== 'recognised') throw new Error(`expected recognised, got ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', missing: [] });
    expect(Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value]))).toMatchObject({
      itemName: '*交通运输服务*客运服务费（含高速费、停车费、预约调度费）',
      netAmount: '46.60',
      taxAmount: '1.40',
      totalAmount: '48.00',
    });
    expect(outcome.findings.filter((f) => f.kind === 'validation')).toEqual([]);
  });

  // The third shape the real corpus showed: a cell wider than its column. A 单价 printed to thirteen decimals reaches
  // back under 项目名称, and its centre falls left of its own header — so where the cell's centre is says nothing, and
  // the name cell would otherwise carry the price.
  it('keeps a 单价 too wide for its column out of the 项目名称 cell', () => {
    const doc = boxDoc([
      ['项目名称', 67.5, 700, 36], ['单价', 214.5, 700, 27], ['数量', 299.5, 700, 27], ['金额', 387.5, 700, 27], ['税率/征收率', 436.8, 700, 49.5], ['税额', 554.5, 700, 27],
      ['*交通运输服务*客运服务费', 16, 688, 106.6], ['34.1584158415842', 177, 688, 64.5], ['1', 322.3, 688, 4.2], ['31.55', 395.7, 688, 18.8], ['3%', 455.8, 688, 11.3], ['0.95', 567.9, 688, 14.6],
      ['合', 60.5, 676, 9], ['计', 105.5, 676, 9], ['¥31.55', 386.7, 676, 27.8], ['¥0.95', 558.9, 676, 23.6],
      ['价税合计(大写)', 49.5, 664, 72], ['(小写)', 408.5, 664, 36], ['¥32.50', 446, 664, 36.2],
    ]);
    // The row really carries the quirk: the price run starts left of where 单价 is printed, and its centre lands left
    // of that header, while the item name and the 合计 label start left of 项目名称.
    const price = doc.observations.find((o) => o.text.startsWith('34.'));
    expect((price?.x ?? 0) + (price?.width ?? 0) / 2).toBeLessThan(214.5);
    expect(price?.x).toBeLessThan(214.5);

    const values = Object.fromEntries(einvoice.parse(doc).candidates.map((c) => [c.key, c.value]));
    expect(values).toMatchObject({ itemName: '*交通运输服务*客运服务费', netAmount: '31.55', taxAmount: '0.95', totalAmount: '32.50' });
  });

  // A real face draws a value one text run per glyph (ADR-0003). Every anchor here is a span match, and a span that
  // satisfies the anchor is not yet the value: the fragments of a value satisfy it too.
  it('reads a 价税合计 drawn glyph by glyph as the whole amount, not as the fragment 0.00', () => {
    const doc = textDoc([['价税合计(大写)', '伍佰陆拾圆整', '(小写)', ...glyphs('¥560.00')]]);
    // The fixture really splits it: no single observation carries the amount.
    expect(doc.observations.some((o) => o.text.includes('560'))).toBe(false);
    const values = Object.fromEntries(einvoice.parse(doc).candidates.map((c) => [c.key, c.value]));
    expect(values['totalAmount']).toBe('560.00');
  });

  it('reads a 名称 drawn glyph by glyph as the whole company name, not as its first character', () => {
    const doc = textDoc([['名称:', ...glyphs('某某科技(上海)有限公司'), '名称:', ...glyphs('上海某某酒店管理有限公司')]]);
    expect(doc.observations.some((o) => o.text.length > 3)).toBe(false);
    const values = Object.fromEntries(einvoice.parse(doc).candidates.map((c) => [c.key, c.value]));
    // The two parties are printed on one baseline, so the widest reading must stop at the next label, not swallow it.
    expect(values['buyerName']).toBe('某某科技(上海)有限公司');
    expect(values['sellerName']).toBe('上海某某酒店管理有限公司');
  });

  it('does not recognise an e-invoice outside the v1 kinds (m11, 餐饮) or a document without the invoice title (m06)', async () => {
    expect(einvoice.recognise(await pdfDoc(fixture('m11-other-invoice.pdf')))).toBe(false);
    expect(einvoice.recognise(await pdfDoc(fixture('m06-caocao-itinerary.pdf')))).toBe(false);
  });

  it('reads a 全电 QR payload; anything else is not one', () => {
    expect(readQr(AMAP_QR)).toEqual({ invoiceNumber: '26312000000101557402', issueDate: '2026-08-13', totalAmount: '69.19', invoiceType: '普票' });
    expect(readQr('01,31,,26312000000098127734,3640,20260822,,X')).toMatchObject({ totalAmount: '3640.00', invoiceType: '专票' });
    expect(readQr('https://example.com/not-an-invoice')).toBeNull();
  });

  it('a QR that agrees with the face adds its candidates and a note; one that disagrees is a note too, never a 待确认项', async () => {
    const doc = await pdfDoc(fixture('m03-amap-invoice.pdf'));

    const agreed = dispatch({ ...doc, codes: [AMAP_QR] }, LAYOUTS);
    if (agreed.outcome !== 'recognised') throw new Error('expected recognised');
    expect(agreed.candidates.filter((c) => c.source === QR_SOURCE).map((c) => c.key).sort()).toEqual(['invoiceNumber', 'invoiceType', 'issueDate', 'totalAmount']);
    expect(agreed.findings).toEqual([{ kind: 'advisory', code: 'qr_match', message: '二维码核对一致：发票号码、开票日期、价税合计、票种' }]);

    // A disagreement is reported and nothing more: the face stays the value, and no finding of a blocking kind is
    // raised (ADR-0017, amended). The QR is read, kept and shown; it judges nothing.
    const tampered = dispatch({ ...doc, codes: [AMAP_QR.replace('69.19', '96.19')] }, LAYOUTS);
    if (tampered.outcome !== 'recognised') throw new Error('expected recognised');
    expect(tampered.findings).toEqual([
      { kind: 'advisory', code: 'qr_differs', message: '二维码与票面不一致，仅作提示，以票面为准：价税合计 票面 69.19，二维码 96.19' },
    ]);
    expect(tampered.findings.every((f) => f.kind === 'advisory')).toBe(true);

    const unreadable = dispatch(doc, LAYOUTS);
    if (unreadable.outcome !== 'recognised') throw new Error('expected recognised');
    expect(unreadable.findings).toEqual([expect.objectContaining({ kind: 'advisory', code: 'qr_unreadable' })]);
  });

  it('reports a required slot it could not read as missing instead of guessing it', async () => {
    const doc = await pdfDoc(fixture('m05-caocao-invoice.pdf'));
    const withoutGross = { ...doc, observations: doc.observations.filter((o) => o.text !== '¥38.40') };
    expect(dispatch(withoutGross, LAYOUTS)).toMatchObject({ outcome: 'recognised', missing: ['totalAmount'] });
  });

  it('flags amounts that do not conserve as a validation finding', async () => {
    const doc = await pdfDoc(fixture('m05-caocao-invoice.pdf'));
    const altered = { ...doc, observations: doc.observations.map((o) => (o.text === '¥38.40' ? { ...o, text: '¥38.41' } : o)) };
    const outcome = dispatch(altered, LAYOUTS);
    expect(outcome).toMatchObject({ outcome: 'recognised', findings: expect.arrayContaining([expect.objectContaining({ kind: 'validation', code: 'total_not_conserved' })]) });
  });
});

// A one-column text document, one line per visual row, top to bottom. A line given as several strings is drawn as
// several text runs on that row, edge to edge — what a real face does with a label apart from its value, and with a
// value drawn one run per glyph.
function textDoc(lines: readonly (string | readonly string[])[]): ParseDoc {
  const observations: TextObservation[] = [];
  for (const [i, line] of lines.entries()) {
    let x = 40;
    for (const text of typeof line === 'string' ? [line] : line) {
      const width = text.length * 9;
      observations.push({ id: `p1.${observations.length + 1}`, page: 1, x, y: 800 - i * 20, width, height: 12, text, raw: text });
      x += width;
    }
  }
  return { mediaType: 'pdf', pageCount: 1, codes: [], observations };
}

const glyphs = (text: string) => [...text];

// A document of placed text runs: `[text, x, y, width]` in PDF user space, for a table whose cells are wider or
// narrower than the header they belong under.
function boxDoc(runs: readonly (readonly [string, number, number, number])[]): ParseDoc {
  const observations = runs.map(([text, x, y, width], i) => ({ id: `p1.${i + 1}`, page: 1, x, y, width, height: 9, text, raw: text }));
  return { mediaType: 'pdf', pageCount: 1, codes: [], observations };
}
