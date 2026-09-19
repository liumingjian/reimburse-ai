import { defineConfig } from 'vitest/config';
import { BACKSTOP_MS, TEST_TIMEOUT_MS } from './src/test/deadlines';

// Enforced here rather than trusted: a later edit that drops TEST_TIMEOUT_MS back under the pollers' backstop makes
// the suite fail to load, instead of quietly restoring the uninformative-timeout behaviour this config exists to end.
if (TEST_TIMEOUT_MS <= BACKSTOP_MS) {
  throw new Error(
    `testTimeout (${TEST_TIMEOUT_MS}ms) must exceed the condition pollers' backstop (${BACKSTOP_MS}ms); ` +
      'otherwise vitest kills a stuck test before its poller can report what it was waiting for. See src/test/deadlines.ts.',
  );
}

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
  },
});
