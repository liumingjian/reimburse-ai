import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import * as serve from '../src/serve.mjs';
import { openInBrowser, renderIdentityPage, renderResetPage } from '../src/serve.mjs';
import { browserMode, openDefaultBrowser, systemBrowserCommand } from '../src/browser-open.mjs';
import { renderProjectBookPage } from '../src/project-book-page.mjs';

const identity = { identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' } };
const submitIdentity = (url) => fetch(url.replace('/?', '/submit?'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
});

test('身份确认页使用实际的 Chromium/ego 来源文案', () => {
  const chromium = renderIdentityPage(identity, 'nonce');
  assert.match(chromium, /系统默认 Chromium 浏览器里的 ERP 页面/);
  assert.doesNotMatch(chromium, /ego task space 里的 ERP 页面/);
  const ego = renderIdentityPage({ ...identity, browserLabel: 'ego task space' }, 'nonce');
  assert.match(ego, /ego task space 里的 ERP 页面/);
});

/**
 * Local page lifecycle fixture for the ego transport boundary.
 * `serveLocal` receives a tab handle and is responsible only for using its tabId
 * during cleanup; the browser transport owns tab discovery and creation details.
 */
async function withEgoFixture(config, run) {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const pages = new Map((config.initialPages ?? []).map((page) => [page.tabId, page]));
  const closeCalls = [];
  let localUrl = null;
  let openCount = 0;
  let openedResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const context = { pages, closeCalls, opened, get localUrl() { return localUrl; } };

  const openTab = async (url, options) => {
    localUrl = url;
    const page = config.open
      ? await config.open({ ...context, url, options })
      : { tabId: config.tabId ?? `ego-local-${++openCount}`, url, title: 'fixture' };
    if (page?.tabId) {
      pages.set(page.tabId, page);
      openedResolve(page);
    }
    return page;
  };
  const closeTab = async (tabId) => {
    closeCalls.push(tabId);
    const attempt = closeCalls.filter((id) => id === tabId).length;
    if (config.close) return config.close({ ...context, tabId, attempt });
    pages.delete(tabId);
    return true;
  };

  try {
    await run({ ...context, openTab, closeTab });
  } finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
}

test('BAOX_NO_AUTO_OPEN=1 时服务不调用 ego openTab', async () => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  let calls = 0;
  try {
    const result = await serve.serveIdentityConfirmation(identity, {
      timeoutMs: 20,
      env: { BAOX_BROWSER: 'ego', BAOX_NO_AUTO_OPEN: '1' },
      openTab: async () => { calls += 1; },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(calls, 0);
  } finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
});

test('BAOX_NO_AUTO_OPEN=1 时系统浏览器兼容钩子不启动', () => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  try {
    assert.equal(openInBrowser('http://127.0.0.1:1/?nonce=x'), false);
  } finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
});

test('macOS 使用系统默认 open URL，不指定 Chrome', async () => {
  const url = 'http://127.0.0.1:1234/?nonce=mac';
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};
  const opened = openDefaultBrowser(url, {
    platform: 'darwin',
    spawnCommand: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.emit('spawn'));
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal((await opened).status, 'dispatched');
  assert.deepEqual(calls[0][0], 'open');
  assert.deepEqual(calls[0][1], [url]);
  assert.deepEqual(systemBrowserCommand(url, 'darwin'), ['open', [url]]);
});

test('系统浏览器命令拒绝非 http(s) 或 option-like URL', async () => {
  assert.throws(() => systemBrowserCommand('-a'), { code: 'BROWSER_URL_INVALID' });
  await assert.rejects(openDefaultBrowser('file:///tmp/baox.html'),
    (error) => error.code === 'BROWSER_URL_INVALID');
});

test('系统浏览器启动器错误快速返回，不把服务拖到交互超时', async () => {
  const child = new EventEmitter();
  const opened = openDefaultBrowser('http://127.0.0.1:1234/?nonce=missing', {
    spawnCommand: () => {
      queueMicrotask(() => child.emit('error', new Error('missing launcher')));
      return child;
    },
  });
  await assert.rejects(opened, (error) => error.code === 'BROWSER_OPEN_FAILED');
});

test('系统浏览器启动器非零退出快速返回', async () => {
  const child = new EventEmitter();
  const opened = openDefaultBrowser('http://127.0.0.1:1234/?nonce=exit', {
    spawnCommand: () => {
      queueMicrotask(() => child.emit('close', 17, null));
      return child;
    },
  });
  await assert.rejects(opened, /系统默认浏览器启动失败/);
});

test('系统浏览器启动器超时明确失败', async () => {
  const child = new EventEmitter();
  const opened = openDefaultBrowser('http://127.0.0.1:1234/?nonce=timeout', {
    platform: 'darwin', timeoutMs: 10, spawnCommand: () => child,
  });
  await assert.rejects(opened, (error) => error.code === 'BROWSER_OPEN_TIMEOUT');
});

test('本地服务在系统浏览器启动失败时立即结束，不等完整交互超时', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  try {
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 8 * 60 * 1000,
      env: {},
      openBrowser: () => false,
    });
    await assert.rejects(pending, (error) => error.code === 'BROWSER_OPEN_FAILED');
  } finally {
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});

