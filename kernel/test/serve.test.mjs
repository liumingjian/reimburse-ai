import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as serve from '../src/serve.mjs';
import { openInBrowser, renderResetPage } from '../src/serve.mjs';

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

test('打不开浏览器不算失败：命令不存在时也不抛', () => {
  const before = process.env.PATH;
  process.env.PATH = '/nonexistent-for-baox-test';
  try {
    assert.doesNotThrow(() => openInBrowser('http://127.0.0.1:1/?nonce=x'));
  } finally { process.env.PATH = before; }
});

// Reset 是第三处：它只收一次破坏性操作确认，不承载业务字段。
test('本地页面只有身份、任务选择和 Full Reset 三处', () => {
  const servers = Object.keys(serve).filter((k) => k.startsWith('serve'));
  assert.deepEqual(servers.sort(), ['serveIdentityConfirmation', 'serveResetConfirmation', 'serveTaskSelection']);
});


test('Reset 页把清空范围和外部边界说清楚，只提供一次确认', () => {
  const html = renderResetPage({ home: '/tmp/baox-test' }, 'nonce-value');
  assert.match(html, /\/tmp\/baox-test/);
  assert.match(html, /任务、身份、流程进度、日志、浏览器登录状态/);
  assert.match(html, /不会删除原始报销材料，也不会修改 ERP/);
  assert.match(html, /完全重置/);
  assert.match(html, /nonce-value/);
});
