import { defineConfig } from 'vitest/config';

// `__BAOX_ORIGIN__` is replaced at build time by `scripts/build.mjs`; under test it has to be replaced by something
// too, or any module that reaches `origin.ts` fails to evaluate. The value is only ever compared, never dialled.
export default defineConfig({
  define: { __BAOX_ORIGIN__: JSON.stringify('http://127.0.0.1:4319') },
  test: { environment: 'node' },
});
