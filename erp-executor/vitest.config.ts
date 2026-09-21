import { defineConfig } from 'vitest/config';

// Raised above vitest's 5s default: the slow tests here are honest work, not stuck work. The boundary test
// spawns the real oxlint binary once per case, and the page tests drive a jsdom document through whole ERP
// steps, so on a loaded machine the default turns a green run red and says only `Test timed out`.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
