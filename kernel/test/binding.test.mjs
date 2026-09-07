import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindingVerdict } from '../src/binding.mjs';

// 身份取自 2026-09-07 的真机探测：显示名和登录账号本来就不是一回事
// （刘明建 / luo.liu），这正是 --expect 那条路走不通的原因。
const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const bound = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };

test('没绑定过就是 unbound，不是放行', () => {
  assert.equal(bindingVerdict(null, me), 'unbound');
});

test('account + tenant 都对上才算本人', () => {
  assert.equal(bindingVerdict(bound, me), 'matched');
  assert.equal(bindingVerdict(bound, { ...me, account: 'zhang.san' }), 'mismatched');
  assert.equal(bindingVerdict(bound, { ...me, tenant: 'other-acct' }), 'mismatched',
    '换账套等于换一整套主数据，不能算同一个人');
});

test('显示名不是判据', () => {
  // ERP 里改得动显示名，拿它当门栓等于把门栓拴在别人能拧的东西上。
  assert.equal(bindingVerdict(bound, { ...me, displayName: '刘明健' }), 'matched');
  assert.equal(bindingVerdict({ ...bound, account: 'zhang.san' }, me), 'mismatched',
    '显示名一样也拦住');
});

test('读不出账号或账套时不冒充匹配', () => {
  assert.equal(bindingVerdict(bound, { ...me, account: null }), 'incomplete');
  assert.equal(bindingVerdict(bound, { ...me, tenant: null }), 'incomplete');
  assert.equal(bindingVerdict(null, { ...me, account: null }), 'incomplete');
});

test('确认下来的绑定落盘、读得回来，且只存判据加一个给人看的名字', async () => {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-binding-'));
  const { readBinding, writeBinding } = await import('../src/binding.mjs');
  assert.equal(readBinding(), null, '没确认过就是没有，不给默认值');

  const written = writeBinding(me);
  assert.equal(written.account, 'luo.liu');
  assert.equal(written.tenant, '5f1f13f6dde29e');
  assert.equal(written.displayName, '刘明建');
  assert.ok(written.confirmedAt, '什么时候认的要留痕');

  const back = readBinding();
  assert.deepEqual(back, written);
  assert.equal(bindingVerdict(back, me), 'matched');
});
