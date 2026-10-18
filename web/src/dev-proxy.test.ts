import { EXTENSION_CHANNEL_PATH, LOCAL_EXECUTOR_INSTALL_PATH, LOCAL_EXECUTOR_UNINSTALL_PATH, localExecutorUninstallPath } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { devProxy } from './dev-proxy';

// Under `pnpm dev` (qa/dev.sh) the page and the install command it prints both carry Vite's address, since the server
// takes its origin from the request. Whatever the server answers outside the page therefore has to pass through Vite,
// or the employee's shell gets index.html (QA 2026-10-18: `curl …:5173/install/<码> | sh` met `<!doctype html>`).
describe('the dev server proxy', () => {
  const proxy = devProxy(4319);
  const forwarded = (path: string) => Object.keys(proxy).find((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  it.each([
    `${LOCAL_EXECUTOR_INSTALL_PATH}/775HTZSF`,
    `${LOCAL_EXECUTOR_INSTALL_PATH}/775HTZSF/program`,
    localExecutorUninstallPath('mac'),
    localExecutorUninstallPath('windows'),
    '/api/local-executor/runtime/darwin-arm64',
  ])('forwards %s to the server', (path) => {
    expect(forwarded(path)).toBeDefined();
  });

  it('forwards the channel WebSocket an installed executor opens through the same address', () => {
    const prefix = forwarded(EXTENSION_CHANNEL_PATH);
    expect(prefix).toBeDefined();
    expect(proxy[prefix!]).toMatchObject({ ws: true });
  });

  it('keeps the page routes on Vite', () => {
    expect(forwarded('/settings')).toBeUndefined();
    expect(forwarded(`${LOCAL_EXECUTOR_UNINSTALL_PATH}x`)).toBeUndefined();
  });
});
