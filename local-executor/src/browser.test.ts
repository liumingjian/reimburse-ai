import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connect } from '@baox/erp-executor/cdp';
import { launchBrowser } from './browser';

vi.mock('@baox/erp-executor/browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('@baox/erp-executor/browser')>();
  return {
    ...original,
    ensureChromium: (options: Parameters<typeof original.ensureChromium>[0]) => original.ensureChromium({
      ...options, extraArgs: [...options.extraArgs ?? [], '--enable-automation'],
    }),
  };
});

describe.runIf(process.platform === 'darwin')('the local browser mode in real Chromium on the QA Mac', () => {
  it.each([undefined, 'headless', 'headed'] as const)('launches %s and closes its dedicated browser', async (browserMode) => {
    const server = createServer((_request, response) => response.end('<title>Local executor browser test</title>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    const profileDir = await mkdtemp(join(tmpdir(), 'baox-browser-mode-'));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser({ profileDir, erpOrigin: `http://127.0.0.1:${address.port}`, ...(browserMode ? { browserMode } : {}) });
      const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json() as { webSocketDebuggerUrl: string };
      const session = await connect(version.webSocketDebuggerUrl);
      try {
        const result = await session.send('Browser.getBrowserCommandLine') as { arguments: string[] };
        expect(result.arguments.some((arg) => arg.startsWith('--headless'))).toBe(browserMode !== 'headed');
        expect(result.arguments).toContain(`--user-data-dir=${profileDir}`);
        if (browserMode === 'headed') await session.send('Browser.close').catch(() => null);
      } finally { session.close(); }
      await browser.close();
      await expect(fetch(`http://127.0.0.1:${browser.port}/json/version`)).rejects.toThrow();
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
