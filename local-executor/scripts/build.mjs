import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Builds the 本地执行器 into one file, `dist/baox-local-executor.mjs` (or into the directory given as the first
// argument): the program every platform's zip carries next to Node's own runtime (ADR-0035). Its dependencies are
// plain JavaScript (zod and the workspace packages), so one bundle runs on Windows and macOS alike. The server serves
// it as it is, and the executors that run it compare its sha256 with their own to know when to replace themselves.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(dist, 'baox-local-executor.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // Bundled ESM still meets packages that call require(); give it one.
  banner: { js: "import { createRequire as __baoxRequire } from 'node:module'; const require = __baoxRequire(import.meta.url);" },
  logLevel: 'warning',
});
