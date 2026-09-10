import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');

function baoxReset(home, extraEnv = {}) {
  const env = { ...process.env, BAOX_HOME: home, CLAUDECODE: '1', ...extraEnv };
  delete env.BAOX_EGO_TASK_SPACE;
  delete env.BAOX_EGO_BROWSER;
  const r = spawnSync(process.execPath, [BIN, 'reset'], {
    encoding: 'utf8',
    env,
  });
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
}

test('reset 在任何目录校验前明确阻断旧浏览器关闭路径', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-link-'));
  const target = path.join(parent, 'target');
  const home = path.join(parent, 'home');
  fs.mkdirSync(target);
  fs.symlinkSync(target, home);

  const { code, json } = baoxReset(home, { BAOX_NO_AUTO_OPEN: '1' });

  assert.equal(code, 2);
  assert.equal(json.status, 'blocked');
  assert.equal(json.code, 'EGO_REQUIRED');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('空的 BAOX_HOME 在 reset 中幂等返回且不创建任何文件', () => {
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

test('reset 阻断时即使目录有内容也不清理', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-confirm-'));
  fs.mkdirSync(path.join(home, 'tasks'));
  fs.writeFileSync(path.join(home, 'identity.json'), '{"account":"tester"}');
  fs.writeFileSync(path.join(home, 'tasks', 'state.json'), '{}');

  const { code, json } = baoxReset(home);

  assert.equal(code, 2);
  assert.equal(json.status, 'blocked');
  assert.equal(json.code, 'EGO_REQUIRED');
  assert.equal(fs.readFileSync(path.join(home, 'identity.json'), 'utf8'), '{"account":"tester"}');
  assert.equal(fs.readFileSync(path.join(home, 'tasks', 'state.json'), 'utf8'), '{}');
});

test('reset 阻断时没有取消页，本地内容保持不变', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-cancel-'));
  const state = path.join(home, 'identity.json');
  fs.writeFileSync(state, 'keep exactly');

  const { code, json } = baoxReset(home);

  assert.equal(code, 2);
  assert.equal(json.status, 'blocked');
  assert.equal(json.code, 'EGO_REQUIRED');
  assert.equal(fs.readFileSync(state, 'utf8'), 'keep exactly');
});
