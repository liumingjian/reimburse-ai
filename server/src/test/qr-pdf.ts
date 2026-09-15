import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from '@cantoo/pdf-lib';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';

// Test helper: a copy of a fixture PDF with a real QR code drawn over its placeholder box, so the parser's second
// evidence source can be exercised (the generated fixtures only print the word 二维码).

const require = createRequire(import.meta.url);
let prepared: Promise<unknown> | null = null;

export async function withQr(pdfBytes: Uint8Array, payload: string): Promise<Uint8Array> {
  if (!prepared) {
    const binary = readFileSync(require.resolve('zxing-wasm/writer/zxing_writer.wasm'));
    const wasmBinary = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
    prepared = Promise.resolve(prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true }));
  }
  await prepared;
  const { image, error } = await writeBarcode(payload, { format: 'QRCode', sizeHint: 240, withQuietZones: true });
  if (!image) throw new Error(`QR encoding failed: ${error}`);
  const pdf = await PDFDocument.load(pdfBytes);
  const png = await pdf.embedPng(new Uint8Array(await image.arrayBuffer()));
  // Over the placeholder box in the top-left corner of the invoice face.
  pdf.getPage(0).drawImage(png, { x: 40, y: 700, width: 96, height: 96 });
  return pdf.save();
}
