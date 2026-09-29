import type { ParseDoc } from './doc';
import { dispatch, type ParseOutcome } from './dispatch';
import type { Layout } from './layout';
import { LAYOUTS } from './layouts';
import { OcrFailedError, reasonOf, UnreadableDocumentError, type DocReaders } from './readers';

// One material in, one parser outcome out: read the document model for the medium through `readers`, then dispatch.
// Runs inside the parse worker (`worker.ts`), or inline for tests.

export type ParseInput = { materialId: string; fileName: string; mediaType: 'pdf' | 'image'; bytes: Uint8Array };

export async function parseMaterial(input: ParseInput, readers: DocReaders, layouts: readonly Layout[] = LAYOUTS): Promise<ParseOutcome> {
  let doc: ParseDoc;
  try {
    doc = input.mediaType === 'pdf' ? await readers.pdf(input.bytes) : await readers.image(input.bytes);
  } catch (error) {
    if (error instanceof UnreadableDocumentError) return { outcome: 'unrecognised', reason: 'unreadable_document' };
    return { outcome: 'failed', retryable: error instanceof OcrFailedError, reason: reasonOf(error) };
  }
  try {
    return dispatch(doc, layouts);
  } catch (error) {
    return { outcome: 'failed', retryable: false, reason: reasonOf(error) };
  }
}
