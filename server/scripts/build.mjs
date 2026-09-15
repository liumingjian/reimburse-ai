import { build } from 'esbuild';

// Bundles the server (with the source-only @baox/contract) into dist/main.mjs. better-sqlite3 is a native addon and
// stays external; the banner gives bundled CommonJS dependencies a `require`.
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['better-sqlite3'],
  banner: { js: "import { createRequire as __baoxCreateRequire } from 'node:module'; const require = __baoxCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
