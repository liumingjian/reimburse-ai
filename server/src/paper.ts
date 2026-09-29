import { createRequire } from 'node:module';

// Paper geometry on photos, shared by the OCR adapter (`parse/ocr.ts`) and the print sheet (`print/straighten.ts`):
// `opencv-js` finds the paper's four corners and warps it flat (perspective correction, 透视矫正). Coordinates are
// photo pixels, EXIF orientation applied, y down.

// The paper must cover this share of the photo for the corner search to count; otherwise the photo is read as is.
const MIN_PAPER_SHARE = 0.12;

export type Cv = typeof import('@techstark/opencv-js');
export type Mat = InstanceType<Cv['Mat']>;
export type Point = { x: number; y: number };

// The emscripten Module finishes compiling its wasm asynchronously. It is a thenable that resolves to itself, so it
// must never be handed to `resolve()` or `await` as is (that recurses forever): wait on its `then`, drop `then`, and
// hand it over wrapped.
// Loaded with `require`, never `await import()`: a loader that re-exports the CommonJS `then` on the ES namespace
// (vitest does) makes the awaited import itself recurse forever. The print sheet (#190) loads it in the main process.
export async function loadCv(): Promise<Cv> {
  const module = createRequire(import.meta.url)('@techstark/opencv-js') as { Mat?: unknown; then?: (ready: (value: unknown) => void) => void };
  if (typeof module.Mat === 'function' || typeof module.then !== 'function') return module as unknown as Cv;
  const ready = await new Promise<{ cv: Cv }>((resolve) => {
    module.then?.((value) => {
      const cv = value as { then?: unknown };
      delete cv.then;
      resolve({ cv: cv as unknown as Cv });
    });
  });
  return ready.cv;
}

export async function decode(cv: Cv, bytes: Uint8Array): Promise<Mat> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(bytes).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC3);
  mat.data.set(data);
  return mat;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// Top-left, top-right, bottom-right, bottom-left.
export function ordered(points: readonly Point[]): [Point, Point, Point, Point] {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0] as Point, byDiff[0] as Point, bySum[bySum.length - 1] as Point, byDiff[byDiff.length - 1] as Point];
}

export function warp(cv: Cv, src: Mat, corners: [Point, Point, Point, Point]): Mat {
  const [tl, tr, br, bl] = corners;
  const width = Math.max(1, Math.round(Math.max(distance(tl, tr), distance(bl, br))));
  const height = Math.max(1, Math.round(Math.max(distance(tl, bl), distance(tr, br))));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const matrix = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, matrix, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  from.delete();
  to.delete();
  matrix.delete();
  return out;
}

function pointsOf(mat: Mat): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < mat.rows; i += 1) out.push({ x: mat.data32S[i * 2] ?? 0, y: mat.data32S[i * 2 + 1] ?? 0 });
  return out;
}

// The four corners of a rotated rectangle given by centre, size and angle (degrees).
export function rectCorners(rect: { center: Point; size: { width: number; height: number }; angle: number }): Point[] {
  const angle = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const w = rect.size.width / 2;
  const h = rect.size.height / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([dx = 0, dy = 0]) => ({ x: rect.center.x + dx * cos - dy * sin, y: rect.center.y + dx * sin + dy * cos }));
}

export function paperQuad(cv: Cv, photo: Mat): [Point, Point, Point, Point] | null {
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(photo, gray, cv.COLOR_RGB2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best: Mat | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area > bestArea) {
        best?.delete();
        best = contour;
        bestArea = area;
      } else contour.delete();
    }
    if (!best) return null;
    const paper = best;
    try {
      if (bestArea < MIN_PAPER_SHARE * photo.rows * photo.cols) return null;
      const approx = new cv.Mat();
      cv.approxPolyDP(paper, approx, 0.02 * cv.arcLength(paper, true), true);
      const quad = approx.rows === 4 && cv.isContourConvex(approx) ? pointsOf(approx) : rectCorners(cv.minAreaRect(paper));
      approx.delete();
      return ordered(quad);
    } finally {
      paper.delete();
    }
  } finally {
    gray.delete();
    binary.delete();
    contours.delete();
    hierarchy.delete();
  }
}
