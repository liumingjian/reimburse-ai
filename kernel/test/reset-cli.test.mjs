import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');

function baoxReset(home, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, 'reset'], {
    encoding: 'utf8',
    env: { ...process.env, BAOX_HOME: home, CLAUDECODE: '1', ...extraEnv },
  });
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

async function confirmReset(home, confirmed) {
  const child = spawn(process.execPath, [BIN, 'reset'], {
    env: { ...process.env, BAOX_HOME: home, BAOX_CDP_PORT: '1',
      BAOX_NO_AUTO_OPEN: '1', CLAUDECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const pageUrl = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?nonce=[a-f0-9]+/)?.[0];
      if (pageUrl) resolve(pageUrl);
    });
    child.once('error', reject);
    child.once('close', (code) => reject(new Error(`reset exited ${code} before opening page: ${stderr}`)));
  });

  const pageUrl = await ready;
  const submit = new URL('/submit', pageUrl);
  submit.search = new URL(pageUrl).search;
  const response = await fetch(submit, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed }),
  });
  assert.equal(response.status, 200);

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  return { code, json: JSON.parse(stdout) };
}

test('BAOX_HOME 根是符号链接时在打开确认页前拒绝', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-link-'));
  const target = path.join(parent, 'target');
  const home = path.join(parent, 'home');
  fs.mkdirSync(target);
  fs.symlinkSync(target, home);

  const { code, json } = baoxReset(home, { BAOX_NO_AUTO_OPEN: '1' });

  assert.equal(code, 2);
  assert.equal(json.status, 'invalid_home');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('空的 BAOX_HOME 已经是初始状态，reset 不创建任何文件', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-empty-'));
  const homes = [path.join(parent, 'missing'), path.join(parent, 'empty')];
  fs.mkdirSync(homes[1]);

  for (const home of homes) {
    const { code, json } = baoxReset(home);

    assert.equal(code, 0);
    assert.equal(json.command, 'reset');
    assert.equal(json.status, 'already_reset');
    assert.match(json.speak, /已经是全新状态/);
    assert.equal(fs.existsSync(home) ? fs.readdirSync(home).length : 0, 0);
  }
});

test('用户在本地页面确认后，baox reset 清空整个 BAOX_HOME', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-confirm-'));
  fs.mkdirSync(path.join(home, 'tasks'));
  fs.writeFileSync(path.join(home, 'identity.json'), '{"account":"tester"}');
  fs.writeFileSync(path.join(home, 'tasks', 'state.json'), '{}');

  const { code, json } = await confirmReset(home, true);

  assert.equal(code, 0);
  assert.equal(json.status, 'reset');
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(json.speak, /ERP.*自行删除/);
});

test('用户取消 Reset 时本地内容保持不变', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-cancel-'));
  const state = path.join(home, 'identity.json');
  fs.writeFileSync(state, 'keep exactly');

  const { code, json } = await confirmReset(home, false);

  assert.equal(code, 0);
  assert.equal(json.status, 'cancelled');
  assert.equal(fs.readFileSync(state, 'utf8'), 'keep exactly');
});
