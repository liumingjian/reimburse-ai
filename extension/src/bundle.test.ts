// The executor runs in the extension's service worker, so everything the worker bundles must be browser code. A
// `node:` import would not even build for `platform: 'browser'`; this pins that it builds, and names the one module
// the browser build swaps (`staging.ts` -> `staging.browser.ts`, the `browser` map of @baox/erp-executor).
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('./service-worker.ts', import.meta.url));

describe('the service worker bundle', () => {
  it('carries the executor with no node built-in in it', async () => {
    const result = await build({
      entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser', target: 'chrome116', logLevel: 'silent',
      define: { __BAOX_ORIGIN__: JSON.stringify('http://127.0.0.1:4319') },
    });
    const inputs = Object.keys(result.metafile.inputs);

    expect(inputs.filter((path) => path.startsWith('node:'))).toEqual([]);
    expect(inputs.some((path) => path.endsWith('erp-executor/src/job.ts'))).toBe(true);
    expect(inputs.some((path) => path.endsWith('erp-executor/src/staging.browser.ts'))).toBe(true);
    expect(inputs.some((path) => path.endsWith('erp-executor/src/staging.ts'))).toBe(false);
    expect(result.outputFiles[0]!.text).not.toMatch(/from\s*["']node:|import\(["']node:/);
  });
});

// The manifest loads the content script as a classic script, which cannot `import` anything.
describe('the content script bundle', () => {
  it('is one self-contained script with no module syntax', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./content-script.ts', import.meta.url))], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome116', logLevel: 'silent',
      define: { __BAOX_ORIGIN__: JSON.stringify('http://127.0.0.1:4319') },
    });
    const text = result.outputFiles[0]!.text;
    expect(text).not.toMatch(/^\s*(import|export)\s/m);
    expect(text).toContain('http://127.0.0.1:4319');
  });
});
