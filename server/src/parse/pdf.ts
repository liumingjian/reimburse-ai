import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { definePDFJSModule, extractImages, getDocumentProxy } from 'unpdf';
import type { PDFDocumentProxy } from 'unpdf/pdfjs';
import { normalise, type ParseDoc, type TextObservation } from './doc';
import { decodeRaster } from './qr';

// The PDF adapter: unpdf over the pinned `pdfjs-dist` (the version unpdf is built against), text observations from
// every page's text layer, and QR payloads from the embedded images.

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
// pdfjs reads CMaps (GBK-EUC-H on rail tickets, UniGB-UCS2-H on ride-hailing invoices) through its Node file reader,
// which takes a plain filesystem path. unpdf's own default is a file:// URL, which that reader cannot open.
const CMAP_URL = join(PDFJS_ROOT, 'cmaps') + sep;
const STANDARD_FONT_DATA_URL = join(PDFJS_ROOT, 'standard_fonts') + sep;

let configured: Promise<void> | null = null;

// A pdfjs document over a copy of `bytes` (pdfjs transfers, i.e. detaches, the buffer it is given). The caller
// destroys it with `pdf.loadingTask.destroy()`. Also used by the print sheet (#190) to measure and render pages.
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  configured ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  await configured;
  return getDocumentProxy(new Uint8Array(bytes), {
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    disableFontFace: true,
  });
}

export async function pdfDoc(bytes: Uint8Array): Promise<ParseDoc> {
  const pdf = await openPdf(bytes);
  try {
    const observations: TextObservation[] = [];
    const codes: string[] = [];
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const content = await (await pdf.getPage(page)).getTextContent();
      let n = 0;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const text = normalise(item.str);
        if (!text) continue;
        n += 1;
        observations.push({ id: `p${page}.${n}`, page, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width, height: item.height, text, raw: item.str });
      }
      for (const image of await extractImages(pdf, page)) codes.push(...(await decodeRaster(image)));
    }
    return { mediaType: 'pdf', pageCount: pdf.numPages, observations, codes };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
