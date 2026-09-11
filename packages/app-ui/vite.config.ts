/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode mock` 产出 dist-mock/：单文件 HTML，脚本内联，双击即可用 file:// 打开。
// 正式构建产出 dist/，由本地应用服务托管；相对 base 让两种产物都不依赖站点根路径。
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    base: './',
    plugins: [react(), ...(mock ? [viteSingleFile()] : [])],
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
