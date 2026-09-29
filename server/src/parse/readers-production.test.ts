import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { dispatch } from './dispatch';
import { LAYOUTS } from './layouts';
import { UnreadableDocumentError } from './readers';
import { productionReaders } from './readers-production';
import { caseDoc } from './testing/snapshot-cases';

// Smoke tests of the production readers on real bytes, one per engine (the QR decoder's is `qr.test.ts`): the layout
// tests and the snapshot cases read captured documents instead. Also the canary for those captures: when pdfjs or the
// fixtures change what m01 reads as, recapture the `fixture-*` cases (`testing/snapshot-cases.ts`).

const fixture = (file: string) => new Uint8Array(readFileSync(join(GENERATED_DIR, file)));

describe('the production PDF reader', () => {
  it('reads a fixture’s text layer as its snapshot case captured it', async () => {
    expect(await productionReaders.pdf(fixture('m01-hotel-invoice.pdf'))).toMatchObject(caseDoc('fixture-m01-hotel-invoice'));
  });

  it('reports bytes that are not a PDF as an unreadable document', async () => {
    await expect(productionReaders.pdf(new TextEncoder().encode('not a pdf at all'))).rejects.toBeInstanceOf(UnreadableDocumentError);
  });
});

describe('the production image reader (OCR)', () => {
  // OCR boxes are not compared run by run (the model's geometry is not a contract); what the photo reads as is.
  it('reads a photographed folio into boxes the folio layout reads, as its snapshot case does', async () => {
    const doc = await productionReaders.image(fixture('r210-hotel-folio-photo.jpg'));
    expect(doc).toMatchObject({ mediaType: 'image', pageCount: 1 });
    const values = (outcome: ReturnType<typeof dispatch>) => (outcome.outcome === 'recognised' ? Object.fromEntries(outcome.candidates.map((c) => [c.key, c.value])) : outcome);
    expect(values(dispatch(doc, LAYOUTS))).toEqual(values(dispatch(caseDoc('fixture-r210-hotel-folio-photo'), LAYOUTS)));
  }, 120_000);
});
