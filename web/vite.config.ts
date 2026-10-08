/// <reference types="vitest/config" />
import { copyFileSync, createReadStream, cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_DIR as FIXTURES_SOURCE, REGRESSION_MATERIALS, SAMPLE_MATERIALS } from '@baox/fixtures';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
// Carbon 的 Sass 包之间互相 @use（@carbon/styles → @carbon/type、@carbon/themes …）。pnpm 默认不把它们提升到包目录，
// 让 Sass 也能从工作区根的 .pnpm/node_modules（pnpm 的隐藏提升目录）找到它们。
const SASS_LOAD_PATHS = [resolve(packageRoot, 'node_modules'), resolve(packageRoot, '../node_modules/.pnpm/node_modules')];
const FIXTURES_PUBLIC_PATH = '/fixtures/';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

// Mock mode only: copy the generated sample originals (@baox/fixtures) to dist-mock/fixtures/, and serve them from the
// same directory under the dev server. The single-file plugin only inlines the JS/CSS the HTML references, so these files
// stay separate, and the relative URLs in snapshots (fixtures/xxx.pdf) open under both file:// and the local server.
function mockFixtures(): Plugin {
  let outDir = 'dist-mock';
  return {
    name: 'baox-mock-fixtures',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith(FIXTURES_PUBLIC_PATH)) return next();
        const name = decodeURIComponent(url.slice(FIXTURES_PUBLIC_PATH.length));
        if (name.includes('/') || name.includes('..')) return next();
        const file = join(FIXTURES_SOURCE, name);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(FIXTURES_SOURCE)) {
        this.warn(`Fixture directory ${FIXTURES_SOURCE} not found; run pnpm --filter @baox/fixtures generate first`);
        return;
      }
      // 回归夹具只给测试用，不进手工 QA 产物：按文件名排除，示例材料与打印页照常复制。
      const regression = new Set(REGRESSION_MATERIALS.map((material) => material.file));
      cpSync(FIXTURES_SOURCE, resolve(packageRoot, outDir, 'fixtures'), { recursive: true, filter: (source) => !regression.has(basename(source)) });
      // 手工 QA 用的示例材料：14 份原件按业务文件名复制到 dist-mock/sample-materials/，整个文件夹可直接拖进上传区。
      const samplesDir = resolve(packageRoot, outDir, 'sample-materials');
      mkdirSync(samplesDir, { recursive: true });
      for (const sample of SAMPLE_MATERIALS) copyFileSync(join(FIXTURES_SOURCE, sample.file), join(samplesDir, sample.fileName));
    },
  };
}

// pdf.js reads CMaps (non-embedded CJK fonts on e-invoices) and the standard font data by URL at run time
// (src/pages/pdf-render.ts). Copy both next to the built page as pdfjs/, and serve them from the package under dev.
const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const PDFJS_PUBLIC_PATH = '/pdfjs/';
const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts'] as const;

function pdfjsAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'baox-pdfjs-assets',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (!url.startsWith(PDFJS_PUBLIC_PATH)) return next();
        const [dir, name, ...rest] = decodeURIComponent(url.slice(PDFJS_PUBLIC_PATH.length)).split('/');
        if (!PDFJS_ASSET_DIRS.includes(dir as (typeof PDFJS_ASSET_DIRS)[number]) || !name || rest.length > 0 || name.includes('..')) return next();
        const file = join(PDFJS_ROOT, dir!, name);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) cpSync(join(PDFJS_ROOT, dir), resolve(packageRoot, outDir, 'pdfjs', dir), { recursive: true });
    },
  };
}

// `vite build --mode mock` 产出 dist-mock/：单文件 HTML，脚本内联，双击即可用 file:// 打开；夹具原件放在 dist-mock/fixtures/。
// 正式构建产出 dist/，由本地应用服务托管，不含 mock 代码与夹具；相对 base 让两种产物都不依赖站点根路径。
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    base: './',
    plugins: [react(), pdfjsAssets(), ...(mock ? [viteSingleFile(), mockFixtures()] : [])],
    css: {
      preprocessorOptions: {
        scss: { loadPaths: SASS_LOAD_PATHS, quietDeps: true, silenceDeprecations: ['import', 'global-builtin'] },
      },
    },
    // `pnpm dev`: the page talks to the real server through /api, SSE included (http-proxy streams it unbuffered).
    // Mock mode has no server.
    server: mock ? {} : { proxy: { '/api': { target: `http://127.0.0.1:${process.env['BAOX_PORT'] ?? 4319}` } } },
    build: {
      outDir: mock ? 'dist-mock' : 'dist',
      emptyOutDir: true,
      modulePreload: { polyfill: false },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test/setup.ts'],
    },
  };
});
