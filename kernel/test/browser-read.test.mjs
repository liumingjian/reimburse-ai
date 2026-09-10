import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  browserInfoForBundleId,
  browserPage,
  browserTransport,
  buildPageBridgeScripts,
  DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED,
  DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED,
  DEFAULT_BROWSER_ORIGIN_REQUIRED,
  DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH,
  DEFAULT_BROWSER_PROTOCOL_ERROR,
  DEFAULT_BROWSER_JXA,
  DEFAULT_BROWSER_UNSUPPORTED,
  evaluateBrowserPage,
  listBrowserTabs,
  runNativeBrowserScript,
} from '../src/browser-read.mjs';

test('只有显式 BAOX_BROWSER=ego 才选择 ego，task space 变量本身不改变选择', () => {
  assert.equal(browserTransport({ env: {} }).transport, 'default');
  assert.equal(browserTransport({ env: { BAOX_EGO_TASK_SPACE: '17' } }).transport, 'default');
  assert.equal(browserTransport({ env: { BAOX_BROWSER: 'ego', BAOX_EGO_TASK_SPACE: '17' } }).transport, 'ego');
});

test('默认浏览器只承认已知 Safari/Chromium scripting dictionary', () => {
  assert.deepEqual(browserInfoForBundleId('com.google.Chrome'), {
    bundleId: 'com.google.Chrome', name: 'Google Chrome', family: 'chromium',
  });
  assert.deepEqual(browserInfoForBundleId('com.apple.Safari'), {
    bundleId: 'com.apple.Safari', name: 'Safari', family: 'safari',
  });
  assert.throws(() => browserInfoForBundleId('com.example.Unknown'),
    (error) => error.code === DEFAULT_BROWSER_UNSUPPORTED);
});

test('默认页列表只返回 origin 范围内的稳定标签身份', async () => {
  const calls = [];
  const run = async (payload) => {
    calls.push(payload);
    if (payload.operation === 'default-browser') return 'com.google.Chrome';
    return [
      { windowId: 7, tabId: 11, index: 0, url: 'http://erp.example/k3/index.aspx?session=secret', title: 'ERP', active: true },
      { windowId: 7, tabId: 12, index: 1, url: 'https://mail.example/inbox', title: 'private page', active: false },
    ];
  };

  const pages = await listBrowserTabs({ origin: 'http://erp.example', platform: 'darwin', run });
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0], {
    transport: 'default', browserBundleId: 'com.google.Chrome', browserName: 'Google Chrome',
    browserFamily: 'chromium', windowId: '7', tabId: '11', index: 0,
    url: 'http://erp.example/k3/index.aspx', title: 'ERP', active: true,
    origin: 'http://erp.example', pageId: '11',
  });
  assert.equal(calls[0].scheme, 'http');
  assert.equal(calls[1].origin, 'http://erp.example');
});

test('页面求值把 exact page identity 和 origin 传给 native helper', async () => {
  const page = browserPage({
    browserBundleId: 'com.google.Chrome', windowId: 7, tabId: 11, index: 0,
    url: 'http://erp.example/k3/index.aspx', title: 'ERP',
  }, { origin: 'http://erp.example' });
  const calls = [];
  const value = await evaluateBrowserPage(page, '({ ready: document.readyState })', {
    platform: 'darwin',
    run: async (payload) => { calls.push(payload); return { ready: 'complete' }; },
  });
  assert.deepEqual(value, { ready: 'complete' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].page, { windowId: '7', tabId: '11', index: 0, url: 'http://erp.example/k3/index.aspx' });
  assert.equal(calls[0].origin, 'http://erp.example');
  assert.match(calls[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].timeoutMs, 15_000);
  assert.equal(calls[0].pageScripts.key, `__baox_read_${calls[0].requestId}`);
});

const runPageScript = (source, context) => vm.runInNewContext(source, context);

