import { defineConfig } from '@playwright/test';

// The real-browser harness (see harness.ts). One worker: each test launches its own Chromium with the extension, and
// the extension build it loads is written through the package's `dist/` first. Run on the mac through rexec:
//   pnpm --filter @baox/extension test:browser
export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
});
