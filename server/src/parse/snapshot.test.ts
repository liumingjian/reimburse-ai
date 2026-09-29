import { describe, expect, it } from 'vitest';
import type { ParseDoc, TextObservation } from './doc';
import { captureDoc, formatDocSnapshot, parseDocSnapshot, redactDoc, snapshotReaders } from './snapshot';

// The snapshot adapter (`snapshot.ts`): capture, redaction and the stored form, over hand-built documents.

const run = (id: string, x: number, y: number, text: string, extra: Partial<TextObservation> = {}): TextObservation => ({ id, page: 1, x, y, width: 8 * text.length, height: 10, text, raw: text, ...extra });

// A 发票号码 label and its digits drawn one run per glyph beside it, a seller name in one run, and a QR payload.
const NUMBER = '26312000000104412931';
const DOC: ParseDoc = {
  mediaType: 'pdf',
  pageCount: 1,
  codes: [`01,32,,${NUMBER},32.50,20260818,,A1B2C3D4`],
  observations: [
    run('p1.1', 10, 700, '发票号码:'),
    ...[...NUMBER].map((digit, i) => run(`p1.${i + 2}`, 50 + 8 * i, 700, digit)),
    run('p1.30', 10, 600, '名称:某某出行科技(广州)有限公司', { raw: '名称：某某出行科技（广州）有限公司', score: 0.98 }),
    run('p1.31', 10, 500, '合计 ¥32.50'),
  ],
};
const geometry = (doc: ParseDoc) => doc.observations.map(({ id, page, x, y, width, height, score }) => ({ id, page, x, y, width, height, score }));
const texts = (doc: ParseDoc) => doc.observations.map((o) => o.text);

describe('redactDoc', () => {
  const OTHER = '99999000000000000001';
  const redacted = redactDoc(DOC, { [NUMBER]: OTHER, 某某出行科技: '示例网约车平台公司', '32.50': '88.10' });

  it('swaps values and keeps every run, its id and its box', () => {
    expect(geometry(redacted)).toEqual(geometry(DOC));
    expect(texts(redacted).slice(1, 21).join('')).toBe(OTHER);
    expect(texts(redacted)).toContain('名称:示例网约车平台公司(广州)有限公司');
    expect(texts(redacted)).toContain('合计 ¥88.10');
    expect(texts(redacted)[0]).toBe('发票号码:');
  });

  it('rewrites raw with the redacted text, so the unredacted form does not survive in it', () => {
    const seller = redacted.observations.find((o) => o.id === 'p1.30');
    expect(seller).toMatchObject({ raw: seller?.text, score: 0.98 });
    expect(JSON.stringify(redacted)).not.toContain('某某出行科技');
  });

  it('keeps a QR payload’s field structure', () => {
    expect(redacted.codes).toEqual([`01,32,,${OTHER},88.10,20260818,,A1B2C3D4`]);
  });

  it('refuses a replacement of another length for a value drawn across runs', () => {
    expect(() => redactDoc(DOC, { [NUMBER]: '123' })).toThrow(/same length/);
  });

  it('refuses to hand back a document the value is still readable in', () => {
    // Wrapped onto two rows, the name is not in any one row: redacting it whole finds nothing to swap.
    const wrapped: ParseDoc = { ...DOC, codes: [], observations: [run('p1.1', 10, 700, '某某出行'), run('p1.2', 10, 680, '科技有限公司')] };
    expect(() => redactDoc(wrapped, { 某某出行科技有限公司: '示例出行科技有限公司' })).toThrow(/still readable/);
    expect(texts(redactDoc(wrapped, { 某某出行: '示例出行' }))).toEqual(['示例出行', '科技有限公司']);
  });
});

describe('the snapshot reader', () => {
  it('reads the stored document as the medium it was taken from, and refuses the other', async () => {
    await expect(snapshotReaders(DOC).pdf(new Uint8Array())).resolves.toBe(DOC);
    await expect(snapshotReaders(DOC).image(new Uint8Array())).rejects.toThrow(/pdf document, read as image/);
  });

  it('round-trips a capture through its stored form', async () => {
    const captured = await captureDoc({ fileName: 'x.pdf', mime: 'application/pdf', bytes: new Uint8Array() }, snapshotReaders(DOC));
    expect(parseDocSnapshot(formatDocSnapshot(captured))).toEqual(DOC);
    expect(formatDocSnapshot(captured).split('\n').filter((line) => line.includes('"id":'))).toHaveLength(DOC.observations.length);
  });
});
