import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { pdfDoc } from './pdf';
import { withQr } from '../test/qr-pdf';

// The parse worker is one long-lived thread that takes every material of every task in turn (ADR-0017), so whatever
// QR decoding carries between documents reaches production. This test is shaped that way on purpose: two documents,
// one process, read one after the other.

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));
const FIRST = '01,32,,26312000000101557402,69.19,20260813,,A1B2C3D4';
const SECOND = '01,32,,26427000000640558021,18.80,20260904,,6735EEEE';

describe('QR decoding', () => {
  it('reads each document on its own: the second is not still the first', async () => {
    const one = await pdfDoc(await withQr(fixture('m03-amap-invoice.pdf'), FIRST));
    const two = await pdfDoc(await withQr(fixture('m05-caocao-invoice.pdf'), SECOND));

    expect(one.codes).toContain(FIRST);
    expect(two.codes).toContain(SECOND);
    expect(two.codes).not.toContain(FIRST);
  });
});
