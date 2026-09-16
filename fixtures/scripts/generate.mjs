#!/usr/bin/env node
// 夹具生成器：HTML 模板 → headless Chrome → fixtures/generated/ 下的示例 PDF（带中文文本层）、出租车票照片（JPG）与打印页图（PNG）。
// Usage: pnpm --filter @baox/fixtures generate   (generate, then verify)
//        node fixtures/scripts/generate.mjs      (generate only)
//        node fixtures/scripts/generate.mjs r01 r02   (只重做这几份，不动其它产物)
// 只在 Mac 上运行：需要 Google Chrome 与 sips（PNG 转 JPG）。可重复运行，产物文件集固定（见 verify.mjs 的清单）。
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

// 材料 id → 产物文件名（与 src/mock/fixtures 里的 URL 一致）。
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
};

// 回归夹具（#200 起）：复现真实 PDF 的文本串拆分，不属于 11 份示例材料的剧本，也不进 mock 的示例材料目录。
export const REGRESSION_FILES = {
  r01: 'r01-einvoice-split-number.pdf',
  r02: 'r02-einvoice-spaced-title.pdf',
  r201: 'r201-bundled-fee-invoice.pdf',
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

// Chrome 写完产物后有时不退出（macOS 上 headless=new 的关闭挂起），所以不等它退出：
// 盯着 stderr 里 Chrome 自己打印的「N bytes written to file」，看到就杀进程。超时 60 秒。
const CHROME_TIMEOUT_MS = 60_000;
const WRITTEN_PATTERN = /bytes written to file/;

let launchNo = 0;

// 每次启动用新的用户数据目录：上一次被 SIGKILL 的进程留下的 SingletonLock 不会拖住下一次。
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
        // 已退出
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

// `only`：只重做这几份材料（如 `['r01']`），产物目录不清空；不传就整批重做。
export async function generate(only = null) {
  const binary = chromeBinary();
  const work = mkdtempSync(join(tmpdir(), 'baox-fixtures-'));
  const profile = work;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  // 整批生成时先清空产物目录：文件集由本脚本唯一决定，旧文件不残留。
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
      // JPG 由 macOS 自带的 sips 转换，质量 70，控制体积。
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
  // 只重做部分材料时到此为止：合并打印稿要所有页图都是这一轮刚写出的。
  if (only) {
    rmSync(work, { recursive: true, force: true });
    return produced.sort();
  }
  // 合并打印稿：上面刚写出的默认页图逐页铺满 A4，打印成一份 PDF（没有文本层，只做下载样本）。
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
