import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { InferenceSession as Session, Tensor as TensorType } from 'onnxruntime-node';
import { normalise, type TextObservation } from './doc';

// The OCR adapter (ADR-0017, #186): a photo in, positioned 文字观测 (text observations) out, all in this process.
// 1. `sharp` decodes the photo (EXIF orientation applied).
// 2. `opencv-js` finds the paper's four corners and warps it flat (透视矫正, perspective correction).
// 3. `onnxruntime-node` runs RapidOCR's PP-OCRv4 detection and recognition models on the flattened paper.
// Everything loads lazily on the first image and lives until the parse worker ends (released after its idle timeout),
// so a job with PDFs only never loads OCR. Coordinates follow the PDF convention of `doc.ts` (lower-left, y up) in
// pixels of the flattened paper.

// The models ship in `@gutenye/ocr-models` (pinned exactly; RapidOCR's ONNX exports of PaddleOCR PP-OCRv4). The
// checksums pin the bytes, not just the package version: a different file is a load error, never a silent swap.
const MODELS = {
  det: { file: 'ch_PP-OCRv4_det_infer.onnx', sha256: '30a86f5731181461d08021402766601e4302a9b9b9666be8aff402696339cdff' },
  rec: { file: 'ch_PP-OCRv4_rec_infer.onnx', sha256: '06b3e6af6c59a1ba5d53790ed8c2e4b2de389870b6cf5a97f349f3412cb269c0' },
  keys: { file: 'ppocr_keys_v1.txt', sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7' },
} as const;

// Detection input: the short side is scaled up to at least this (small receipt print needs it), the long side capped.
const DET_MIN_SIDE = 736;
const DET_MAX_SIDE = 2048;
const DET_BINARY_THRESHOLD = 0.3;
const DET_BOX_THRESHOLD = 0.6;
const DET_UNCLIP_RATIO = 1.6;
const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
// The paper must cover this share of the photo for the corner search to count; otherwise the photo is read as is.
const MIN_PAPER_SHARE = 0.12;

type Cv = typeof import('@techstark/opencv-js');
type Mat = InstanceType<Cv['Mat']>;
type Point = { x: number; y: number };

type Engine = { cv: Cv; det: Session; rec: Session; keys: string[]; Tensor: typeof TensorType };

let engine: Promise<Engine> | null = null;

// True once the first image of this worker has loaded OCR. The parse worker reports it with every reply.
export function ocrLoaded(): boolean {
  return engine !== null;
}

// A photo's text observations, on page 1 of the flattened paper.
export async function ocrImage(bytes: Uint8Array): Promise<TextObservation[]> {
  const loaded = await ocrEngine();
  const { cv } = loaded;
  const photo = await decode(cv, bytes);
  const paper = flattenPaper(cv, photo) ?? photo;
  try {
    const observations: TextObservation[] = [];
    for (const box of await detect(loaded, paper)) {
      const read = await readBox(loaded, paper, box);
      if (!read) continue;
      const xs = box.corners.map((p) => p.x);
      const ys = box.corners.map((p) => p.y);
      const left = Math.min(...xs);
      const bottom = Math.max(...ys);
      observations.push({
        id: `p1.${observations.length}`,
        page: 1,
        x: left,
        y: paper.rows - bottom,
        width: Math.max(...xs) - left,
        height: bottom - Math.min(...ys),
        text: normalise(read.text),
        raw: read.text.trim(),
        score: Number(read.score.toFixed(4)),
      });
    }
    return observations;
  } finally {
    if (paper !== photo) paper.delete();
    photo.delete();
  }
}

// The emscripten Module finishes compiling its wasm asynchronously. It is a thenable that resolves to itself, so it
// must never be handed to `resolve()` or `await` as is (that recurses forever): wait on its `then`, drop `then`, and
// hand it over wrapped.
// Loaded with `require`, never `await import()`: a loader that re-exports the CommonJS `then` on the ES namespace
// (vitest does) makes the awaited import itself recurse forever. The print sheet (#190) loads it in the main process.
async function loadCv(): Promise<Cv> {
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

async function verified(dir: string, model: { file: string; sha256: string }): Promise<Buffer> {
  const bytes = await readFile(join(dir, model.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== model.sha256) throw new Error(`OCR model ${model.file} has sha256 ${digest}, expected ${model.sha256}`);
  return bytes;
}

async function load(): Promise<Engine> {
  const dir = join(dirname(createRequire(import.meta.url).resolve('@gutenye/ocr-models/node')), 'assets');
  const [ort, cv, det, rec, keys] = await Promise.all([
    import('onnxruntime-node'),
    loadCv(),
    verified(dir, MODELS.det),
    verified(dir, MODELS.rec),
    verified(dir, MODELS.keys),
  ]);
  const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' } as const;
  return {
    cv,
    det: await ort.InferenceSession.create(det, options),
    rec: await ort.InferenceSession.create(rec, options),
    // CTC classes: 0 is blank, then the dictionary, then a space.
    keys: [...keys.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0), ' '],
    Tensor: ort.Tensor,
  };
}

function ocrEngine(): Promise<Engine> {
  engine ??= load().catch((error: unknown) => {
    engine = null;
    throw error;
  });
  return engine;
}

async function decode(cv: Cv, bytes: Uint8Array): Promise<Mat> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(bytes).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const mat = new cv.Mat(info.height, info.width, cv.CV_8UC3);
  mat.data.set(data);
  return mat;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// Top-left, top-right, bottom-right, bottom-left.
function ordered(points: readonly Point[]): [Point, Point, Point, Point] {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0] as Point, byDiff[0] as Point, bySum[bySum.length - 1] as Point, byDiff[byDiff.length - 1] as Point];
}

