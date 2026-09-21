import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

// QR decoding with zxing-wasm, before any layout runs (ADR-0017). The wasm binary is the pinned local copy: zxing's
// default fetches it from a CDN, and the app runs offline.

const require = createRequire(import.meta.url);
let prepared: Promise<unknown> | null = null;

function prepare(): Promise<unknown> {
  if (!prepared) {
    const binary = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
    const wasmBinary = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
    prepared = Promise.resolve(prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true }));
  }
  return prepared;
}

const OPTIONS: ReaderOptions = { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 4 };

// Node has no ImageData; zxing reads `{data, width, height}` from one.
//
// The shim takes its values through a constructor, and that is the whole point. Declaring them as class fields
// initialised from the enclosing function's parameters looks equivalent and is not: the class is installed on
// `globalThis`, so every later call reuses it, and its field initialisers still close over the arguments of the call
// that created it. Every image after the first in a process then decodes as the first one — silently, with a payload
// that belongs to another document. Live 2026-09-19 that made six 高德打车 invoices report a seventh one's 二维码 and
// six spurious 「二维码与票面不一致」.
type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number; colorSpace: 'srgb' };
class NodeImageData implements ImageDataLike {
  readonly colorSpace = 'srgb' as const;
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}
function imageData(data: Uint8ClampedArray, width: number, height: number): ImageDataLike {
  const global = globalThis as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageDataLike };
  global.ImageData ??= NodeImageData;
  return new global.ImageData(data, width, height);
}

export type Raster = { data: Uint8ClampedArray | Uint8Array; width: number; height: number; channels: number };

// An embedded image (1, 3 or 4 channels) → decoded QR payloads.
export async function decodeRaster(raster: Raster): Promise<string[]> {
  if (raster.width < 21 || raster.height < 21) return [];
  const pixels = raster.width * raster.height;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * raster.channels;
    const r = raster.data[at] ?? 0;
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = raster.channels >= 3 ? (raster.data[at + 1] ?? 0) : r;
    rgba[i * 4 + 2] = raster.channels >= 3 ? (raster.data[at + 2] ?? 0) : r;
    rgba[i * 4 + 3] = raster.channels === 4 ? (raster.data[at + 3] ?? 255) : 255;
  }
  await prepare();
  const results = await readBarcodes(imageData(rgba, raster.width, raster.height) as unknown as Parameters<typeof readBarcodes>[0], OPTIONS);
  return results.filter((result) => result.isValid).map((result) => result.text);
}

// An encoded image file (JPEG / PNG) → decoded QR payloads.
export async function decodeImageFile(bytes: Uint8Array): Promise<string[]> {
  await prepare();
  const results = await readBarcodes(new Uint8Array(bytes), OPTIONS);
  return results.filter((result) => result.isValid).map((result) => result.text);
}
