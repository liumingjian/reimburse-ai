import { EXTENSION_ORIGIN_PLACEHOLDER } from '@baox/contract';

// The extension template's stamping rule (#258), kept with the package that owns the template format.
// `scripts/build.mjs` leaves an origin-less template in `dist/`, EXTENSION_ORIGIN_PLACEHOLDER wherever the app's origin
// belongs; whatever hands the extension out stamps exactly one origin in. The server's download
// (`server/src/extension/download.ts`) and the real-browser harness (`e2e/harness.ts`) both stamp through this, so the
// two cannot disagree about which files carry the origin.

// Template files that carry the origin, by extension. Anything else is copied byte for byte.
const CARRIES_ORIGIN: ReadonlySet<string> = new Set(['.js', '.json', '.html', '.css']);

/** Whether the template file `name` (a path; any separator) carries the origin. */
export const carriesOrigin = (name: string): boolean => CARRIES_ORIGIN.has(/\.[^./\\]+$/.exec(name)?.[0] ?? '');

/** A template text file with `origin` stamped in. */
export const stampOrigin = (text: string, origin: string): string => text.replaceAll(EXTENSION_ORIGIN_PLACEHOLDER, origin);

/**
 * Why a stamped `manifest.json` is not an extension for `origin`, or null when it is: its `host_permissions` must be
 * exactly that origin, which also proves the placeholder was there to stamp.
 */
export function stampedManifestProblem(manifest: { host_permissions?: unknown }, origin: string): string | null {
  if (JSON.stringify(manifest.host_permissions) === JSON.stringify([`${origin}/*`])) return null;
  return `the stamped extension carries host_permissions ${JSON.stringify(manifest.host_permissions)}, not ${origin}/*; rebuild the extension template`;
}
