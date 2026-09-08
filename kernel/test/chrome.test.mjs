import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME_MODULE = path.join(ROOT, 'src', 'chrome.mjs');

function tempFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-chrome-'));
  const home = path.join(dir, 'home');
  const launches = path.join(dir, 'launches.log');
  const fake = path.join(dir, 'fake-chrome.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
const portArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
const port = Number(portArg.split('=')[1]);
fs.appendFileSync(process.env.BAOX_LAUNCH_LOG, String(process.pid) + '\\n');
if (process.env.BAOX_FAKE_EXIT === '1') process.exit(23);
if (process.env.BAOX_FAKE_NEVER_READY === '1') setInterval(() => {}, 1000);
else setTimeout(() => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Browser: 'FakeChrome', webSocketDebuggerUrl: 'ws://fake' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, '127.0.0.1');
}, Number(process.env.BAOX_FAKE_READY_DELAY || 0));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fake, 0o700);
  return { dir, home, launches, fake };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function launchProcess({ home, fake, launches, port, readyDelay = 0, fakeExit = false,
  neverReady = false, readinessTimeout = 20000, lockWaitTimeout = 25000 }) {
  const source = `import { launch } from ${JSON.stringify(new URL(`file://${CHROME_MODULE}`).href)};\n`
    + `try { process.stdout.write(JSON.stringify(await launch({ port: ${port}, readinessTimeout: ${readinessTimeout}, lockWaitTimeout: ${lockWaitTimeout} }))); } `
    + `catch (err) { process.stdout.write(JSON.stringify({ error: err.message, code: err.code })); process.exitCode = 1; }`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, BAOX_HOME: home, BAOX_CHROME: fake,
        BAOX_LAUNCH_LOG: launches, BAOX_FAKE_READY_DELAY: String(readyDelay),
        BAOX_FAKE_EXIT: fakeExit ? '1' : '0', BAOX_FAKE_NEVER_READY: neverReady ? '1' : '0' },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

function launchedPids(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}

function stopOwnedProcesses(file) {
  for (const pid of launchedPids(file)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

async function fakeCdp({ firstDelay = 0 } = {}) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/version') { res.statusCode = 404; res.end(); return; }
    requests += 1;
    const answer = () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Browser: 'AlreadyRunning', webSocketDebuggerUrl: 'ws://fake' }));
    };
    if (requests === 1 && firstDelay) setTimeout(answer, firstDelay);
    else answer();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('健康 CDP 已存在时，连续调用绝不 spawn', async () => {
  const fixture = tempFixture();
  const cdp = await fakeCdp();
  try {
    const first = await launchProcess({ ...fixture, port: cdp.port });
    const second = await launchProcess({ ...fixture, port: cdp.port });
    assert.ifError(first.error);
    assert.ifError(second.error);
    assert.equal(JSON.parse(first.stdout).started, false);
    assert.equal(JSON.parse(second.stdout).started, false);
    assert.deepEqual(launchedPids(fixture.launches), []);
  } finally {
    stopOwnedProcesses(fixture.launches);
    await cdp.close();
  }
});

test('健康 CDP 的一次瞬时慢响应不会触发替代 spawn', async () => {
  const fixture = tempFixture();
  const cdp = await fakeCdp({ firstDelay: 1700 });
  try {
    const result = await launchProcess({ ...fixture, port: cdp.port });
    assert.ifError(result.error);
    assert.equal(JSON.parse(result.stdout).started, false);
    assert.deepEqual(launchedPids(fixture.launches), [], '已有实例只是一次探测慢，不该再开应用实例');
  } finally {
    stopOwnedProcesses(fixture.launches);
    await cdp.close();
  }
});

test('多个独立进程并发 chrome-up 最多 spawn 一次，且都等到同一 CDP ready', async () => {
  const fixture = tempFixture();
  const port = await freePort();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      launchProcess({ ...fixture, port, readyDelay: 250 })));
    for (const result of results) assert.ifError(result.error);
    assert.equal(launchedPids(fixture.launches).length, 1, '并发请求不应各自启动一个 Chrome');
    const payloads = results.map((r) => JSON.parse(r.stdout));
    assert.equal(payloads.filter((r) => r.started).length, 1);
    assert.equal(payloads.filter((r) => !r.started).length, 5);
  } finally {
    stopOwnedProcesses(fixture.launches);
  }
});


test('stale 启动锁只被移除后替代启动，不关闭任何未知进程', async () => {
  const fixture = tempFixture();
  const port = await freePort();
  const lock = path.join(fixture.home, 'run', 'chrome-launch.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
    pid: 2147483647, token: 'dead-owner', port,
  }));
  const stale = new Date(Date.now() - 31000);
  fs.utimesSync(lock, stale, stale);
  try {
    const result = await launchProcess({ ...fixture, port });
    assert.ifError(result.error);
    assert.equal(JSON.parse(result.stdout).started, true);
    assert.equal(launchedPids(fixture.launches).length, 1);
  } finally {
    stopOwnedProcesses(fixture.launches);
  }
});

test('活跃启动锁的等待错误有界且如实报告', async () => {
  const fixture = tempFixture();
  const port = await freePort();
  const lock = path.join(fixture.home, 'run', 'chrome-launch.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
    pid: process.pid, token: 'live-owner', port,
  }));
  const started = Date.now();
  const result = await launchProcess({ ...fixture, port, lockWaitTimeout: 250 });
  assert.ok(result.error, '等待超时应以失败退出');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, 'CHROME_LAUNCH_LOCK_TIMEOUT');
  assert.match(payload.error, /等待另一个 Chrome 启动请求/);
  assert.ok(Date.now() - started < 3000, '错误必须按配置的边界返回');
  assert.deepEqual(launchedPids(fixture.launches), []);
});

test('虚构 Chrome 在 ready 前退出时立即如实报告，不等 readiness 上限', async () => {
  const fixture = tempFixture();
  const port = await freePort();
  const started = Date.now();
  const result = await launchProcess({ ...fixture, port, fakeExit: true, readinessTimeout: 5000 });
  assert.ok(result.error, '子进程退出应以失败返回');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, 'CHROME_LAUNCH_FAILED');
  assert.match(payload.error, /code=23/);
  assert.ok(Date.now() - started < 3000, '不应伪装成 readiness timeout 等满五秒');
});


test('虚构 Chrome 一直不 ready 时按 readiness 上限报告', async () => {
  const fixture = tempFixture();
  const port = await freePort();
  const started = Date.now();
  try {
    const result = await launchProcess({ ...fixture, port, neverReady: true, readinessTimeout: 500 });
    assert.ok(result.error, 'readiness 超时应以失败返回');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'CDP_TIMEOUT');
    assert.match(payload.error, /1s 内没有响应/);
    assert.ok(Date.now() - started < 3000, 'readiness 等待必须有界');
  } finally {
    stopOwnedProcesses(fixture.launches);
  }
});
