import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { manifestFor, readExtensionVersion } from './manifest.mjs';

// Builds the unpacked extension into `dist/`. #258 zips that directory and serves it from the settings page, so the
// version in the zip is whatever this writes, which is `EXTENSION_VERSION` (see `manifest.mjs`).
//
// The origin is baked in here, from the same environment variable the server reads for its exact-origin guard, so a
// deployment configures one address and both sides get it. There is no way to change it afterwards: `origin.ts` is
// the only place the extension learns where the app is, and the popup has no field for it (user story 7).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');

const origin = (process.env.BAOX_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4319').trim().replace(/\/$/, '');
const version = readExtensionVersion(readFileSync(join(root, '..', 'contract', 'src', 'extension.ts'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'service-worker.ts'), join(root, 'src', 'popup.ts')],
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  define: { __BAOX_ORIGIN__: JSON.stringify(origin) },
});

copyFileSync(join(root, 'src', 'popup.html'), join(dist, 'popup.html'));
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifestFor(version, origin), null, 2)}\n`);

console.log(`extension ${version} built for ${origin} -> ${dist}`);
