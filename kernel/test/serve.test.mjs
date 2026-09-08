import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('打不开浏览器不算失败：命令不存在时也不抛', () => {
  const before = process.env.PATH;
  process.env.PATH = '/nonexistent-for-baox-test';
  try {
    assert.doesNotThrow(() => openInBrowser('http://127.0.0.1:1/?nonce=x'));
  } finally { process.env.PATH = before; }
});

test('任务选择页只询问事由和逐行项目，不重复填写常驻城市', () => {
  const html = serve.renderTaskSelectPage({
    purpose: '',
    lines: [{ lineId: 'line-1', fileName: '虚构发票.pdf', project: '' }],
  }, 'test-nonce');

  assert.doesNotMatch(html, /id="city"|homeCity:/);
  assert.doesNotMatch(html, /常驻城市、报销事由|常驻城市、事由/);
  assert.match(html, /id="purpose"/);
  assert.match(html, /projects/);
  assert.match(html, /事由和每一行的项目都要填/);
});

// 本地页面每多一个，就多一条"用户在别处点过头"的路径。1.0.0 收窄到两处之后，
// 剩下的两个都是终端做不了的事：认一次身份，翻一遍完整的项目目录。
// 通用单选页和逐段分摊页连同命令一起下线了 —— 分摊改走对话提问，读数确认改走终端表格。
test('常驻城市只能由内核本地页面提交，且不提供默认候选', () => {
  const html = serve.renderHomeCityPage({ current: null, taskOnly: false }, 'test-nonce');
  assert.match(html, /id="homeCity"/);
  assert.match(html, /提交常驻城市/);
  assert.doesNotMatch(html, /value="(?:广州|北京|上海)/);
  assert.match(html, /body: JSON\.stringify\(\{ homeCity \}\)/);
});

test('本地页面包含常驻城市、重新绑定身份和任务选择三处', () => {
  const servers = Object.keys(serve).filter((k) => k.startsWith('serve'));
  assert.deepEqual(servers.sort(), ['serveHomeCityConfirmation', 'serveIdentityConfirmation', 'serveTaskSelection']);
});
