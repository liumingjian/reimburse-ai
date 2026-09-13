import { defineConfig } from '@playwright/test';

// 效果图截图：用系统 Chrome 打开 file:// 的静态页，截到 SHOTS_DIR（默认 /tmp/carbon-b-shots），不做像素比对。
// 运行：pnpm exec playwright test -c prototypes/carbon-b/shots.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: 'shots.spec.ts',
  outputDir: '/tmp/carbon-b-test-results',
  reporter: 'line',
  workers: 1,
  use: { channel: 'chrome' },
});
