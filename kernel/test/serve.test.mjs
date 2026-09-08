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



async function withLifecycleFixture(config, run) {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  delete process.env.BAOX_NO_AUTO_OPEN;
  const pages = [...(config.initialPages ?? [])];
  const requests = [];
  let listReads = 0;
  let localUrl;
  let createdResolve;
  const created = new Promise((resolve) => { createdResolve = resolve; });
  const cdp = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/json/version') return res.end('{"Browser":"Fixture Chrome"}');
    if (req.url === '/json/list') {
      listReads += 1;
      return res.end(JSON.stringify(config.visiblePages?.({ pages, listReads, localUrl }) ?? pages));
    }
    if (req.method === 'PUT' && req.url.startsWith('/json/new?')) {
      localUrl = decodeURIComponent(req.url.slice('/json/new?'.length));
      config.create?.({ pages, localUrl, res });
      createdResolve();
      if (!res.writableEnded) res.end(JSON.stringify({ id: 'response-id', type: 'page', url: localUrl }));
      return;
    }
    if (req.url.startsWith('/json/close/')) {
      const id = decodeURIComponent(req.url.slice('/json/close/'.length));
      config.close?.({ pages, id, res });
      if (!res.writableEnded) res.end('Target is closing');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => cdp.listen(0, '127.0.0.1', resolve));
  try {
    await run({ cdp, pages, requests, created, get localUrl() { return localUrl; } });
  } finally {
    cdp.closeAllConnections();
    await new Promise((resolve) => cdp.close(resolve));
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
}

const identity = { identity: { displayName: '虚构员工', account: 'fixture.user', tenant: 'fixture-tenant' } };
const submitIdentity = (url) => fetch(url.replace('/?', '/submit?'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
});

test('错误创建响应 id 不受信，只关闭前后列表新增且 URL 匹配的 page', async () => {
  await withLifecycleFixture({
    initialPages: [{ id: 'preexisting', type: 'page', url: 'http://erp.invalid/' }],
    create: ({ pages, localUrl, res }) => {
      pages.push({ id: 'actual-new-id', type: 'page', url: localUrl });
      res.end(JSON.stringify({ id: 'preexisting', type: 'page', url: localUrl }));
    },
    close: ({ pages, id }) => pages.splice(pages.findIndex((page) => page.id === id), 1),
  }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 1000, onReady: (u) => { url = u; } });
    await fixture.created;
    assert.equal((await submitIdentity(url)).ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.deepEqual(fixture.requests.filter((r) => r.startsWith('/json/close/')), ['/json/close/actual-new-id']);
    assert.equal(fixture.pages.some((page) => page.id === 'preexisting'), true);
  });
});

test('重复 URL 用创建前后 id 差集消歧，不关闭预存同 URL target', async () => {
  let url;
  await withLifecycleFixture({
    initialPages: [{ id: 'same-url-before', type: 'page', get url() { return url; } }],
    create: ({ pages, localUrl }) => {
      pages.push({ id: 'same-url-new', type: 'page', url: localUrl });
    },
    close: ({ pages, id }) => pages.splice(pages.findIndex((page) => page.id === id), 1),
  }, async (fixture) => {
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 1000, onReady: (u) => { url = u; } });
    await fixture.created;
    assert.equal((await submitIdentity(url)).ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.deepEqual(fixture.requests.filter((r) => r.startsWith('/json/close/')), ['/json/close/same-url-new']);
    assert.equal(fixture.pages.some((page) => page.id === 'same-url-before'), true);
  });
});

test('close 返回 2xx 但 target 仍存在时重试并明确失败', async () => {
  await withLifecycleFixture({
    create: ({ pages, localUrl }) => pages.push({ id: 'stubborn', type: 'page', url: localUrl }),
  }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 1000, onReady: (u) => { url = u; } });
    await fixture.created;
    assert.equal((await submitIdentity(url)).ok, true);
    await assert.rejects(pending, /标签关闭失败: stubborn/);
    assert.equal(fixture.requests.filter((r) => r === '/json/close/stubborn').length, 3);
  });
});

test('创建响应异常后短时重查延迟可见 target，且不打开系统浏览器', async () => {
  const opened = [];
  await withLifecycleFixture({
    create: ({ pages, localUrl, res }) => {
      pages.push({ id: 'delayed', type: 'page', url: localUrl, visibleAfter: 4 });
      res.end('{broken');
    },
    visiblePages: ({ pages, listReads }) => pages.filter((page) => !page.visibleAfter || listReads >= page.visibleAfter),
    close: ({ pages, id }) => pages.splice(pages.findIndex((page) => page.id === id), 1),
  }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 1000, onReady: (u) => { url = u; }, openBrowser: (u) => opened.push(u) });
    await fixture.created;
    assert.equal((await submitIdentity(url)).ok, true);
    assert.equal((await pending).status, 'submitted');
    assert.deepEqual(opened, []);
    assert.deepEqual(fixture.requests.filter((r) => r.startsWith('/json/close/')), ['/json/close/delayed']);
  });
});

test('半提交 body 长连接在 timeout 后有界收口', async () => {
  await withLifecycleFixture({
    create: ({ pages, localUrl }) => pages.push({ id: 'half-body', type: 'page', url: localUrl }),
    close: ({ pages, id }) => pages.splice(pages.findIndex((page) => page.id === id), 1),
  }, async (fixture) => {
    let url;
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 30, onReady: (u) => { url = u; } });
    await fixture.created;
    const req = http.request(url.replace('/?', '/submit?'), { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 100 } });
    req.on('error', () => {});
    req.write('{"confirmed":');
    const result = await Promise.race([pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('fixture hung')), 1000))]);
    assert.equal(result.status, 'timeout');
    req.destroy();
  });
});

test('原始 server error 与 cleanup error 同时保留用于诊断', async () => {
  await withLifecycleFixture({
    create: ({ pages, localUrl }) => pages.push({ id: 'both-errors', type: 'page', url: localUrl }),
  }, async (fixture) => {
    let server;
    const pending = serve.serveIdentityConfirmation(identity, { cdpPort: fixture.cdp.address().port,
      timeoutMs: 1000, onReady: (_url, s) => { server = s; } });
    await fixture.created;
    server.emit('error', new Error('fixture original server error'));
    await assert.rejects(pending, (error) => {
      assert.match(String(error), /fixture original server error/);
      assert.match(String(error), /标签关闭失败: both-errors/);
      return true;
    });
  });
});
