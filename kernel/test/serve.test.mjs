import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as serve from '../src/serve.mjs';
import { openInBrowser } from '../src/serve.mjs';

// 本地页面是前台阻塞的：命令返回之前 Agent 说不了话，所以"把地址给用户"这件事
// 只能由内核自己做。这里盯住的是那个开关本身。
test('BAOX_NO_AUTO_OPEN=1 时内核不去开浏览器', () => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  try {
    assert.equal(openInBrowser('http://127.0.0.1:1/?nonce=x'), false);
  } finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
});

test('BAOX_NO_AUTO_OPEN=1 时本地服务也不借用受控 Chrome 标签', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  const requests = [];
  const cdp = http.createServer((req, res) => { requests.push(req.url); res.writeHead(500).end(); });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const result = await serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 20 });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(requests, []);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});

test('打不开浏览器不算失败：命令不存在时也不抛', () => {
  const before = process.env.PATH;
  process.env.PATH = '/nonexistent-for-baox-test';
  try {
    assert.doesNotThrow(() => openInBrowser('http://127.0.0.1:1/?nonce=x'));
  } finally { process.env.PATH = before; }
});

// 本地页面每多一个，就多一条"用户在别处点过头"的路径。1.0.0 收窄到两处之后，
// 剩下的两个都是终端做不了的事：认一次身份，翻一遍完整的项目目录。
// 通用单选页和逐段分摊页连同命令一起下线了 —— 分摊改走对话提问，读数确认改走终端表格。
test('本地页面只剩重新绑定身份和浏览项目目录两处', () => {
  const servers = Object.keys(serve).filter((k) => k.startsWith('serve'));
  assert.deepEqual(servers.sort(), ['serveIdentityConfirmation', 'serveTaskSelection']);
});

test('任务选择页借用受控 Chrome 标签，提交后只关闭这个本地标签', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-browser-qa-'));
  const beforeHome = process.env.BAOX_HOME;
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_HOME = home;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const requests = [];
  let openedResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"Browser":"Fixture Chrome"}');
    }
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      openedResolve();
      const url = decodeURIComponent(req.url.slice('/json/new?'.length));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'local-task-page', type: 'page', url }));
    }
    if (req.url === '/json/close/local-task-page') return res.end('Target is closing');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));
  const port = cdp.address().port;

  try {
    let localUrl;
    const pending = serve.serveTaskSelection({
      homeCity: '虚构市', purpose: '虚构客户拜访',
      lines: [{ lineId: 'line-fixture', fileName: 'fixture-invoice.pdf', totalAmount: '12.34' }],
    }, { cdpPort: port, timeoutMs: 1000, onReady: (url) => { localUrl = url; } });

    await opened;
    assert.ok(requests.some((r) => r.url.startsWith('/json/new?')),
      '本地交互页应在受控 Chrome 中打开');
    const response = await fetch(localUrl.replace('/?', '/submit?'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeCity: '虚构市', purpose: '虚构客户拜访',
        projects: { 'line-fixture': 'P-FICTIONAL' } }),
    });
    assert.equal(response.ok, true);
    assert.equal((await pending).status, 'submitted');

    const openedRequest = requests.find((r) => r.url.startsWith('/json/new?'));
    assert.equal(decodeURIComponent(openedRequest.url.slice('/json/new?'.length)), localUrl);
    assert.deepEqual(requests.filter((r) => r.url.startsWith('/json/close/')).map((r) => r.url),
      ['/json/close/local-task-page'], 'ERP 等既有标签不得被关闭');
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    if (beforeHome === undefined) delete process.env.BAOX_HOME;
    else process.env.BAOX_HOME = beforeHome;
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});