test('仅 BAOX_BROWSER=ego 选择 ego；BAOX_EGO_TASK_SPACE 不改变默认系统浏览器', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const opened = [];
  let egoCalls = 0;
  try {
    assert.equal(browserMode({ BAOX_EGO_TASK_SPACE: 'qa-space' }), 'system');
    assert.equal(browserMode({ BAOX_BROWSER: 'ego' }), 'ego');
    const result = await serve.serveIdentityConfirmation(identity, {
      timeoutMs: 20,
      env: { BAOX_EGO_TASK_SPACE: 'qa-space' },
      openBrowser: (url) => { opened.push(url); return true; },
      openTab: async () => { egoCalls += 1; return { tabId: 'unexpected-ego-tab' }; },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(opened.length, 1);
    assert.equal(egoCalls, 0);
  } finally {
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});

test('系统浏览器页面提交后只关闭本地 server，不清理无权控制的 tab', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  let readyUrl;
  let closeCalls = 0;
  try {
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 1000,
      env: {},
      onReady: (url) => { readyUrl = url; },
      openBrowser: () => true,
      closeTab: async () => { closeCalls += 1; },
    });
    const response = await submitIdentity(await new Promise((resolve) => {
      const check = () => readyUrl ? resolve(readyUrl) : setImmediate(check);
      check();
    }));
    assert.equal(response.ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.equal(closeCalls, 0);
  } finally {
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});

// Reset 是第三处：它只收一次破坏性操作确认，不承载业务字段。
test('本地页面包含身份、任务选择、个人项目簿和 Full Reset', () => {
  const servers = Object.keys(serve).filter((k) => k.startsWith('serve'));
  assert.deepEqual(servers.sort(), ['serveIdentityConfirmation', 'serveProjectBookPage',
    'serveResetConfirmation', 'serveTaskSelection']);
});

test('Reset 页把清空范围和外部边界说清楚，只提供一次确认', () => {
  const html = renderResetPage({ home: '/tmp/baox-test' }, 'nonce-value');
  assert.match(html, /\/tmp\/baox-test/);
  assert.match(html, /任务、身份、流程进度、日志、浏览器登录状态/);
  assert.match(html, /不会删除原始报销材料，也不会修改 ERP/);
  assert.match(html, /完全重置/);
  assert.match(html, /nonce-value/);
});

test('个人项目簿页只录入项目号，并保留已有项目状态', () => {
  const html = renderProjectBookPage({
    today: '2026-09-09',
    book: { projects: [{ number: 'P-1', name: '很长的 ERP 项目名称', expiresOn: '2026-12-31', lastVerdict: 'confirmed' }] },
  }, 'book-nonce');
  assert.match(html, /id="number"/);
  assert.doesNotMatch(html, /id="expires"/);
  assert.doesNotMatch(html, /expiresOn/);
  assert.match(html, /很长的 ERP 项目名称/);
  assert.match(html, /data-remove=/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /book-nonce/);
  assert.ok(html.includes('let inFlight=false;'));
  assert.ok(html.includes('操作没有完成，请检查网络后重试'));
  assert.ok(html.includes('页面没有正常结束，请检查网络后重试'));
  assert.ok(html.includes('if(!reloadPending){inFlight=false;setBusy(false)}'));
  assert.ok(html.includes('if(!closed){inFlight=false;setBusy(false)}'));
});

test('项目维护核验成功后提交即结束服务，不需要再点击完成', async () => {
  let readyUrl;
  const pending = serve.serveProjectBookPage({ book: { projects: [] } }, {
    timeoutMs: 1000,
    env: {},
    openBrowser: () => true,
    onReady: (url) => { readyUrl = url; },
    onIntake: async (number) => ({ status: 'admitted', number, entry: { number, name: 'ERP 项目' } }),
    onDone: async () => ({ status: 'done' }),
  });
  const url = await new Promise((resolve) => {
    const check = () => readyUrl ? resolve(readyUrl) : setImmediate(check);
    check();
  });
  const response = await fetch(url.replace('/?', '/submit?'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'intake', number: 'P-1' }),
  });
  assert.equal(response.ok, true);
  assert.equal((await pending).status, 'admitted');
});

