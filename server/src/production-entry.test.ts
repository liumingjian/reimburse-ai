import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// #246 (#227): the CDP executor on the server's own Chromium is kept for development, e2e and `pnpm test:erp-live`, and
// a production build refuses it by construction — the production entry cannot reach it, so no setting can select it.
// `scripts/build.mjs` bundles `src/main.ts` as `dist/main.mjs`; this walks the same module graph esbuild bundles there.
// Workspace and npm packages are left out: the CDP executor and the test doubles are this package's own modules.

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const CDP_EXECUTOR = 'src/erp/cdp-executor.ts';
const TEST_DOUBLES = 'src/erp/testing/';

async function bundled(entry: string): Promise<string[]> {
  const { metafile } = await build({ entryPoints: [entry], absWorkingDir: SERVER, bundle: true, write: false, metafile: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'silent' });
  return Object.keys(metafile.inputs);
}

describe('the production build', () => {
  it('cannot select the CDP executor or a test double', async () => {
    const shipped = await bundled('src/main.ts');

    // The walk reached the server proper, so an absence below is a real one.
    expect(shipped).toContain('src/erp/remote-executor.ts');
    expect(shipped).not.toContain(CDP_EXECUTOR);
    expect(shipped.filter((module) => module.startsWith(TEST_DOUBLES))).toEqual([]);
  });

  it.each(['src/dev-main.ts', 'src/e2e-main.ts'])('keeps the CDP executor for %s', async (entry) => {
    expect(await bundled(entry)).toContain(CDP_EXECUTOR);
  });
});
