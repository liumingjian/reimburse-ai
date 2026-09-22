import { build } from 'esbuild';

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