function warp(cv: Cv, src: Mat, corners: [Point, Point, Point, Point]): Mat {
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
function rectCorners(rect: { center: Point; size: { width: number; height: number }; angle: number }): Point[] {
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

// 透视矫正: the paper is the largest bright region; its outline, reduced to four corners, is warped to a rectangle.
// Null when no paper-sized quadrilateral stands out (e.g. a flat scan): the photo is then read as is.
function flattenPaper(cv: Cv, photo: Mat): Mat | null {
  const quad = paperQuad(cv, photo);
  return quad ? warp(cv, photo, quad) : null;
}

// ---- The print sheet's side (#190): the same corner search and warp, without the OCR models ----

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

function paperQuad(cv: Cv, photo: Mat): [Point, Point, Point, Point] | null {
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

type Box = { corners: [Point, Point, Point, Point] };

const round32 = (value: number) => Math.max(32, Math.round(value / 32) * 32);

// Detection (DB): probability map → text regions as rotated boxes in image pixels, top to bottom.
async function detect({ cv, det, Tensor }: Engine, image: Mat): Promise<Box[]> {
  const scale = Math.min(Math.max(1, DET_MIN_SIDE / Math.min(image.rows, image.cols)), DET_MAX_SIDE / Math.max(image.rows, image.cols));
  const width = round32(image.cols * scale);
  const height = round32(image.rows * scale);
  const resized = new cv.Mat();
  cv.resize(image, resized, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
  // PaddleOCR's det normalisation (ImageNet mean/std), channels in BGR order, CHW.
  const mean = [0.406, 0.456, 0.485];
  const std = [0.225, 0.224, 0.229];
  const input = new Float32Array(3 * width * height);
  const pixels = resized.data;
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const rgb = pixels[i * 3 + (2 - c)] ?? 0;
      input[c * width * height + i] = (rgb / 255 - (mean[c] ?? 0)) / (std[c] ?? 1);
    }
  }
  resized.delete();
  const output = await det.run({ [det.inputNames[0] ?? 'x']: new Tensor('float32', input, [1, 3, height, width]) });
  const map = output[det.outputNames[0] ?? '']?.data as Float32Array;

  const probability = cv.matFromArray(height, width, cv.CV_32FC1, Array.from(map));
  const bitmap = new cv.Mat(height, width, cv.CV_8UC1);
  for (let i = 0; i < map.length; i += 1) bitmap.data[i] = (map[i] ?? 0) > DET_BINARY_THRESHOLD ? 255 : 0;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bitmap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const boxes: Box[] = [];
  const back = { x: image.cols / width, y: image.rows / height };
  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const rect = cv.minAreaRect(contour);
    const bounds = cv.boundingRect(contour);
    if (Math.min(rect.size.width, rect.size.height) >= 3) {
      // Box score: mean probability inside the contour.
      const roi = probability.roi(bounds);
      const mask = cv.Mat.zeros(bounds.height, bounds.width, cv.CV_8UC1);
      const single = new cv.MatVector();
      single.push_back(contour);
      cv.drawContours(mask, single, 0, new cv.Scalar(255), -1, cv.LINE_8, new cv.Mat(), 0, new cv.Point(-bounds.x, -bounds.y));
      const score = cv.mean(roi, mask)[0] ?? 0;
      single.delete();
      mask.delete();
      roi.delete();
      if (score >= DET_BOX_THRESHOLD) {
        // Unclip: DB predicts shrunk regions; grow the box by area * ratio / perimeter on every side.
        const { width: w, height: h } = rect.size;
        const grow = (w * h * DET_UNCLIP_RATIO) / (2 * (w + h));
        const grown = { center: rect.center, size: { width: w + 2 * grow, height: h + 2 * grow }, angle: rect.angle };
        if (Math.min(grown.size.width, grown.size.height) >= 5) {
          const corners = ordered(rectCorners(grown).map((p) => ({ x: Math.min(image.cols, Math.max(0, p.x * back.x)), y: Math.min(image.rows, Math.max(0, p.y * back.y)) })));
          boxes.push({ corners });
        }
      }
    }
    contour.delete();
  }
  probability.delete();
  bitmap.delete();
  contours.delete();
  hierarchy.delete();
  return boxes.sort((a, b) => a.corners[0].y - b.corners[0].y || a.corners[0].x - b.corners[0].x);
}

// Recognition (CRNN + CTC greedy decode) of one text box.
async function readBox({ cv, rec, keys, Tensor }: Engine, image: Mat, box: Box): Promise<{ text: string; score: number } | null> {
  let crop = warp(cv, image, box.corners);
  if (crop.rows >= crop.cols * 1.5) {
    const turned = new cv.Mat();
    cv.rotate(crop, turned, cv.ROTATE_90_COUNTERCLOCKWISE);
    crop.delete();
    crop = turned;
  }
  const ratio = crop.cols / crop.rows;
  const inputWidth = Math.max(REC_MIN_WIDTH, Math.ceil(REC_HEIGHT * ratio));
  const resizedWidth = Math.min(inputWidth, Math.ceil(REC_HEIGHT * ratio));
  const resized = new cv.Mat();
  cv.resize(crop, resized, new cv.Size(resizedWidth, REC_HEIGHT), 0, 0, cv.INTER_LINEAR);
  crop.delete();
  // (x / 255 - 0.5) / 0.5 in BGR order, CHW, right-padded with zeros.
  const input = new Float32Array(3 * REC_HEIGHT * inputWidth);
  const plane = REC_HEIGHT * inputWidth;
  for (let y = 0; y < REC_HEIGHT; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const at = (y * resizedWidth + x) * 3;
      for (let c = 0; c < 3; c += 1) input[c * plane + y * inputWidth + x] = ((resized.data[at + (2 - c)] ?? 0) / 255 - 0.5) / 0.5;
    }
  }
  resized.delete();
  const output = await rec.run({ [rec.inputNames[0] ?? 'x']: new Tensor('float32', input, [1, 3, REC_HEIGHT, inputWidth]) });
  const tensor = output[rec.outputNames[0] ?? ''];
  if (!tensor) return null;
  const [, steps = 0, classes = 0] = tensor.dims;
  const probabilities = tensor.data as Float32Array;
  let text = '';
  const scores: number[] = [];
  let previous = 0;
  for (let t = 0; t < steps; t += 1) {
    let best = 0;
    let bestScore = -1;
    for (let k = 0; k < classes; k += 1) {
      const p = probabilities[t * classes + k] ?? 0;
      if (p > bestScore) {
        bestScore = p;
        best = k;
      }
    }
    if (best !== 0 && best !== previous) {
      text += keys[best - 1] ?? '';
      scores.push(bestScore);
    }
    previous = best;
  }
  if (!text.trim()) return null;
  return { text, score: scores.reduce((sum, s) => sum + s, 0) / scores.length };
}

