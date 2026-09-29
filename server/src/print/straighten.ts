import { decode, loadCv, paperQuad, warp, type Cv, type Point } from '../paper';

// The print sheet's paper straightening (#190): the OCR adapter's corner search and warp (`../paper.ts`), without the
// OCR models.

let cvOnly: Promise<Cv> | null = null;
const printCv = (): Promise<Cv> => (cvOnly ??= loadCv());

// Four corners in photo pixels (EXIF orientation applied; top-left, top-right, bottom-right, bottom-left).
export type PaperCorners = [[number, number], [number, number], [number, number], [number, number]];

// The photo's size and the paper's detected corners; null corners when no paper stands out.
export async function paperCorners(bytes: Uint8Array): Promise<{ width: number; height: number; corners: PaperCorners | null }> {
  const cv = await printCv();
  const photo = await decode(cv, bytes);
  try {
    const quad = paperQuad(cv, photo);
    const corners = quad ? (quad.map((p) => [Math.round(p.x), Math.round(p.y)]) as PaperCorners) : null;
    return { width: photo.cols, height: photo.rows, corners };
  } finally {
    photo.delete();
  }
}

// The paper inside `corners`, warped flat, as JPEG: what the print sheet embeds for a photo.
export async function straightenedJpeg(bytes: Uint8Array, corners: PaperCorners): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const cv = await printCv();
  const photo = await decode(cv, bytes);
  const flat = warp(
    cv,
    photo,
    corners.map(([x, y]) => ({ x, y })) as [Point, Point, Point, Point],
  );
  try {
    const { default: sharp } = await import('sharp');
    const jpeg = await sharp(Buffer.from(flat.data), { raw: { width: flat.cols, height: flat.rows, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    return { bytes: new Uint8Array(jpeg), width: flat.cols, height: flat.rows };
  } finally {
    flat.delete();
    photo.delete();
  }
}