test('native 使用的 page bridge 在真实页面 JS 上覆盖 Promise 成功、失败和超时清理', async () => {
  const context = { window: {}, Promise, setTimeout, clearTimeout, JSON };
  const scripts = buildPageBridgeScripts('Promise.resolve({ ready: true })', 'success');
  assert.deepEqual(JSON.parse(runPageScript(scripts.start, context)), { state: 'pending' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(runPageScript(scripts.poll, context)), {
    state: 'fulfilled', value: { ready: true },
  });
  assert.equal(JSON.parse(runPageScript(scripts.cleanup, context)), null);
  assert.equal(context.window[scripts.key], undefined);

  const failed = buildPageBridgeScripts('Promise.reject(new Error("async failed"))', 'failed');
  assert.deepEqual(JSON.parse(runPageScript(failed.start, context)), { state: 'pending' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(runPageScript(failed.poll, context)), {
    state: 'rejected', message: 'async failed',
  });
  runPageScript(failed.cleanup, context);

  const late = buildPageBridgeScripts('new Promise((resolve) => setTimeout(() => resolve("late"), 10))', 'late');
  assert.deepEqual(JSON.parse(runPageScript(late.start, context)), { state: 'pending' });
  runPageScript(late.cleanup, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.window[late.key], undefined, 'settle callback must not recreate a cleaned slot');
  assert.deepEqual(JSON.parse(runPageScript(late.poll, context)), { state: 'missing' });
});

test('Safari bridge uses the sdef direct JavaScript parameter and exact target tab', () => {
  assert.match(DEFAULT_BROWSER_JXA, /app\(\)\.doJavaScript\(source, \{ in: tab \}\)/);
  assert.match(DEFAULT_BROWSER_JXA, /findTab\(findWindow\(input\.page\), input\.page\)/);
});

test('没有 origin 或句柄 URL 变化时，求值在 native 之前阻止', async () => {
  const page = browserPage({
    browserBundleId: 'com.google.Chrome', windowId: 7, tabId: 11, index: 0,
    url: 'http://erp.example/k3/index.aspx',
  });
  let called = false;
  const run = async () => { called = true; return null; };
  await assert.rejects(() => evaluateBrowserPage(page, '1', { platform: 'darwin', run }),
    (error) => error.code === DEFAULT_BROWSER_ORIGIN_REQUIRED);
  assert.equal(called, false);

  const mismatched = { ...page, origin: 'https://elsewhere.example' };
  await assert.rejects(() => evaluateBrowserPage(mismatched, '1', {
    platform: 'darwin', origin: 'http://erp.example', run,
  }), (error) => error.code === DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH
    || error.code === 'DEFAULT_BROWSER_ORIGIN_MISMATCH');
  assert.equal(called, false);
});

test('native helper固定 JSON argv，缺权限和协议错误使用稳定错误码', async () => {
  const spawnImpl = (_command, args) => {
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-']);
    const listeners = new Map();
    const child = {
      stdout: { on: (event, fn) => listeners.set(`stdout:${event}`, fn) },
      stderr: { on: (event, fn) => listeners.set(`stderr:${event}`, fn) },
      stdin: { end: (script) => {
        assert.match(script, /NSRunningApplication/);
        listeners.get('stdout:data')?.('{"ok":false,"error":{"code":"12","message":"Executing JavaScript through AppleScript is turned off"}}\n');
        listeners.get('close:close')?.(1, null);
      } },
      once: (event, fn) => listeners.set(`close:${event}`, fn),
      kill: () => {},
    };
    assert.doesNotThrow(() => JSON.parse(args[3]));
    return child;
  };
  await assert.rejects(() => runNativeBrowserScript({ operation: 'evaluate', expression: '1' }, {
    platform: 'darwin', spawnImpl,
  }), (error) => error.code === DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED);

  const protocolSpawn = (_command, _args) => {
    const listeners = new Map();
    const child = {
      stdout: { on: (_event, fn) => { listeners.set('out', fn); } },
      stderr: { on: (_event, fn) => { listeners.set('err', fn); } },
      stdin: { end: () => { listeners.get('out')?.('not json\n'); listeners.get('close')?.(1, null); } },
      once: (event, fn) => listeners.set(event, fn), kill: () => {},
    };
    return child;
  };
  await assert.rejects(() => runNativeBrowserScript({ operation: 'list-tabs' }, {
    platform: 'darwin', spawnImpl: protocolSpawn,
  }), (error) => error.code === DEFAULT_BROWSER_PROTOCOL_ERROR);
  assert.equal(DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED, 'DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED');
});
