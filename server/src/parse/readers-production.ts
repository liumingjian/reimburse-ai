import type { ParseDoc } from './doc';
import { ocrImage } from './ocr';
import { pdfDoc } from './pdf';
import { decodeImageFile } from './qr';
import { OcrFailedError, reasonOf, UnreadableDocumentError, type DocReaders } from './readers';

// The production `DocReaders` (`readers.ts`): the only adapter that constructs the PDF, OCR and QR engines. The parse
// worker, the inline executor, the private-corpus gate and the probe use it.

// pdfjs's exceptions for a file that is not a readable PDF (corrupt, encrypted, not really a PDF).
const UNREADABLE_PDF = new Set(['InvalidPDFException', 'PasswordException', 'FormatError', 'MissingPDFException']);

async function readPdf(bytes: Uint8Array): Promise<ParseDoc> {
  try {
    return await pdfDoc(bytes);
  } catch (error) {
    if (error instanceof Error && UNREADABLE_PDF.has(error.name)) throw new UnreadableDocumentError(reasonOf(error));
    throw error;
  }
}

// A photo: text observations from the in-process OCR (`ocr.ts`, loaded on the first image), plus its QR codes.
async function readImage(bytes: Uint8Array): Promise<ParseDoc> {
  const [observations, codes] = await Promise.all([
    ocrImage(bytes).catch((error: unknown) => {
      throw new OcrFailedError(reasonOf(error));
    }),
    decodeImageFile(bytes).catch(() => []),
  ]);
  return { mediaType: 'image', pageCount: 1, observations, codes };
}

export const productionReaders: DocReaders = { pdf: readPdf, image: readImage };
