import { defineConfig } from '@playwright/test';

// e2e 只针对 mock 构建产物：用 Mac 上已安装的 Google Chrome 直接打开 dist-mock/index.html（file://）。
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chrome' }],
});
