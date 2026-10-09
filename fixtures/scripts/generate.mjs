#!/usr/bin/env node
// The fixture generator: HTML templates → headless Chrome → the sample PDFs (with a Chinese text layer), taxi-receipt
// photos (JPG) and print-page images (PNG) under fixtures/generated/.
// Usage: pnpm --filter @baox/fixtures generate   (generate, then verify)
//        node fixtures/scripts/generate.mjs      (generate only)
//        node fixtures/scripts/generate.mjs r01 r02   (redo only these, leaving every other artifact alone)
// Mac only: it needs Google Chrome and sips (PNG to JPG). Repeatable, and the set of artifacts is fixed (verify.mjs
// holds the manifest).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRINT_PAGES, PRINT_SHEET_FILE, PRINT_VARIANTS } from './data.mjs';
import { DOCS, PRINT_DOCS, VARIANT_DOCS, documentOf, printSheetDocument } from './templates.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export const OUTPUT_DIR = fileURLToPath(new URL('../generated/', import.meta.url));

// Material id → artifact file name (the same as the URLs under src/mock/fixtures).
export const MATERIAL_FILES = {
  m01: 'm01-hotel-invoice.pdf',
  m02: 'm02-hotel-folio.pdf',
  m03: 'm03-amap-invoice.pdf',
  m04: 'm04-amap-itinerary.pdf',
  m05: 'm05-caocao-invoice.pdf',
  m06: 'm06-caocao-itinerary.pdf',
  m07: 'm07-rail-0809.pdf',
  m08: 'm08-rail-0822.pdf',
  m09: 'm09-taxi-photo.jpg',
  m10: 'm10-taxi-photo.jpg',
  m11: 'm11-other-invoice.pdf',
  m12: 'm12-office-supplies-invoice.pdf',
  m13: 'm13-dining-receipt.pdf',
  m14: 'm14-discounted-dining-receipt.pdf',
  m16: 'm16-dining-receipt-photo.jpg',
};

// Regression fixtures (#200 onwards): they reproduce how a real face is drawn — the text-run splits of a real PDF, or a
// photo whose labels and values OCR reads as separate boxes (r210). They are not part of the
// sample materials' script and are not copied into the mock's sample-material directory.
export const REGRESSION_FILES = {
  r01: 'r01-einvoice-split-number.pdf',
  r02: 'r02-einvoice-spaced-title.pdf',
  r201: 'r201-bundled-fee-invoice.pdf',
  r202: 'r202-amap-itinerary-gap.pdf',
  r204: 'r204-rail-split-runs.pdf',
  r205: 'r205-amap-itinerary-wrapped.pdf',
  r206: 'r206-transport-invoice.pdf',
  r207: 'r207-einvoice-wide-name-column.pdf',
  r208: 'r208-einvoice-wrapped-item-name.pdf',
  r209: 'r209-amap-itinerary-cross-city.pdf',
  r210: 'r210-hotel-folio-photo.jpg',
};

export const PDF_DOC_FILES = { ...MATERIAL_FILES, ...REGRESSION_FILES };

export const EXPECTED_FILES = [
  ...Object.values(PDF_DOC_FILES),
  ...PRINT_PAGES.map((page) => page.file),
  ...PRINT_VARIANTS.map((page) => page.file),
  PRINT_SHEET_FILE,
].sort();

function chromeBinary() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`找不到 Chrome，可用 CHROME_BIN 指定；试过：${CHROME_CANDIDATES.join(', ')}`);
  return found;
}

// Chrome sometimes does not exit after writing its artifact (headless=new hangs on shutdown on macOS), so this does
// not wait for it: it watches stderr for Chrome's own `N bytes written to file` and kills the process on sight.
// Timeout: 60 seconds.
const CHROME_TIMEOUT_MS = 60_000;
const WRITTEN_PATTERN = /bytes written to file/;

let launchNo = 0;

