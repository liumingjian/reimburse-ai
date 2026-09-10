import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFromObservation, probeIdentity, sameOrigin } from '../src/probe.mjs';

// 观测样本取自 2026-09-05 对 K3Cloud 8.2.0 的只读探测。
// 关键点是登录页和主控制台**共用同一个 URL**，所以样本之间只差 DOM 信号。

const loginPage = {
  url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
  ready: 'complete',
  title: '金蝶云星空',
  displayName: null,
  // 登出之后 localStorage 里仍然留着上次登录的账号 —— 实测事实。
  account: 'luo.liu',
  tenant: '5f1f13f6dde29e',
  onMainConsole: false,
  loginFormVisible: true,
};

const console_ = {
  ...loginPage,
  displayName: '刘明建',
  onMainConsole: true,
  loginFormVisible: false,
};

test('登录页要报未登录，而不是身份读不出', () => {
  const r = identityFromObservation(loginPage);
  assert.equal(r.status, 'not_logged_in');
  assert.match(r.hint, /登录页/);
});

test('登录页上读得出的账号不能算成已登录的身份', () => {
  const r = identityFromObservation(loginPage);
  // localStorage 里留着上次登录的账号，它标定得了身份，证明不了会话还活着。
  assert.equal(r.status, 'not_logged_in');
  assert.equal(r.identity, undefined);
});

test('读不出用户名又看不见登录表单，是需要人来看的未知态', () => {
  const r = identityFromObservation({ ...loginPage, loginFormVisible: false });
  assert.equal(r.status, 'unknown');
});

test('主控制台上读出的是会话事实：谁登录着，以及他的账号和账套', () => {
  const r = identityFromObservation(console_);
  assert.equal(r.status, 'matched');
  assert.deepEqual(r.identity, { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' });
});

test('主控制台缺账号或账套时不能算 matched', () => {
  for (const missing of [{ account: null }, { tenant: null }]) {
    const r = identityFromObservation({ ...console_, ...missing });
    assert.equal(r.status, 'unknown');
    assert.match(r.hint, /身份不能确定/);
  }
});

test('探针不判断这个人是不是该报销的那个人', () => {
  // 这一层只认会话。是不是本人由个人绑定判（binding.test.mjs），
  // 两件事分开是因为它们的失败处置完全不同：一个要用户去登录，一个要用户去换人。
  assert.equal(identityFromObservation({ ...console_, displayName: '张三', account: 'zhang.san' }).status,
    'matched');
});

test('页面没加载完不下结论', () => {
  assert.equal(identityFromObservation({ ...loginPage, ready: 'loading' }), null);
});

test('正式默认浏览器探针保留 typed page 身份和 origin 传输', async () => {
  const page = {
    transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
    windowId: '7', tabId: '11', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
    origin: 'http://erp.antute.com.cn', pageId: '11',
  };
  const result = await probeIdentity({
    origin: 'http://erp.antute.com.cn', waitMs: 0,
    transport: { transport: 'default' },
    listTabs: async (options) => {
      assert.equal(options.origin, 'http://erp.antute.com.cn');
      assert.equal(options.transport.transport, 'default');
      return [page];
    },
    evaluate: async (received, expression, options) => {
      assert.equal(received, page);
      assert.equal(options.origin, 'http://erp.antute.com.cn');
      assert.match(expression, /k3cloudloginInfo/);
      return { ...console_, url: page.url };
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.transport, 'default');
  assert.equal(result.targetId, '11');
  assert.equal(result.page, page);
});

test('默认浏览器多个 ERP 页面不自动选择任意一个', async () => {
  const pages = [
    { transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
      windowId: '7', tabId: '11', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
      origin: 'http://erp.antute.com.cn', pageId: '11' },
    { transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
      windowId: '8', tabId: '21', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
      origin: 'http://erp.antute.com.cn', pageId: '21' },
  ];
  let evaluated = 0;
  const result = await probeIdentity({
    origin: 'http://erp.antute.com.cn', waitMs: 0,
    transport: { transport: 'default' },
    listTabs: async () => pages,
    evaluate: async () => { evaluated += 1; return console_; },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.transport, 'default');
  assert.equal(result.pageCount, 2);
  assert.match(result.hint, /发现 \d+ 个 ERP 页面/);
  assert.match(result.hint, /保留唯一/);
  assert.equal(evaluated, 0, '多个默认 ERP 页面时不得读取并选中第一个');
});

test('默认浏览器 JS/automation 权限错误不被探针改成未登录', async () => {
  await assert.rejects(() => probeIdentity({
    origin: 'http://erp.antute.com.cn', waitMs: 0,
    transport: { transport: 'default' },
    listTabs: async () => [{
      transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
      windowId: '7', tabId: '11', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
      origin: 'http://erp.antute.com.cn',
    }],
    evaluate: async () => {
      const error = new Error('Allow JavaScript from Apple Events');
      error.code = 'DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED';
      throw error;
    },
  }), (error) => error.code === 'DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED');
});

test('ERP 标签按精确 origin 过滤，不接受同前缀伪域名', () => {
  assert.equal(sameOrigin('http://erp.antute.com.cn/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn'), true);
  assert.equal(sameOrigin('http://erp.antute.com.cn.attacker.test/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn'), false);
  assert.equal(sameOrigin('https://erp.antute.com.cn/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn'), false);
});
