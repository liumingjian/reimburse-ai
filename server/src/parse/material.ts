import type { ParseDoc } from './doc';
import { dispatch, type ParseOutcome } from './dispatch';
import type { Layout } from './layout';
import { LAYOUTS } from './layouts';
import { readDoc } from './media';
import { OcrFailedError, reasonOf, UnreadableDocumentError, type DocReaders } from './readers';

// One material in, one parser outcome out: read the document model through the reader of the material's sniffed
// medium (`media.ts`), then dispatch. Runs inside the parse worker (`worker.ts`), or inline for tests.

// `mime` is the type the original was stored under; recognition decides the medium itself, from the bytes.
export type ParseInput = { materialId: string; fileName: string; mime: string; bytes: Uint8Array };

export async function parseMaterial(input: ParseInput, readers: DocReaders, layouts: readonly Layout[] = LAYOUTS): Promise<ParseOutcome> {
  let doc: ParseDoc;
  try {
    doc = await readDoc(input, readers);
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
