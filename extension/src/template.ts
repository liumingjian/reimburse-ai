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
 * Why a stamped `manifest.json` is not an extension for `origin`, or null when it is: its `host_permissions` and the
 * `matches` of every content script must be exactly that origin, which also proves the placeholder was there to stamp.
 * A content script matching anything else would put the page bridge on a page that is not the app.
 */
export function stampedManifestProblem(manifest: { host_permissions?: unknown; content_scripts?: unknown }, origin: string): string | null {
  const only = JSON.stringify([`${origin}/*`]);
  if (JSON.stringify(manifest.host_permissions) !== only) {
    return `the stamped extension carries host_permissions ${JSON.stringify(manifest.host_permissions)}, not ${origin}/*; rebuild the extension template`;
  }
  const scripts = manifest.content_scripts;
  const matches = Array.isArray(scripts) ? scripts.map((script: { matches?: unknown } | null) => script?.matches) : null;
  if (!matches || matches.length === 0 || matches.some((match) => JSON.stringify(match) !== only)) {
    return `the stamped extension's content scripts match ${JSON.stringify(matches)}, not only ${origin}/*; rebuild the extension template`;
  }
  return null;
}
