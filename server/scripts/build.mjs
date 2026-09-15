import { build } from 'esbuild';

// Bundles the server (with the source-only @baox/contract) into dist/main.mjs, and the parse worker_thread into
// dist/parse-worker.mjs next to it. External at runtime, resolved from server/node_modules: better-sqlite3 (native
// addon), and the parsing libraries that load their own assets (pdfjs CMaps and worker, zxing wasm) relative to their
// package. The banner gives bundled CommonJS dependencies a `require`.
await build({
  entryPoints: { main: 'src/main.ts', 'parse-worker': 'src/parse/worker.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['better-sqlite3', 'pdfjs-dist', 'unpdf', 'zxing-wasm'],
  banner: { js: "import { createRequire as __baoxCreateRequire } from 'node:module'; const require = __baoxCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
