import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The runner's tests drive whole jobs over the fake ERP, as erp-executor's do, and take its timeout: 2-5 s each on a
  // quiet Mac, past vitest's 5 s default under load.
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], testTimeout: 60_000 },
});
