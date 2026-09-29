import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { manifestFor, readExtensionVersion, readOriginPlaceholder } from './manifest.mjs';

// Builds the unpacked extension into `dist/` (or the directory given as the first argument) as a template: wherever
// the app's origin belongs, in the code (esbuild `define`, see `origin.ts`), in `host_permissions` and in the content
// script's `matches`, it writes EXTENSION_ORIGIN_PLACEHOLDER. The server fills in its own origin each time the settings
// page downloads the zip (`server/src/extension/download.ts`).
//
// Why the server and not this build: the origin is only known where the server runs (`BAOX_PUBLIC_ORIGIN`), and the
// exact-origin guard compares it as a literal string, so `http://10.250.0.222` and `http://10.250.0.222:80` are two
// different addresses to it. Baking the address in here would leave two copies of the deployment's most expensive
// constant, one read at build time and one at run time, free to disagree. Filled in by the server, the zip carries
// exactly the origin the guard admits. The version is fixed here, from EXTENSION_VERSION (see `manifest.mjs`).
//
// There is still no way to change the origin after download: `origin.ts` is the only place the extension learns where
// the app is, and the popup has no field for it (user story 7).

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist');

const contract = readFileSync(join(root, '..', 'contract', 'src', 'extension.ts'), 'utf8');
const version = readExtensionVersion(contract);
const placeholder = readOriginPlaceholder(contract);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'service-worker.ts'), join(root, 'src', 'popup.ts')],
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  define: { __BAOX_ORIGIN__: JSON.stringify(placeholder) },
  logLevel: 'warning',
});

// The content script is a classic script, not a module (the manifest has no way to load it as one), so it is its own
// self-contained bundle.
await build({
  entryPoints: [join(root, 'src', 'content-script.ts')],
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  define: { __BAOX_ORIGIN__: JSON.stringify(placeholder) },
  logLevel: 'warning',
});

copyFileSync(join(root, 'src', 'popup.html'), join(dist, 'popup.html'));
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifestFor(version, placeholder), null, 2)}\n`);

console.log(`extension ${version} template built -> ${dist}`);
