import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachChromiumPage,
  CHROMIUM_CDP_AMBIGUOUS,
  CHROMIUM_CDP_TRANSPORT,
  CHROMIUM_CDP_UNAVAILABLE,
  chromiumCdpTransport,
  evaluateChromiumPage,
  isCdpChromiumPage,
  listChromiumPages,
} from '../src/chromium-cdp.mjs';
import { erpFormAdapterFor, erpWriteAdapterFor } from '../src/erp-browser-adapters.mjs';

const page = {
  transport: 'default', browserFamily: 'chromium', browserBundleId: 'com.google.Chrome',
  tabId: 'native-tab', url: 'https://erp.example/k3/index.aspx', origin: 'https://erp.example',
};

test('Chrome 与 Edge 共用同一个 Chromium/CDP 页面连接器', async () => {
  const session = {
    send: async () => ({ result: { value: [] } }),
    close() {},
  };
  const connected = await attachChromiumPage({ ...page, browserBundleId: 'com.microsoft.edgemac' }, {
    port: 9222,
    targetsFn: async () => [{
      id: 'target-1', url: page.url, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }],
    connectFn: async (url) => { assert.match(url, /devtools\/page/); return session; },
  });
  assert.equal(connected.automation, 'cdp');
  assert.equal(connected.cdpTargetId, 'target-1');
  assert.equal(isCdpChromiumPage(connected), true);
  assert.equal(erpWriteAdapterFor(connected).uploadAndImportInvoices !== undefined, true);
  assert.equal(erpFormAdapterFor(connected).writeCell !== undefined, true);
  assert.deepEqual(await erpFormAdapterFor(connected).formTabs(connected), []);
});

test('Chromium 自动化连接找不到目标页时硬阻塞，不猜其他标签页', async () => {
  await assert.rejects(() => attachChromiumPage(page, {
    port: 9222, targetsFn: async () => [{
      id: 'other', url: 'https://erp.example/other.aspx',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other',
    }],
  }), (error) => error.code === CHROMIUM_CDP_UNAVAILABLE);
});

test('Chromium 自动化连接出现多个同页目标时拒绝猜测', async () => {
  await assert.rejects(() => attachChromiumPage(page, {
    port: 9222,
    targetsFn: async () => [1, 2].map((id) => ({
      id: `target-${id}`, url: page.url,
      webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
    })),
  }), (error) => error.code === CHROMIUM_CDP_AMBIGUOUS);
});

test('CDP 传输按页面复用目标，不依赖 Chrome 或 Edge 品牌', async () => {
  const transport = chromiumCdpTransport({ env: { BAOX_CHROMIUM_CDP_PORT: '9444' }, platform: 'darwin' });
  assert.equal(transport.kind, CHROMIUM_CDP_TRANSPORT);
  assert.equal(transport.cdpPort, 9444);
  const pages = await listChromiumPages({
    port: 9444,
    targetsFn: async () => [{
      type: 'page', id: 'managed-1', url: 'https://erp.example/k3/index.aspx?session=secret',
      title: 'ERP', webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/1',
    }],
  });
  assert.deepEqual(pages[0], {
    transport: 'default', automation: 'cdp', browserFamily: 'chromium',
    tabId: 'managed-1', index: null, url: 'https://erp.example/k3/index.aspx',
    title: 'ERP', active: false, origin: 'https://erp.example', pageId: 'managed-1',
    cdpPort: 9444, cdpTargetId: 'managed-1',
    cdpUrl: 'ws://127.0.0.1:9444/devtools/page/1',
  });

  let closed = false;
  const value = await evaluateChromiumPage(pages[0], '({ ready: document.readyState })', {
    connectFn: async () => ({ close: () => { closed = true; } }),
    evalFn: async (_session, expression, options) => {
      assert.match(expression, /document\.readyState/);
      assert.equal(options.timeout, 15_000);
      return { ready: 'complete' };
    },
  });
  assert.deepEqual(value, { ready: 'complete' });
  assert.equal(closed, true);
});
