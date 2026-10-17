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

// Test files that run the real OCR (an image through the real parser, or print's paper straightening). Each OCR engine
// is an onnxruntime session whose thread pool spans every core, so several of these files in parallel forks saturate
// the machine and starve the timing-sensitive web tests that root `pnpm test` runs alongside. They run as their own
// project in a single fork, one file after another; everything else keeps full file parallelism.
// Found by tracing which files load the OCR models. A new test that parses an image for real belongs on this list.
const OCR_TESTS = [
  'src/hotel-stay.test.ts',
  'src/legacy/import.test.ts',
  'src/parse/executor.test.ts',
  'src/parse/dining-photo.test.ts',
  'src/parse/readers-production.test.ts',
  'src/print.test.ts',
  'src/test/parse-presets.test.ts',
];

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    projects: [
      { extends: true, test: { name: 'server', include: ['src/**/*.test.ts'], exclude: OCR_TESTS } },
      { extends: true, test: { name: 'server-ocr', include: OCR_TESTS, poolOptions: { forks: { singleFork: true } } } },
    ],
  },
});
