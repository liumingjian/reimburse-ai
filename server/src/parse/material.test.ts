import { describe, expect, it } from 'vitest';
import type { ParseDoc } from './doc';
import { parseMaterial, type ParseInput } from './material';
import { OcrFailedError, UnreadableDocumentError, type DocReaders } from './readers';

// How `parseMaterial` picks a reader and classifies a reader's failure (ADR-0017), through readers that record or fail
// on purpose: no corrupt file and no OCR runtime needed.

const PDF_HEAD = new TextEncoder().encode('%PDF-1.7\n');
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

const input = (fileName: string, mime: string, bytes = new Uint8Array()): ParseInput => ({ materialId: 'm1', fileName, mime, bytes });
const failing = (error: Error): DocReaders => ({
  pdf: () => Promise.reject(error),
  image: () => Promise.reject(error),
});
const EMPTY: ParseDoc = { mediaType: 'pdf', pageCount: 1, observations: [], codes: [] };

// Which reader each material was handed to.
async function readersAsked(...inputs: ParseInput[]): Promise<string[]> {
  const asked: string[] = [];
  const readers: DocReaders = {
    pdf: async () => (asked.push('pdf'), EMPTY),
    image: async () => (asked.push('image'), { ...EMPTY, mediaType: 'image' }),
  };
  for (const one of inputs) await parseMaterial(one, readers);
  return asked;
}

describe('parseMaterial over a failing reader', () => {
  it('reads an unreadable document as unrecognised, not as a failure', async () => {
    expect(await parseMaterial(input('x.pdf', 'application/pdf', PDF_HEAD), failing(new UnreadableDocumentError('InvalidPDFException: Invalid PDF structure.')))).toEqual({
      outcome: 'unrecognised',
      reason: 'unreadable_document',
    });
  });

  it('reads an OCR runtime failure as a retryable failure', async () => {
    expect(await parseMaterial(input('x.jpg', 'image/jpeg', JPEG_HEAD), failing(new OcrFailedError('Error: model load failed')))).toEqual({
      outcome: 'failed',
      retryable: true,
      reason: 'OcrFailedError: Error: model load failed',
    });
  });

  it('reads any other reader error as a parser fault a re-run would not fix', async () => {
    expect(await parseMaterial(input('x.pdf', 'application/pdf', PDF_HEAD), failing(new TypeError('boom')))).toEqual({ outcome: 'failed', retryable: false, reason: 'TypeError: boom' });
  });
});

describe('parseMaterial sniffs the medium from the bytes', () => {
  it('asks the reader of the material’s medium', async () => {
    expect(await readersAsked(input('x.jpg', 'image/jpeg', JPEG_HEAD), input('x.png', 'image/png', PNG_HEAD), input('x.pdf', 'application/pdf', PDF_HEAD))).toEqual(['image', 'image', 'pdf']);
  });

  it('reads a photo saved as .pdf as an image, and a PDF named .jpg as a PDF', async () => {
    expect(await readersAsked(input('IMG_5120.pdf', 'application/pdf', JPEG_HEAD), input('发票.jpg', 'image/jpeg', PDF_HEAD))).toEqual(['image', 'pdf']);
  });

  it('finds a PDF header behind leading junk', async () => {
    expect(await readersAsked(input('scan', '', new Uint8Array([...new TextEncoder().encode('junk\r\n'), ...PDF_HEAD])))).toEqual(['pdf']);
  });

  it('falls back to the declared name, then MIME, for bytes of no known format', async () => {
    expect(await readersAsked(input('x.jpg', 'application/pdf'), input('x.pdf', 'application/pdf'), input('noext', 'image/png'))).toEqual(['image', 'pdf', 'image']);
  });

  it('reads an OFD package, or any other ZIP, as unreadable without asking a reader', async () => {
    const unreadable = { outcome: 'unrecognised', reason: 'unreadable_document' };
    expect(await readersAsked(input('发票.ofd', 'application/octet-stream', ZIP_HEAD), input('发票.pdf', 'application/pdf', ZIP_HEAD), input('发票.ofd', ''))).toEqual([]);
    expect(await parseMaterial(input('发票.ofd', 'application/ofd', ZIP_HEAD), failing(new TypeError('asked')))).toEqual(unreadable);
    expect(await parseMaterial(input('bundle.zip', 'application/zip', ZIP_HEAD), failing(new TypeError('asked')))).toEqual(unreadable);
  });
});
