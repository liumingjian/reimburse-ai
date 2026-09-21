import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// #246 (#227): the CDP executor on the server's own Chromium is kept for development, e2e and `pnpm test:erp-live`, and
// a production build refuses it by construction — the production entry cannot reach it, so no setting can select it.
// `scripts/build.mjs` bundles `src/main.ts` as `dist/main.mjs`; this walks the same module graph esbuild bundles there.
// Workspace and npm packages are not walked into, only named: the CDP executor and the test doubles are this package's
// own modules, and what spawns Chromium (`@baox/erp-executor/browser`) is a package subpath the graph must not import.

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const CDP_EXECUTOR = 'src/erp/cdp-executor.ts';
const TEST_DOUBLES = 'src/erp/testing/';

async function graph(entry: string): Promise<{ modules: string[]; packages: string[] }> {
  const { metafile } = await build({ entryPoints: [entry], absWorkingDir: SERVER, bundle: true, write: false, metafile: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'silent' });
  const packages = Object.values(metafile.inputs).flatMap((input) => input.imports.filter((imported) => imported.external).map((imported) => imported.path));
  return { modules: Object.keys(metafile.inputs), packages: [...new Set(packages)] };
}
const bundled = async (entry: string) => (await graph(entry)).modules;

describe('the production build', () => {
  it('cannot select the CDP executor or a test double', async () => {
    const shipped = await bundled('src/main.ts');

    // The walk reached the server proper, so an absence below is a real one.
    expect(shipped).toContain('src/erp/remote-executor.ts');
    expect(shipped).not.toContain(CDP_EXECUTOR);
    expect(shipped.filter((module) => module.startsWith(TEST_DOUBLES))).toEqual([]);
  });

  // The server's own project catalog over the dedicated Chromium is gone from production (#246 review): a job checks
  // project numbers in the employee's ERP tab. So nothing the production entry imports can start a browser.
  it('cannot reach the code that spawns Chromium', async () => {
    const { packages } = await graph('src/main.ts');

    expect(packages).toContain('@baox/erp-executor/wire');
    expect(packages).not.toContain('@baox/erp-executor/browser');
    expect(packages).not.toContain('@baox/erp-executor/chromium');
  });

  it.each(['src/dev-main.ts', 'src/e2e-main.ts'])('keeps the CDP executor for %s', async (entry) => {
    expect(await bundled(entry)).toContain(CDP_EXECUTOR);
  });
});
