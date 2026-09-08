import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { close } from '../src/chrome.mjs';

function homeWithPid(pid = 123) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-chrome-close-'));
  const pidFile = path.join(home, 'run', 'chrome.pid');
  fs.mkdirSync(path.dirname(pidFile));
  fs.writeFileSync(pidFile, String(pid));
  return { home, pidFile, profile: path.join(home, 'chrome-profile') };
}

test('记录的 baox Chrome 仍存活但 CDP 不可达时不能当作已关闭', async () => {
  const { pidFile, profile } = homeWithPid();
  const result = await close({ port: 9333, pidFile, profile,
    versionFn: async () => null,
    processCommand: () => `chrome --remote-debugging-port=9333 --user-data-dir=${profile}` });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cdp_unavailable');
});

test('CDP 端口上的进程不能证明使用 baox profile 时拒绝关闭', async () => {
  const { pidFile, profile } = homeWithPid();
  let connected = false;
  const result = await close({ port: 9333, pidFile, profile,
    versionFn: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/x' }),
    processCommand: () => 'chrome --remote-debugging-port=9333 --user-data-dir=/other/profile',
    connectFn: async () => { connected = true; } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'browser_not_owned');
  assert.equal(connected, false);
});

test('PID、profile、端口和 CDP 一致时关闭 baox Chrome', async () => {
  const { pidFile, profile } = homeWithPid();
  const versions = [
    { webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/x' },
    null,
  ];
  const sent = [];
  const result = await close({ port: 9333, pidFile, profile,
    versionFn: async () => versions.shift() ?? null,
    processCommand: () => `chrome --remote-debugging-port=9333 --user-data-dir=${profile}`,
    connectFn: async () => ({ send: async (method) => sent.push(method), close() {} }) });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, ['Browser.close']);
});
