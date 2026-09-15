import { defineConfig } from '@playwright/test';

// Two projects, both on the Mac's installed Google Chrome:
// - mock: opens the mock build (dist-mock/index.html) over file://. Keeps only states the real server cannot cheaply
//   reach; a mock spec duplicated by a passing server spec is deleted.
// - server: journeys against the built server (server/dist/main.mjs) serving web/dist. Specs live in e2e/server/ and
//   import `test` from ./server/fixture, which boots one server per test on a throwaway BAOX_DATA_DIR.
// Root `pnpm test:e2e` builds everything first.
export default defineConfig({
  outputDir: './test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mock', testDir: './e2e', testIgnore: 'server/**' },
    { name: 'server', testDir: './e2e/server' },
  ],
});
