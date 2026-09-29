import type { ParseDoc } from './doc';
import { UnreadableDocumentError, type DocReaders } from './readers';

// Media sniffing (介质识别): whether a material is a PDF, an image, an OFD or something recognition cannot read. Owned
// by recognition, so a new format lands here and in `material.ts`, never in the task service.

export type Medium = 'pdf' | 'image' | 'ofd' | 'unsupported';

// A PDF may carry junk before its header; pdfjs finds the header anywhere in the first KiB.
const PDF_HEADER_WINDOW = 1024;
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const IMAGE_FILE = /\.(jpe?g|png)$/i;
// OFD (版式文档, GB/T 33190: the Chinese fixed-layout format some e-invoices ship in) is a ZIP package.
const OFD_FILE = /\.ofd$/i;

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((byte, i) => bytes[i] === byte);

// The medium the upload declared (name, then MIME). Only a fallback: for bytes of no known format, and for materials
// uploaded before the sniffed medium was recorded.
const declaredMedium = (material: { fileName: string; mime: string }): 'pdf' | 'image' =>
  IMAGE_FILE.test(material.fileName) || material.mime.startsWith('image/') ? 'image' : 'pdf';

// What a stored material is shown and printed as (the material list, the print sources, PDFs-first parse order): the
// medium `mediumOf` sniffed at upload (`blob.medium`), so a photo named `.pdf` is an image everywhere, as it is to the
// parser. An OFD or unsupported file has no page recognition can read, and blobs stored before #312 have no sniffed
// medium: those keep the declared one, as before.
export function materialMedium(material: { fileName: string; mime: string; sniffed: string | null }): 'pdf' | 'image' {
  return material.sniffed === 'pdf' || material.sniffed === 'image' ? material.sniffed : declaredMedium(material);
}

// The medium recognition reads a material as. The bytes decide: a photo saved as `.pdf` is read as an image, a PDF
// named `.jpg` as a PDF. Bytes of no known format fall back to the declared medium, so the reader reports them
// unreadable (as it did before sniffing).
export function mediumOf(input: { fileName: string; mime: string; bytes: Uint8Array }): Medium {
  const { bytes, fileName, mime } = input;
  if (startsWith(bytes, JPEG) || startsWith(bytes, PNG)) return 'image';
  if (new TextDecoder('latin1').decode(bytes.subarray(0, PDF_HEADER_WINDOW)).includes('%PDF-')) return 'pdf';
  const ofd = OFD_FILE.test(fileName) || mime.toLowerCase() === 'application/ofd';
  if (startsWith(bytes, ZIP)) return ofd ? 'ofd' : 'unsupported';
  return ofd ? 'ofd' : declaredMedium(input);
}

// The document of a material, through the reader of its sniffed medium.
export async function readDoc(input: { fileName: string; mime: string; bytes: Uint8Array }, readers: DocReaders): Promise<ParseDoc> {
  const medium = mediumOf(input);
  switch (medium) {
    case 'pdf':
      return readers.pdf(input.bytes);
    case 'image':
      return readers.image(input.bytes);
    // No OFD reader yet (spec #296, Out of Scope): OFD support is a `DocReaders.ofd` and this case.
    case 'ofd':
    case 'unsupported':
      throw new UnreadableDocumentError(`not a readable medium: ${medium}`);
  }
}
