import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFromObservation } from '../src/probe.mjs';

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
  const r = identityFromObservation(loginPage, 'luo.liu');
  // 期望的账号恰好等于 localStorage 里留下的那个，也不许放行。
  assert.equal(r.status, 'not_logged_in');
  assert.equal(r.identity, undefined);
});

test('读不出用户名又看不见登录表单，是需要人来看的未知态', () => {
  const r = identityFromObservation({ ...loginPage, loginFormVisible: false });
  assert.equal(r.status, 'unknown');
});

test('主控制台上按显示名或登录账号任一匹配都算一致', () => {
  assert.equal(identityFromObservation(console_).status, 'matched');
  assert.equal(identityFromObservation(console_, '刘明建').status, 'matched');
  assert.equal(identityFromObservation(console_, 'luo.liu').status, 'matched');
});

test('登录的不是本人就是硬阻塞，且说清楚当前是谁', () => {
  const r = identityFromObservation(console_, '张三');
  assert.equal(r.status, 'mismatched');
  assert.match(r.hint, /刘明建/);
});

test('页面没加载完不下结论', () => {
  assert.equal(identityFromObservation({ ...loginPage, ready: 'loading' }), null);
});
