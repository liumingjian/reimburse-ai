// Origin: kernel/test/chromium-cdp.test.mjs (translated to Vitest; inputs and expected outputs kept).
// The kernel's erp-browser-adapters assertions (ego vs CDP adapter choice) become direct checks on the CDP page,
// since the TypeScript executor targets CDP only (ADR-0016 drops ego).
import { describe, expect, it } from 'vitest';
import {
  attachChromiumPage, CHROMIUM_CDP_AMBIGUOUS, CHROMIUM_CDP_TRANSPORT, CHROMIUM_CDP_UNAVAILABLE, chromiumCdpTransport,
  evaluateChromiumPage, isCdpChromiumPage, listChromiumPages, type ChromiumPage,
} from './chromium';
import { formTabs } from './erpform';

const page: ChromiumPage = {
  transport: 'default', browserFamily: 'chromium', browserBundleId: 'com.google.Chrome',
  tabId: 'native-tab', url: 'https://erp.example/k3/index.aspx', origin: 'https://erp.example',
};

describe('Chromium CDP page connector', () => {
  it('attaches Chrome and Edge through the same Chromium/CDP connector', async () => {
    const session = { send: async () => ({ result: { value: [] } }), close() {} };
    const connected = await attachChromiumPage({ ...page, browserBundleId: 'com.microsoft.edgemac' }, {
      port: 9222,
      targetsFn: async () => [{ id: 'target-1', url: page.url, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1' }],
      connectFn: async (url) => { expect(url).toMatch(/devtools\/page/); return session; },
    });
    expect(connected.automation).toBe('cdp');
    expect(connected.cdpTargetId).toBe('target-1');
    expect(isCdpChromiumPage(connected)).toBe(true);
    expect(await formTabs(connected.session)).toEqual([]);
  });

  it('hard-stops when the target page is missing; never guesses another tab', async () => {
    await expect(attachChromiumPage(page, {
      port: 9222, targetsFn: async () => [{ id: 'other', url: 'https://erp.example/other.aspx', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other' }],
    })).rejects.toMatchObject({ code: CHROMIUM_CDP_UNAVAILABLE });
  });

  it('refuses to guess between several identical targets', async () => {
    await expect(attachChromiumPage(page, {
      port: 9222,
      targetsFn: async () => [1, 2].map((id) => ({ id: `target-${id}`, url: page.url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` })),
    })).rejects.toMatchObject({ code: CHROMIUM_CDP_AMBIGUOUS });
  });

  it('reuses the target per page, independent of the Chrome or Edge brand', async () => {
    const transport = chromiumCdpTransport({ env: { BAOX_CHROMIUM_CDP_PORT: '9444' }, platform: 'darwin' });
    expect(transport.kind).toBe(CHROMIUM_CDP_TRANSPORT);
    expect(transport.cdpPort).toBe(9444);
    const pages = await listChromiumPages({
      port: 9444,
      targetsFn: async () => [{ type: 'page', id: 'managed-1', url: 'https://erp.example/k3/index.aspx?session=secret', title: 'ERP', webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/1' }],
    });
    expect(pages[0]).toEqual({
      transport: 'default', automation: 'cdp', browserFamily: 'chromium',
      tabId: 'managed-1', index: null, url: 'https://erp.example/k3/index.aspx',
      title: 'ERP', active: false, origin: 'https://erp.example', pageId: 'managed-1',
      cdpPort: 9444, cdpTargetId: 'managed-1', cdpUrl: 'ws://127.0.0.1:9444/devtools/page/1',
    });

    let closed = false;
    const value = await evaluateChromiumPage(pages[0]!, '({ ready: document.readyState })', {
      connectFn: async () => ({ send: async () => ({}), close: () => { closed = true; } }),
      evalFn: async (_session, expression, options) => {
        expect(expression).toMatch(/document\.readyState/);
        expect(options.timeout).toBe(15_000);
        return { ready: 'complete' };
      },
    });
    expect(value).toEqual({ ready: 'complete' });
    expect(closed).toBe(true);
  });
});