// A fresh user data directory per launch, so a SingletonLock left behind by the previously SIGKILLed process cannot
// hold up the next one.
function chrome(binary, workDir, extra, url) {
  launchNo += 1;
  const profileDir = join(workDir, `profile-${launchNo}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    '--disable-background-networking',
    '--disable-sync',
    '--run-all-compositor-stages-before-draw',
    '--timeout=8000',
    ...extra,
    url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Chrome 超过 ${CHROME_TIMEOUT_MS / 1000} 秒没有写出文件：${url}\n${stderr.slice(-1500)}`)), CHROME_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (WRITTEN_PATTERN.test(stderr)) finish();
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (WRITTEN_PATTERN.test(stderr)) finish();
      else finish(new Error(`Chrome 退出码 ${code}，没有写出文件：${url}\n${stderr.slice(-1500)}`));
    });
  });
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: CHROME_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (result.error) throw new Error(`${cmd} ${args.join(' ')}\n${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n退出码 ${result.status}\n${(result.stderr ?? '').slice(-2000)}`);
}

// `only`: redo just these materials (e.g. `['r01']`) and leave the output directory alone; omit it to redo the lot.
export async function generate(only = null) {
  const binary = chromeBinary();
  const work = mkdtempSync(join(tmpdir(), 'baox-fixtures-'));
  const profile = work;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  // A full run empties the output directory first: this script alone decides the file set, and no stale file survives.
  if (!only) for (const name of readdirSync(OUTPUT_DIR)) unlinkSync(join(OUTPUT_DIR, name));
  const wanted = (id) => !only || only.includes(id);

  const htmlOf = (doc) => {
    const path = join(work, `${doc.id}.html`);
    writeFileSync(path, documentOf(doc));
    return pathToFileURL(path).href;
  };

  const produced = [];
  for (const [id, file] of Object.entries(PDF_DOC_FILES)) {
    if (!wanted(id)) continue;
    const doc = DOCS[id];
    const target = join(OUTPUT_DIR, file);
    if (file.endsWith('.pdf')) {
      await chrome(binary, profile, ['--no-pdf-header-footer', `--print-to-pdf=${target}`], htmlOf(doc));
    } else {
      const png = join(work, `${id}.png`);
      await chrome(binary, profile, [`--window-size=${doc.width},${doc.height}`, `--screenshot=${png}`], htmlOf(doc));
      // macOS's own sips converts to JPG at quality 70, which keeps the size down.
      run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', png, '--out', target]);
    }
    produced.push(file);
    console.log(`生成 ${file}`);
  }
  for (const [index, doc] of PRINT_DOCS.entries()) {
    const page = PRINT_PAGES[index];
    if (!wanted(page.id)) continue;
    const target = join(OUTPUT_DIR, page.file);
    await chrome(binary, profile, [`--window-size=${doc.width},${doc.height}`, `--screenshot=${target}`], htmlOf(doc));
    produced.push(page.file);
    console.log(`生成 ${page.file}`);
  }
  for (const [index, doc] of VARIANT_DOCS.entries()) {
    const variant = PRINT_VARIANTS[index];
    if (!wanted(variant.id)) continue;
    const target = join(OUTPUT_DIR, variant.file);
    await chrome(binary, profile, [`--window-size=${doc.width},${doc.height}`, `--screenshot=${target}`], htmlOf(doc));
    produced.push(variant.file);
    console.log(`生成 ${variant.file}`);
  }
  // A partial run stops here: the merged print sheet needs every page image to come from this same run.
  if (only) {
    rmSync(work, { recursive: true, force: true });
    return produced.sort();
  }
  // The merged print sheet: the default page images just written, one per A4 page, printed to a single PDF (no text
// layer — it is a download sample only).
  const sheetHtml = join(work, 'print-sheet.html');
  writeFileSync(sheetHtml, printSheetDocument(PRINT_PAGES.map((page) => pathToFileURL(join(OUTPUT_DIR, page.file)).href)));
  const sheetArgs = ['--allow-file-access-from-files', '--no-pdf-header-footer', `--print-to-pdf=${join(OUTPUT_DIR, PRINT_SHEET_FILE)}`];
  await chrome(binary, profile, sheetArgs, pathToFileURL(sheetHtml).href);
  produced.push(PRINT_SHEET_FILE);
  console.log(`生成 ${PRINT_SHEET_FILE}`);
  rmSync(work, { recursive: true, force: true });
  return produced.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.slice(2);
  const produced = await generate(only.length ? only : null);
  console.log(`共 ${produced.length} 个文件 → ${OUTPUT_DIR}`);
}
