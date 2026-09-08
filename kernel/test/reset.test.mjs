import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetHome, validateResetHome } from '../src/reset.mjs';

test('明显危险的 BAOX_HOME 路径直接拒绝', () => {
  for (const home of ['relative-baox-home', path.parse(process.cwd()).root, os.homedir()]) {
    assert.equal(validateResetHome(home).status, 'invalid_home', home);
  }
});

test('baox 浏览器关不掉时不清空 BAOX_HOME', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-close-fail-'));
  const state = path.join(home, 'tasks.json');
  fs.writeFileSync(state, 'keep exactly');

  const result = await resetHome(home, {
    closeBrowser: async () => ({ ok: false, reason: 'still_running' }),
  });

  assert.equal(result.status, 'browser_close_failed');
  assert.match(result.speak, /手动关闭.*重试/);
  assert.equal(fs.readFileSync(state, 'utf8'), 'keep exactly');
});


test('关闭浏览器后清空整个 BAOX_HOME，但不跟随内部符号链接', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-success-'));
  const home = path.join(parent, 'home');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(path.join(home, 'tasks'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(home, 'tasks', 'state.json'), '{}');
  fs.writeFileSync(path.join(home, 'identity.json'), '{}');
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside stays');
  fs.symlinkSync(outside, path.join(home, 'linked-outside'));

  const result = await resetHome(home, {
    closeBrowser: async () => ({ ok: true }),
  });

  assert.equal(result.status, 'reset');
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside stays');
  assert.match(result.speak, /ERP.*自行删除/);
  assert.match(result.speak, /未保存.*关闭/);
});

test('BAOX_HOME 是符号链接时拒绝 Reset，不关闭浏览器也不删除目标', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-root-link-'));
  const target = path.join(parent, 'target');
  const home = path.join(parent, 'home');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'sentinel.txt'), 'keep exactly');
  fs.symlinkSync(target, home);
  let closeCalled = false;

  const result = await resetHome(home, {
    closeBrowser: async () => { closeCalled = true; return { ok: true }; },
  });

  assert.equal(result.status, 'invalid_home');
  assert.equal(closeCalled, false);
  assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'keep exactly');
});

test('有内容删除不了时如实报告失败并让用户处理后重试', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-delete-fail-'));
  const locked = path.join(home, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'state.json'), '{}');
  fs.chmodSync(locked, 0o500);

  try {
    const result = await resetHome(home, {
      closeBrowser: async () => ({ ok: true }),
    });

    assert.equal(result.status, 'reset_failed');
    assert.match(result.speak, /未能全部清除.*处理后重试/);
    assert.ok(fs.existsSync(locked));
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
