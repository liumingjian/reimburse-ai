import { describe, expect, it } from 'vitest';
import type { ParseDoc } from './doc';
import { parseMaterial, type ParseInput } from './material';
import { OcrFailedError, UnreadableDocumentError, type DocReaders } from './readers';

// How `parseMaterial` classifies a reader's failure (ADR-0017), through a reader that fails on purpose: no corrupt
// file and no OCR runtime needed.

const input = (mediaType: ParseInput['mediaType']): ParseInput => ({ materialId: 'm1', fileName: `x.${mediaType === 'pdf' ? 'pdf' : 'jpg'}`, mediaType, bytes: new Uint8Array() });
const failing = (error: Error): DocReaders => ({
  pdf: () => Promise.reject(error),
  image: () => Promise.reject(error),
});
const EMPTY: ParseDoc = { mediaType: 'pdf', pageCount: 1, observations: [], codes: [] };

describe('parseMaterial over a failing reader', () => {
  it('reads an unreadable document as unrecognised, not as a failure', async () => {
    expect(await parseMaterial(input('pdf'), failing(new UnreadableDocumentError('InvalidPDFException: Invalid PDF structure.')))).toEqual({
      outcome: 'unrecognised',
      reason: 'unreadable_document',
    });
  });

  it('reads an OCR runtime failure as a retryable failure', async () => {
    expect(await parseMaterial(input('image'), failing(new OcrFailedError('Error: model load failed')))).toEqual({
      outcome: 'failed',
      retryable: true,
      reason: 'OcrFailedError: Error: model load failed',
    });
  });

  it('reads any other reader error as a parser fault a re-run would not fix', async () => {
    expect(await parseMaterial(input('pdf'), failing(new TypeError('boom')))).toEqual({ outcome: 'failed', retryable: false, reason: 'TypeError: boom' });
  });

  it('asks the reader of the material’s medium', async () => {
    const asked: string[] = [];
    const readers: DocReaders = {
      pdf: async () => (asked.push('pdf'), EMPTY),
      image: async () => (asked.push('image'), { ...EMPTY, mediaType: 'image' }),
    };
    await parseMaterial(input('image'), readers);
    await parseMaterial(input('pdf'), readers);
    expect(asked).toEqual(['image', 'pdf']);
  });
});
