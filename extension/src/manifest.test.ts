import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareClientVersions, MINIMUM_CLIENT_VERSION, EXTENSION_ORIGIN_PLACEHOLDER, CLIENT_VERSION } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { manifestFor, readExtensionVersion, readOriginPlaceholder } from '../scripts/manifest.mjs';
import { stampedManifestProblem } from './template';

const contractSource = ['channel.ts', 'extension.ts'].map((file) => readFileSync(fileURLToPath(new URL(`../../contract/src/${file}`, import.meta.url)), 'utf8')).join('\n');

// #258 serves the zip built from this manifest, and the server refuses anything below MINIMUM_CLIENT_VERSION.
// These two facts have to be about the same number, so the thing that writes the manifest and the thing the server
// compares against are pinned to each other here.
describe('the version the extension ships with is the version the server enforces against', () => {
  it('writes the contract version into the manifest', () => {
    expect(readExtensionVersion(contractSource)).toBe(CLIENT_VERSION);
    expect(manifestFor(readExtensionVersion(contractSource), 'http://10.250.0.222').version).toBe(CLIENT_VERSION);
  });

  it('never ships a build the server would refuse', () => {
    expect(compareClientVersions(CLIENT_VERSION, MINIMUM_CLIENT_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it('asks for exactly the origin the build talks to, and for the debugger ADR-0021 requires', () => {
    const manifest = manifestFor(CLIENT_VERSION, 'http://10.250.0.222');
    expect(manifest.host_permissions).toEqual(['http://10.250.0.222/*']);
    expect(manifest.permissions).toContain('debugger');
    expect(manifest.manifest_version).toBe(3);
  });

  // #290: the page bridge runs on the app's own pages and nowhere else, inside host_permissions so no prompt appears.
  it('runs its content script on exactly the origin the build talks to', () => {
    const manifest = manifestFor(CLIENT_VERSION, 'http://10.250.0.222');
    expect(manifest.content_scripts).toEqual([expect.objectContaining({ matches: ['http://10.250.0.222/*'], js: ['content-script.js'] })]);
    expect(stampedManifestProblem(manifest, 'http://10.250.0.222')).toBeNull();
  });

  it('is not an extension for an origin its content script does not match', () => {
    const manifest = manifestFor(CLIENT_VERSION, 'http://10.250.0.222');
    const elsewhere = { ...manifest, content_scripts: [{ ...manifest.content_scripts[0], matches: ['<all_urls>'] }] };
    expect(stampedManifestProblem(elsewhere, 'http://10.250.0.222')).toMatch(/content scripts/);
    expect(stampedManifestProblem({ ...manifest, content_scripts: [] }, 'http://10.250.0.222')).toMatch(/content scripts/);
  });

  // The server finds the place to put its origin by this string, so the build must write the one the server looks for.
  it('builds with the origin placeholder the server fills in', () => {
    expect(readOriginPlaceholder(contractSource)).toBe(EXTENSION_ORIGIN_PLACEHOLDER);
  });

  it('says so instead of guessing when the contract stops declaring a version', () => {
    expect(() => readExtensionVersion('export const SOMETHING_ELSE = 1;')).toThrow();
  });
});