test('本地交互超时也关闭自己借用的受控 Chrome 标签', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const requests = [];
  const cdp = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"Browser":"Fixture Chrome"}');
    }
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      const url = decodeURIComponent(req.url.slice('/json/new?'.length));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'timed-out-local-page', type: 'page', url }));
    }
    if (req.url === '/json/close/timed-out-local-page') return res.end('Target is closing');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const result = await serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 20 });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(requests.filter((url) => url.startsWith('/json/close/')),
      ['/json/close/timed-out-local-page']);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('创建本地标签后响应损坏时按本次完整 URL 精确找回，且不关闭既有 ERP 标签', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const requests = [];
  const pages = [
    { id: 'existing-erp-page', type: 'page', url: 'http://erp.example.test/fictional' },
    { id: 'other-local-page', type: 'page', url: 'http://127.0.0.1:1/?nonce=other-invocation' },
  ];
  let localUrl;
  const openedUrls = [];
  let createdResolve;
  const created = new Promise((resolve) => { createdResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"Browser":"Fixture Chrome"}');
    }
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      localUrl = decodeURIComponent(req.url.slice('/json/new?'.length));
      pages.push({ id: 'created-before-damaged-response', type: 'page', url: localUrl });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{damaged');
      createdResolve();
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(pages));
    }
    if (req.url === '/json/close/created-before-damaged-response') {
      pages.splice(pages.findIndex((page) => page.id === 'created-before-damaged-response'), 1);
      return res.end('Target is closing');
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    let readyUrl;
    const pending = serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 1000,
      onReady: (url) => { readyUrl = url; },
      openBrowser: (url) => { openedUrls.push(url); return true; } });
    await created;
    assert.equal(localUrl, readyUrl);
    assert.deepEqual(openedUrls, [], '创建结果不确定时不能回退系统浏览器造成双开');
    const response = await fetch(readyUrl.replace('/?', '/submit?'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.deepEqual(requests.filter((url) => url.startsWith('/json/close/')),
      ['/json/close/created-before-damaged-response']);
    assert.equal(pages.some((page) => page.id === 'existing-erp-page'), true);
    assert.equal(pages.some((page) => page.id === 'other-local-page'), true);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('关闭本地标签遇到非成功响应时有界重试', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  let localUrl;
  let closeAttempts = 0;
  let openedResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    if (req.url === '/json/version') return res.end('{"Browser":"Fixture Chrome"}');
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      localUrl = decodeURIComponent(req.url.slice('/json/new?'.length));
      openedResolve();
      return res.end(JSON.stringify({ id: 'retry-close-page', type: 'page', url: localUrl }));
    }
    if (req.url === '/json/close/retry-close-page') {
      closeAttempts += 1;
      if (closeAttempts < 3) return res.writeHead(503).end('not closed');
      return res.end('Target is closing');
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const pending = serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 1000 });
    await opened;
    const response = await fetch(localUrl.replace('/?', '/submit?'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.equal(closeAttempts, 3);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('关闭本地标签连续失败时不谎报生命周期已完成', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  let localUrl;
  let openedResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  let closeAttempts = 0;
  const cdp = http.createServer((req, res) => {
    if (req.url === '/json/version') return res.end('{"Browser":"Fixture Chrome"}');
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      localUrl = decodeURIComponent(req.url.slice('/json/new?'.length));
      openedResolve();
      return res.end(JSON.stringify({ id: 'unclosed-local-page', type: 'page', url: localUrl }));
    }
    if (req.url === '/json/close/unclosed-local-page') {
      closeAttempts += 1;
      return res.writeHead(503).end('still open');
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const pending = serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 1000 });
    await opened;
    const response = await fetch(localUrl.replace('/?', '/submit?'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.ok, true);
    await assert.rejects(pending, /本地交互页标签关闭失败: unclosed-local-page/);
    assert.equal(closeAttempts, 3);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('本地 HTTP server 出错时仍关闭本次受控 Chrome 标签并报告错误', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const requests = [];
  let localServer;
  let openedResolve;
  const opened = new Promise((resolve) => { openedResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') return res.end('{"Browser":"Fixture Chrome"}');
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      openedResolve();
      const url = decodeURIComponent(req.url.slice('/json/new?'.length));
      return res.end(JSON.stringify({ id: 'server-error-local-page', type: 'page', url }));
    }
    if (req.url === '/json/close/server-error-local-page') return res.end('Target is closing');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const pending = serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 1000,
      onReady: (_url, server) => { localServer = server; } });
    await opened;
    localServer.emit('error', new Error('fixture local server failure'));
    await assert.rejects(pending, /fixture local server failure/);
    assert.deepEqual(requests.filter((url) => url.startsWith('/json/close/')),
      ['/json/close/server-error-local-page']);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('CDP 确实不可用时才回退系统浏览器', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const openedUrls = [];
  const requests = [];
  const cdp = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(503).end('fixture unavailable');
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    let readyUrl;
    const result = await serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 20,
      onReady: (url) => { readyUrl = url; }, openBrowser: (url) => { openedUrls.push(url); return true; } });
    assert.equal(result.status, 'timeout');
    assert.deepEqual(openedUrls, [readyUrl]);
    assert.deepEqual(requests, ['/json/version']);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});


test('创建结果不确定且无法查询 target 时报告清理失败', async () => {
  const beforeAutoOpen = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  let localUrl;
  let createdResolve;
  const created = new Promise((resolve) => { createdResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    if (req.url === '/json/version') return res.end('{"Browser":"Fixture Chrome"}');
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      localUrl = decodeURIComponent(req.url.slice('/json/new?'.length));
      createdResolve();
      return res.end('{damaged');
    }
    if (req.url === '/json/list') return res.writeHead(503).end('cannot inspect');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));

  try {
    const pending = serve.serveIdentityConfirmation({
      identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' },
    }, { cdpPort: cdp.address().port, timeoutMs: 1000 });
    await created;
    const response = await fetch(localUrl.replace('/?', '/submit?'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.ok, true);
    await assert.rejects(pending, /本地交互页标签清理状态未知/);
  } finally {
    await new Promise((resolve) => cdp.close(resolve));
    if (beforeAutoOpen === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = beforeAutoOpen;
  }
});
