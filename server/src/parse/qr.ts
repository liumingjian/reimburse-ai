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
type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number; colorSpace: 'srgb' };
function imageData(data: Uint8ClampedArray, width: number, height: number): ImageDataLike {
  const Native = (globalThis as { ImageData?: new (data: Uint8ClampedArray, width: number, height: number) => ImageDataLike }).ImageData;
  if (Native) return new Native(data, width, height);
  class NodeImageData {
    data = data;
    width = width;
    height = height;
    colorSpace = 'srgb' as const;
  }
  (globalThis as { ImageData?: unknown }).ImageData = NodeImageData;
  return new NodeImageData();
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
