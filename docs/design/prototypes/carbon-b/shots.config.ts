import { defineConfig } from '@playwright/test';

// Mockup screenshots: open the static pages over file:// in system Chrome and save shots to SHOTS_DIR (default /tmp/carbon-b-shots); no pixel diffing.
// Run from the repo root: pnpm exec playwright test -c docs/design/prototypes/carbon-b/shots.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: 'shots.spec.ts',
  outputDir: '/tmp/carbon-b-test-results',
  reporter: 'line',
  workers: 1,
  use: { channel: 'chrome' },
});
