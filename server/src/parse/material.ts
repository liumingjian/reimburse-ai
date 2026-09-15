import type { ParseDoc } from './doc';
import { dispatch, type ParseOutcome } from './dispatch';
import type { Layout } from './layout';
import { LAYOUTS } from './layouts';
import { pdfDoc } from './pdf';
import { decodeImageFile } from './qr';

// One material in, one parser outcome out: build the document model for the medium, then dispatch. Runs inside the
// parse worker (`worker.ts`), or inline for tests.

export type ParseInput = { materialId: string; fileName: string; mediaType: 'pdf' | 'image'; bytes: Uint8Array };

// Images get QR codes only until the OCR adapter (#186) adds text observations; with none, no layout recognises them.
async function imageDoc(bytes: Uint8Array): Promise<ParseDoc> {
  return { mediaType: 'image', pageCount: 1, observations: [], codes: await decodeImageFile(bytes).catch(() => []) };
}

// pdfjs's exceptions for a file that is not a readable PDF (corrupt, encrypted, not really a PDF). Nothing a re-run
// would change, and nothing a layout could read: unrecognised. Any other error is a parser fault: failed.
const UNREADABLE_PDF = new Set(['InvalidPDFException', 'PasswordException', 'FormatError', 'MissingPDFException']);

const reasonOf = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export async function parseMaterial(input: ParseInput, layouts: readonly Layout[] = LAYOUTS): Promise<ParseOutcome> {
  let doc: ParseDoc;
  try {
    doc = input.mediaType === 'pdf' ? await pdfDoc(input.bytes) : await imageDoc(input.bytes);
  } catch (error) {
    if (error instanceof Error && UNREADABLE_PDF.has(error.name)) return { outcome: 'unrecognised', reason: 'unreadable_document' };
    return { outcome: 'failed', retryable: false, reason: reasonOf(error) };
  }
  try {
    return dispatch(doc, layouts);
  } catch (error) {
    return { outcome: 'failed', retryable: false, reason: reasonOf(error) };
  }
}
