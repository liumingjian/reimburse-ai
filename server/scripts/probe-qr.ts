// Read-only: what QR payloads does each PDF actually decode to?
//
// Six 高德打车 invoices in the QA data all decoded to a seventh one's QR. Run this with several blobs in one process
// and then with one blob per process: if the payloads differ between the two, the decode is carrying state across
// documents, and the culprit is a cache above `pdfDoc` rather than anything in the files.
//
// Usage: tsx server/scripts/probe-qr.ts <sha256> [<sha256> ...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractImages } from 'unpdf';
import { openPdf } from '../src/parse/pdf';
import { decodeRaster } from '../src/parse/qr';

const root = process.env['BAOX_DATA_DIR'] ?? '/Users/lmj/baox-qa-data';
const blob = (sha: string) => join(root, 'files', 'sha256', sha.slice(0, 2), sha);

for (const sha of process.argv.slice(2)) {
  const pdf = await openPdf(new Uint8Array(readFileSync(blob(sha))));
  try {
    const images = await extractImages(pdf, 1);
    const codes: string[] = [];
    for (const image of images) codes.push(...(await decodeRaster(image)));
    console.log(JSON.stringify({
      sha: sha.slice(0, 8),
      images: images.map((i) => `${(i as { key?: string }).key ?? '?'} ${i.width}x${i.height}`),
      codes: codes.map((c) => c.slice(0, 48)),
    }));
  } finally {
    await pdf.loadingTask.destroy();
  }
}
