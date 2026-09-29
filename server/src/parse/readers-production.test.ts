import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { UnreadableDocumentError } from './readers';
import { productionReaders } from './readers-production';

// The production PDF reader on real bytes: the one place pdfjs's own exceptions are mapped onto the port's errors.

describe('the production PDF reader', () => {
  it('reads a fixture’s text layer', async () => {
    const doc = await productionReaders.pdf(new Uint8Array(readFileSync(join(GENERATED_DIR, 'm01-hotel-invoice.pdf'))));
    expect(doc).toMatchObject({ mediaType: 'pdf', pageCount: 1 });
    expect(doc.observations.length).toBeGreaterThan(0);
  });

  it('reports bytes that are not a PDF as an unreadable document', async () => {
    await expect(productionReaders.pdf(new TextEncoder().encode('not a pdf at all'))).rejects.toBeInstanceOf(UnreadableDocumentError);
  });
});