test('任务选择页提交失败可重试且不会并发提交', () => {
  const html = serve.renderTaskSelectPage({ lines: [], projects: [] }, 'task-nonce');
  assert.ok(html.includes('let inFlight=false;'));
  assert.ok(html.includes('if(inFlight)return;'));
  assert.ok(html.includes('提交失败，请检查网络后重试'));
  assert.ok(html.includes('pendingProject'));
  assert.ok(html.includes('确认覆盖'));
});

test('ego openTab 返回的 tabId 被精确用于清理', async () => {
  await withEgoFixture({ tabId: 'ego-actual' }, async (fixture) => {
    let readyUrl;
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 1000,
      env: { BAOX_BROWSER: 'ego' },
      onReady: (url) => { readyUrl = url; },
      openTab: fixture.openTab,
      closeTab: fixture.closeTab,
    });
    const page = await fixture.opened;
    assert.equal(page.tabId, 'ego-actual');
    assert.equal(page.url, readyUrl);
    const response = await submitIdentity(readyUrl);
    assert.equal(response.ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.deepEqual(fixture.closeCalls, ['ego-actual']);
    assert.equal(fixture.pages.has('ego-actual'), false);
  });
});

test('ego openTab 失败且标签存在未知时拒绝并保留清理风险', async () => {
  await withEgoFixture({
    open: ({ pages, url }) => {
      pages.set('ego-orphan', { tabId: 'ego-orphan', url });
      throw new Error('ego open failed');
    },
  }, async (fixture) => {
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 1000, env: { BAOX_BROWSER: 'ego' },
      openTab: fixture.openTab, closeTab: fixture.closeTab,
    });
    await assert.rejects(pending, (error) => {
      assert.match(String(error), /ego open failed/);
      assert.match(String(error), /清理状态未知/);
      return true;
    });
    assert.deepEqual(fixture.closeCalls, []);
    assert.equal(fixture.pages.has('ego-orphan'), true);
  });
});

test('close 返回 false 时重试三次并明确失败', async () => {
  await withEgoFixture({
    tabId: 'ego-stubborn',
    close: () => false,
  }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 1000, env: { BAOX_BROWSER: 'ego' }, onReady: (value) => { url = value; },
      openTab: fixture.openTab, closeTab: fixture.closeTab,
    });
    const rejection = assert.rejects(pending, /标签关闭失败: ego-stubborn/);
    await fixture.opened;
    const response = await submitIdentity(url);
    assert.equal(response.ok, true);
    await rejection;
    assert.deepEqual(fixture.closeCalls, ['ego-stubborn', 'ego-stubborn', 'ego-stubborn']);
  });
});

test('半提交 body 长连接在 timeout 后有界收口', async () => {
  await withEgoFixture({ tabId: 'ego-half-body' }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 30, env: { BAOX_BROWSER: 'ego' }, onReady: (value) => { url = value; },
      openTab: fixture.openTab, closeTab: fixture.closeTab,
    });
    await fixture.opened;
    const req = http.request(url.replace('/?', '/submit?'), { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 100 } });
    req.on('error', () => {});
    req.write('{"confirmed":');
    const result = await Promise.race([pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('fixture hung')), 1000))]);
    assert.equal(result.status, 'timeout');
    req.destroy();
    assert.deepEqual(fixture.closeCalls, ['ego-half-body']);
  });
});

test('原始 server error 与 cleanup error 同时保留用于诊断', async () => {
  await withEgoFixture({
    tabId: 'ego-both-errors',
    close: () => false,
  }, async (fixture) => {
    let server;
    const pending = serve.serveIdentityConfirmation(identity, {
      timeoutMs: 1000, env: { BAOX_BROWSER: 'ego' }, onReady: (_url, value) => { server = value; },
      openTab: fixture.openTab, closeTab: fixture.closeTab,
    });
    await fixture.opened;
    server.emit('error', new Error('fixture original server error'));
    await assert.rejects(pending, (error) => {
      assert.match(String(error), /fixture original server error/);
      assert.match(String(error), /标签关闭失败: ego-both-errors/);
      return true;
    });
    assert.equal(fixture.closeCalls.length, 3);
  });
});
