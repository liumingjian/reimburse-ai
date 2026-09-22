import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { EXTENSION_DOWNLOAD_ERRORS, EXTENSION_DOWNLOAD_FILENAME, EXTENSION_DOWNLOAD_PATH, EXTENSION_VERSION } from '@baox/contract';
import { carriesOrigin, stampedManifestProblem, stampOrigin } from '@baox/extension/template';
import type { Hono } from 'hono';
import type { AppEnv } from '../accounts/http';
import { activeOrigin, type PublicOrigin } from '../public-origin';
import { zip } from './zip';

// The 浏览器扩展 (browser extension) as the settings page hands it out (ADR-0021: load-unpacked, so the employee
// downloads a zip and loads the folder it unpacks to).
//
// The zip is assembled here, at request time, from the template `extension/scripts/build.mjs` leaves in
// `extension/dist/`. The build writes EXTENSION_ORIGIN_PLACEHOLDER wherever the app's origin belongs, and this swaps in
// (by the extension package's own stamping rule, `@baox/extension/template`) the origin the server actually admits: `publicOrigin.origin`, the very string the exact-origin guard in `app.ts`
// compares against, or on a loopback-only install the loopback address the browser just used. Baking the origin in
// at build time instead would need `BAOX_PUBLIC_ORIGIN` set identically at build and at run, and the guard compares
// literally (`http://10.250.0.222` and `http://10.250.0.222:80` are different to it), so an extension built from a
// slightly different spelling would be refused by the server that served it. Assembled here, it cannot be.

class ExtensionTemplateUnusable extends Error {}

// The installable extension for `origin`. Refuses rather than serve something the employee would install in vain: a
// template that is missing, one from another build than this server's (its version is not EXTENSION_VERSION, so the
// server may refuse it on connect), or one whose `host_permissions` did not come out as exactly this origin.
export function packageExtension(templateDir: string, origin: string): Buffer<ArrayBuffer> {
  if (!existsSync(join(templateDir, 'manifest.json'))) throw new ExtensionTemplateUnusable(`no extension template at ${templateDir}; run the extension build`);
  const entries = filesUnder(templateDir).map((name) => {
    const bytes = readFileSync(join(templateDir, name));
    if (!carriesOrigin(name)) return { name, data: bytes };
    return { name, data: Buffer.from(stampOrigin(bytes.toString('utf8'), origin), 'utf8') };
  });
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  const manifest = JSON.parse(Buffer.from(manifestEntry?.data ?? '').toString('utf8')) as { version?: unknown; host_permissions?: unknown };
  if (manifest.version !== EXTENSION_VERSION) {
    throw new ExtensionTemplateUnusable(`extension template is version ${String(manifest.version)}, this server ships ${EXTENSION_VERSION}; rebuild the extension`);
  }
  const problem = stampedManifestProblem(manifest, origin);
  if (problem) throw new ExtensionTemplateUnusable(problem);
  return zip(entries);
}

// Behind the session gate. `templateDir` null (tests, `pnpm dev` without a build) answers every download with 503.
export function mountExtensionDownloadRoute(app: Hono<AppEnv>, templateDir: string | null, publicOrigin: PublicOrigin | null): void {
  app.get(EXTENSION_DOWNLOAD_PATH, (c) => {
    // Without a configured address only loopback names pass the Host check, so the request's own origin is one.
    const origin = activeOrigin(publicOrigin, c.req.url);
    let bytes: Buffer<ArrayBuffer>;
    try {
      if (!templateDir) throw new ExtensionTemplateUnusable('no extension template configured');
      bytes = packageExtension(templateDir, origin);
    } catch (error) {
      if (!(error instanceof ExtensionTemplateUnusable)) throw error;
      console.error(error.message);
      return c.json({ error: { code: 'extension_unavailable', message: EXTENSION_DOWNLOAD_ERRORS.unavailable } }, 503);
    }
    return c.body(bytes, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${EXTENSION_DOWNLOAD_FILENAME}"`,
      // An upgrade is the same URL again; a cached zip would hand back the old version.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}

// Every file below `root`, as zip entry names: relative, `/`-separated, sorted so the zip comes out the same each time.
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => statSync(join(root, name)).isFile())
    .map((name) => name.split(sep).join('/'))
    .sort();
}
