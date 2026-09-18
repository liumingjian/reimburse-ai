import { build } from 'esbuild';

// Bundles the server (with the source-only @baox/contract) into dist/main.mjs, and the parse worker_thread into
// dist/parse-worker.mjs next to it. External at runtime, resolved from server/node_modules: better-sqlite3 (native
// addon), and the parsing libraries that load their own assets (pdfjs CMaps and worker, zxing wasm) relative to their
// package, plus the OCR stack (onnxruntime-node and sharp are native addons; opencv-js is a 10 MB wasm build; the
// OCR models are resolved from @gutenye/ocr-models at runtime). The banner gives bundled CommonJS dependencies a
// `require`.
// The e2e entry carries the scripted ERP doubles, so it is built only for the Playwright `server` project
// (root `test:e2e` sets BAOX_BUILD_E2E=1) and never ends up in a bundle users run.
const e2e = process.env['BAOX_BUILD_E2E'] === '1';

await build({
  entryPoints: { main: 'src/main.ts', 'parse-worker': 'src/parse/worker.ts', baox: 'src/cli-main.ts', ...(e2e ? { 'e2e-main': 'src/e2e-main.ts' } : {}) },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['better-sqlite3', 'pdfjs-dist', 'unpdf', 'zxing-wasm', 'onnxruntime-node', 'sharp', '@techstark/opencv-js', '@napi-rs/canvas'],
  banner: { js: "import { createRequire as __baoxCreateRequire } from 'node:module'; const require = __baoxCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
