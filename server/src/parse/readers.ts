import type { ParseDoc } from './doc';

// The `DocReaders` port: how recognition turns a material's bytes into the one document model layouts read (ADR-0017).
// Material parsing takes readers as an argument and constructs no engine itself. Adapters:
// - `productionReaders` (`readers-production.ts`): pdfjs for PDFs, the in-process OCR for photos, zxing for QR codes.
//   The only place the engines are constructed.
// - `snapshotReaders` (`snapshot.ts`): a stored document snapshot, so a recognition test needs neither pdfjs nor OCR.
// This module stays free of engine imports, so a test that only needs the port loads none of them.

export interface DocReaders {
  pdf(bytes: Uint8Array): Promise<ParseDoc>;
  image(bytes: Uint8Array): Promise<ParseDoc>;
}

// A reader throws these to have its failure classified (`parseMaterial`); any other error is a parser fault.

// The bytes are not a readable document (corrupt, encrypted, not really a PDF). Nothing a re-run would change and
// nothing a layout could read: the material is unrecognised.
export class UnreadableDocumentError extends Error {
  override name = 'UnreadableDocumentError';
}

// OCR could not run on a photo (a runtime or model fault, not the photo's content): a re-run may succeed.
export class OcrFailedError extends Error {
  override name = 'OcrFailedError';
}

export const reasonOf = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
