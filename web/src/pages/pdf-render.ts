// A PDF original rendered to one image (pages stacked top to bottom) with pdf.js, so the original viewer shows it
// like a photo: fitted to the frame, with zoom and rotate. The browser's own PDF viewer inside an iframe opened small,
// with its own thumbnails and toolbar, and was slow to paint (QA 2026-09-30).
// pdf.js is loaded on first use and runs on the main thread (no worker file), which also works in the single-file
// mock build. Callers fall back to the iframe when rendering fails (file:// cannot be fetched, no canvas in jsdom).

// Rendered width in CSS pixels before the device pixel ratio; wide enough for 2x zoom in the viewer.
const TARGET_WIDTH = 1200;
// A folio has one or two pages; beyond this the canvas grows past what browsers allow.
export const MAX_PAGES = 6;
const PAGE_GAP = 16;

export type RenderedPdf = { url: string; pageCount: number; shownPages: number };

type PdfJs = typeof import('pdfjs-dist');

let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    // pdf.js runs its worker code in-thread when the worker module is on globalThis.pdfjsWorker.
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import('pdfjs-dist');
  })();
  return pdfjs;
}

// Copied next to the built page by the Vite plugin in vite.config.ts; missing in the mock build, where the fixture
// PDFs embed their fonts.
const CMAP_URL = './pdfjs/cmaps/';
const STANDARD_FONT_DATA_URL = './pdfjs/standard_fonts/';

export async function renderPdf(url: string, signal?: AbortSignal): Promise<RenderedPdf> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({ url, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: STANDARD_FONT_DATA_URL });
  signal?.addEventListener('abort', () => void task.destroy());
  const pdf = await task.promise;
  try {
    const shownPages = Math.min(pdf.numPages, MAX_PAGES);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const pages: HTMLCanvasElement[] = [];
    for (let n = 1; n <= shownPages; n += 1) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (TARGET_WIDTH * ratio) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas 2d is not available');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push(canvas);
    }
    const sheet = document.createElement('canvas');
    sheet.width = Math.max(...pages.map((page) => page.width));
    sheet.height = pages.reduce((sum, page) => sum + page.height, 0) + PAGE_GAP * ratio * (pages.length - 1);
    const context = sheet.getContext('2d');
    if (!context) throw new Error('canvas 2d is not available');
    context.fillStyle = '#e0e0e0';
    context.fillRect(0, 0, sheet.width, sheet.height);
    let y = 0;
    for (const page of pages) {
      context.drawImage(page, Math.round((sheet.width - page.width) / 2), y);
      y += page.height + PAGE_GAP * ratio;
    }
    const blob = await new Promise<Blob | null>((resolve) => sheet.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas could not be encoded');
    return { url: URL.createObjectURL(blob), pageCount: pdf.numPages, shownPages };
  } finally {
    void task.destroy();
  }
}
