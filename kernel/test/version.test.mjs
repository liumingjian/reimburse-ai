import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/version.mjs';

test('按数字段逐位比较，位数不齐时缺的一位当 0', () => {
  assert.equal(compareVersions('0.9.1', '0.9.1'), 0);
  assert.ok(compareVersions('0.10.0', '0.9.1') > 0, '10 比 9 新，不能按字符串比');
  assert.ok(compareVersions('0.9.1', '0.10.0') < 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.1', '1.0') > 0);
});

test('后缀不参与比较', () => {
  assert.equal(compareVersions('9.9.9-test', '9.9.9'), 0);
  assert.ok(compareVersions('9.9.10-test', '9.9.9-test') > 0);
});

test('比不了就说比不了，不冒充降级', () => {
  // null 会让 install-runtime 放行。拿不准就阻塞的话，一个手写坏了的 VERSION
  // 就能把用户锁死在数据目录里。
  assert.equal(compareVersions(null, '0.9.1'), null);
  assert.equal(compareVersions('', '0.9.1'), null);
  assert.equal(compareVersions('v0.9.1', '0.9.1'), null);
});
