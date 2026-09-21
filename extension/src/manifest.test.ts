import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareExtensionVersions, EXTENSION_MINIMUM_VERSION, EXTENSION_VERSION } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { manifestFor, readExtensionVersion } from '../scripts/manifest.mjs';

const contractSource = readFileSync(fileURLToPath(new URL('../../contract/src/extension.ts', import.meta.url)), 'utf8');

// #258 serves the zip built from this manifest, and the server refuses anything below EXTENSION_MINIMUM_VERSION.
// These two facts have to be about the same number, so the thing that writes the manifest and the thing the server
// compares against are pinned to each other here.
describe('the version the extension ships with is the version the server enforces against', () => {
  it('writes the contract version into the manifest', () => {
    expect(readExtensionVersion(contractSource)).toBe(EXTENSION_VERSION);
    expect(manifestFor(readExtensionVersion(contractSource), 'http://10.250.0.222').version).toBe(EXTENSION_VERSION);
  });

  it('never ships a build the server would refuse', () => {
    expect(compareExtensionVersions(EXTENSION_VERSION, EXTENSION_MINIMUM_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it('asks for exactly the origin the build talks to, and for the debugger ADR-0021 requires', () => {
    const manifest = manifestFor(EXTENSION_VERSION, 'http://10.250.0.222');
    expect(manifest.host_permissions).toEqual(['http://10.250.0.222/*']);
    expect(manifest.permissions).toContain('debugger');
    expect(manifest.manifest_version).toBe(3);
  });

  it('says so instead of guessing when the contract stops declaring a version', () => {
    expect(() => readExtensionVersion('export const SOMETHING_ELSE = 1;')).toThrow();
  });
});
