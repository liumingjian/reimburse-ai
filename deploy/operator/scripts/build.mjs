import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: { 'baox-operator': 'src/cli-main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  logLevel: 'warning',
});

await copyFile('src/candidate-coordinator.cjs', 'dist/candidate-coordinator.cjs');
