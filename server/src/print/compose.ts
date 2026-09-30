import { PDFDocument, degrees, rgb } from '@cantoo/pdf-lib';
import { renderPageAsImage } from 'unpdf';
import { straightenedJpeg, type PaperCorners } from './straighten';
import { openPdf } from '../parse/pdf';
import { canvasWithCjk } from './fonts';
import { A4, HEADER_BOX, SEPARATOR_X, SEPARATOR_Y, place, type Box, type Size } from './layout';

// Composition of the merged print PDF with @cantoo/pdf-lib, and its page images with pdfjs on @napi-rs/canvas.
// A PDF original is embedded as vectors (a form XObject clipped to its inked area); a photo is embedded as the
// straightened JPEG; the header line is a bitmap drawn with a system CJK font (pdf-lib's standard fonts have no CJK).
// The canvas comes with a CJK fallback under the generic families (fonts.ts), for hosts whose defaults lack CJK.

const canvasImport = canvasWithCjk;

// Fractions of the page box (lower-left origin) that hold ink, padded; the rest is blank margin.
type Trim = { left: number; bottom: number; right: number; top: number };

// `pageCount`: only page 1 is ever embedded, so the rest have to be reported rather than quietly left out.
export type Content = { kind: 'pdf'; bytes: Uint8Array; trim: Trim; size: Size; pageCount: number } | { kind: 'image'; bytes: Uint8Array; size: Size };

export type Drawn = { content: Content; rotate: boolean; region: Box };
export type SheetPage = { header: string; drawn: readonly Drawn[] };

// A pixel lighter than this in every channel counts as blank paper.
const BLANK = 240;
const TRIM_PAD = 6;
const HEADER_SCALE = 4;
const HEADER_FONT_SIZE = 9;
const HEADER_FONT = '"Hiragino Sans GB", "PingFang SC", "Heiti SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
const PAGE_IMAGE_SCALE = 1.5;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// 裁掉四周空白: page 1 is rendered once and its inked bounding box becomes the embed's bounding box. Only the
// margin is clipped away (hidden), nothing inside the original is removed or altered.
export async function pdfContent(bytes: Uint8Array): Promise<Content> {
  const pdf = await openPdf(bytes);
  try {
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const pageCount = pdf.numPages;
    const ink = await inkBox(new Uint8Array(await renderPageAsImage(pdf, 1, { canvasImport, scale: 1 })));
    const full = { width: viewport.width, height: viewport.height };
    if (!ink) return { kind: 'pdf', bytes, trim: { left: 0, bottom: 0, right: 1, top: 1 }, size: full, pageCount };
    const padX = TRIM_PAD / viewport.width;
    const padY = TRIM_PAD / viewport.height;
    const trim = {
      left: clamp01(ink.left / ink.width - padX),
      right: clamp01(ink.right / ink.width + padX),
      top: clamp01(1 - ink.top / ink.height + padY),
      bottom: clamp01(1 - ink.bottom / ink.height - padY),
    };
    return { kind: 'pdf', bytes, trim, size: { width: (trim.right - trim.left) * viewport.width, height: (trim.top - trim.bottom) * viewport.height }, pageCount };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// A photo inside its four corners, warped flat (透视矫正); the background outside the corners is not in the output.
export async function photoContent(bytes: Uint8Array, corners: PaperCorners): Promise<Content> {
  const flat = await straightenedJpeg(bytes, corners);
  return { kind: 'image', bytes: flat.bytes, size: { width: flat.width, height: flat.height } };
}

// A 支付截图 as is (EXIF orientation applied, transparency on white), re-encoded as JPEG.
export async function screenshotContent(bytes: Uint8Array): Promise<Content> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(bytes).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  return { kind: 'image', bytes: new Uint8Array(data), size: { width: info.width, height: info.height } };
}

// True when sharp can decode the bytes as a JPEG or PNG image.
export async function isJpegOrPng(bytes: Uint8Array): Promise<boolean> {
  const { default: sharp } = await import('sharp');
  try {
    const { format } = await sharp(bytes).metadata();
    return format === 'jpeg' || format === 'png';
  } catch {
    return false;
  }
}

// The merged A4 PDF: per page the header, the dashed separator, then every placement.
export async function composeSheet(pages: readonly SheetPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const sheetPage of pages) {
    const page = doc.addPage([A4.width, A4.height]);
    page.drawImage(await doc.embedPng(await headerPng(sheetPage.header)), HEADER_BOX);
    page.drawLine({ start: { x: SEPARATOR_X[0], y: SEPARATOR_Y }, end: { x: SEPARATOR_X[1], y: SEPARATOR_Y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [3, 3] });
    for (const drawn of sheetPage.drawn) {
      const at = place(drawn.content.size, drawn.region, drawn.rotate);
      const options = { x: at.x, y: at.y, width: at.width, height: at.height, rotate: degrees(at.rotate) };
      if (drawn.content.kind === 'pdf') {
        const source = (await PDFDocument.load(drawn.content.bytes, { ignoreEncryption: true })).getPage(0);
        const box = source.getCropBox();
        const { trim } = drawn.content;
        const embedded = await doc.embedPage(source, {
          left: box.x + trim.left * box.width,
          right: box.x + trim.right * box.width,
          bottom: box.y + trim.bottom * box.height,
          top: box.y + trim.top * box.height,
        });
        page.drawPage(embedded, options);
      } else {
        page.drawImage(await doc.embedJpg(drawn.content.bytes), options);
      }
    }
  }
  return doc.save();
}

// Page images of the merged PDF, as PNG, in page order.
export async function renderPages(pdfBytes: Uint8Array): Promise<Uint8Array[]> {
  const pdf = await openPdf(pdfBytes);
  try {
    const images: Uint8Array[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) images.push(new Uint8Array(await renderPageAsImage(pdf, n, { canvasImport, scale: PAGE_IMAGE_SCALE })));
    return images;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function headerPng(text: string): Promise<Uint8Array> {
  const { createCanvas } = await canvasImport();
  const canvas = createCanvas(Math.round(HEADER_BOX.width * HEADER_SCALE), Math.round(HEADER_BOX.height * HEADER_SCALE));
  const context = canvas.getContext('2d');
  context.fillStyle = '#333333';
  context.font = `${HEADER_FONT_SIZE * HEADER_SCALE}px ${HEADER_FONT}`;
  context.textBaseline = 'middle';
  context.fillText(text, 0, canvas.height / 2);
  return new Uint8Array(await canvas.encode('png'));
}

// The inked pixel box of a rendered page (top-left origin, right/bottom exclusive), or null for a blank page.
async function inkBox(png: Uint8Array): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number } | null> {
  const { createCanvas, loadImage } = await canvasImport();
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      if ((data[i + 3] ?? 0) === 0) continue;
      if ((data[i] ?? 255) >= BLANK && (data[i + 1] ?? 255) >= BLANK && (data[i + 2] ?? 255) >= BLANK) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1, width: image.width, height: image.height };
}
