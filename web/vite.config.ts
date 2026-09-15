/// <reference types="vitest/config" />
import { copyFileSync, createReadStream, cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_DIR as FIXTURES_SOURCE, SAMPLE_MATERIALS } from '@baox/fixtures';
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
      cpSync(FIXTURES_SOURCE, resolve(packageRoot, outDir, 'fixtures'), { recursive: true });
      // 手工 QA 用的示例材料：11 份原件按业务文件名复制到 dist-mock/sample-materials/，整个文件夹可直接拖进上传区。
      const samplesDir = resolve(packageRoot, outDir, 'sample-materials');
      mkdirSync(samplesDir, { recursive: true });
      for (const sample of SAMPLE_MATERIALS) copyFileSync(join(FIXTURES_SOURCE, sample.file), join(samplesDir, sample.fileName));
    },
  };
}

// `vite build --mode mock` 产出 dist-mock/：单文件 HTML，脚本内联，双击即可用 file:// 打开；夹具原件放在 dist-mock/fixtures/。
// 正式构建产出 dist/，由本地应用服务托管，不含 mock 代码与夹具；相对 base 让两种产物都不依赖站点根路径。
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    base: './',
    plugins: [react(), ...(mock ? [viteSingleFile(), mockFixtures()] : [])],
    css: {
      preprocessorOptions: {
        scss: { loadPaths: SASS_LOAD_PATHS, quietDeps: true, silenceDeprecations: ['import', 'global-builtin'] },
      },
    },
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
