import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openInBrowser, serveResidentPage } from '../src/serve.mjs';
import { noAutoOpen } from './no-auto-open.mjs';

// 本地页面是前台阻塞的：命令返回之前 Agent 说不了话，所以"把地址给用户"这件事
// 只能由内核自己做。这里盯住的是那个开关本身。
test('BAOX_NO_AUTO_OPEN=1 时内核不去开浏览器', noAutoOpen(() => {
  assert.equal(openInBrowser('http://127.0.0.1:1/?nonce=x'), false);
}));

test('打不开浏览器不算失败：命令不存在时也不抛', () => {
  const before = process.env.PATH;
  process.env.PATH = '/nonexistent-for-baox-test';
  try {
    assert.doesNotThrow(() => openInBrowser('http://127.0.0.1:1/?nonce=x'));
  } finally { process.env.PATH = before; }
});

// —— 长驻形态 ——
// 长驻页与既有的一次性页并存：同一次打开里可以反复提交，服务不关；只有用户点「完成」
// 或闲置超时才关。下面盯住的正是这几条可观察行为，页面渲染本身照旧不在测试范围内。

/** 起一个长驻页，把它的地址和最终结果的 Promise 一并交回来。 */
function startResident(opts = {}) {
  let ready;
  const url = new Promise((r) => { ready = r; });
  const done = serveResidentPage(() => '<!doctype html>ok', { onReady: ready, ...opts });
  return { url, done };
}

const post = (base, path, body) => fetch(new URL(path + base.search, base), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('长驻页在同一次打开里收多次提交，每次都把内核的处理结果回给页面', noAutoOpen(async () => {
  const seen = [];
  const s = startResident({ onSubmit: (body) => { seen.push(body.n); return { count: seen.length }; } });
  const base = new URL(await s.url);

  for (const n of [1, 2, 3]) {
    const res = await post(base, '/submit', { n });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, result: { count: n } });
  }
  assert.deepEqual(seen, [1, 2, 3]);

  // 三次提交之后服务还在：页面还能重新拉出来。
  assert.equal((await fetch(base)).status, 200);

  await post(base, '/done');
  await s.done;
}));

test('只有点「完成」才关闭，最终结果交回调用方', noAutoOpen(async () => {
  const s = startResident({
    onSubmit: () => ({}),
    onDone: (body) => ({ status: 'done', kept: body.kept }),
  });
  const base = new URL(await s.url);

  await post(base, '/submit', {});
  const res = await post(base, '/done', { kept: 2 });
  assert.equal(res.status, 200);
  // 页面必须完整收到这个回答：关服务是在响应写出去之后才做的。
  assert.deepEqual(await res.json(), { ok: true });

  assert.deepEqual(await s.done, { status: 'done', kept: 2 });
  await assert.rejects(fetch(base), '点完成之后服务应当已经关闭');
}));

test('超时也会关闭，并如实说明是超时', noAutoOpen(async () => {
  const s = startResident({ timeoutMs: 30, onSubmit: () => ({}) });
  const base = new URL(await s.url);
  assert.deepEqual(await s.done, { status: 'timeout', timeoutMs: 30 });
  await assert.rejects(fetch(base), '超时之后服务应当已经关闭');
}));

test('超时按闲置算：做一次操作就把计时拨回去', noAutoOpen(async () => {
  const s = startResident({ timeoutMs: 200, onSubmit: () => ({}), onDone: () => ({ status: 'done' }) });
  const base = new URL(await s.url);

  // 每 120ms 动一次，累计超过 200ms 也不该被收走 —— 用户还在干活。
  for (let i = 0; i < 3; i++) {
    await sleep(120);
    assert.equal((await post(base, '/submit', {})).status, 200, '第 ' + (i + 1) + ' 次提交时页面不该已经没了');
  }

  await post(base, '/done');
  assert.deepEqual(await s.done, { status: 'done' });
}));

test('一次慢的提交不会被闲置超时从中间砍断', noAutoOpen(async () => {
  // "复检全部"要往 ERP 跑好几个来回，比闲置阈值久是正常的，不是没人了。
  const s = startResident({
    timeoutMs: 50,
    onSubmit: async () => { await sleep(220); return { ok: 1 }; },
    onDone: () => ({ status: 'done' }),
  });
  const base = new URL(await s.url);

  const res = await post(base, '/submit', {});
  assert.deepEqual(await res.json(), { ok: true, result: { ok: 1 } }, '慢提交要能把结果送到页面');

  await post(base, '/done');
  assert.deepEqual(await s.done, { status: 'done' });
}));

test('nonce 守护全部端点：不匹配一律拒绝，且不会把长驻页关掉', noAutoOpen(async () => {
  const seen = [];
  const s = startResident({ onSubmit: (body) => { seen.push(body); return {}; }, onDone: () => ({ status: 'done' }) });
  const base = new URL(await s.url);
  const bad = new URL(base); bad.search = '?nonce=deadbeef';

  assert.equal((await fetch(bad)).status, 404, '页面本身要挡住');
  assert.equal((await post(bad, '/submit', { n: 1 })).status, 404, '提交要挡住');
  assert.equal((await post(bad, '/done')).status, 404, '完成要挡住');
  assert.equal((await post(new URL('?', base), '/submit', { n: 2 })).status, 404, '不带 nonce 也要挡住');
  assert.deepEqual(seen, [], '被拒的提交不能进到内核');

  // 关键的一条：外面敲错 nonce 不该替用户把页面关了。
  assert.equal((await fetch(base)).status, 200);
  await post(base, '/done');
  assert.deepEqual(await s.done, { status: 'done' });
}));

test('一次提交被拒不终止这次打开：把原因回给页面，服务照旧', noAutoOpen(async () => {
  const s = startResident({
    onSubmit: (body) => { if (body.bad) throw new Error('查无此号'); return { ok: 1 }; },
    onDone: () => ({ status: 'done' }),
  });
  const base = new URL(await s.url);

  const res = await post(base, '/submit', { bad: true });
  assert.equal(res.status, 200, '这是业务上的拒绝，不是协议错误');
  assert.deepEqual(await res.json(), { ok: false, error: '查无此号' });

  assert.deepEqual(await (await post(base, '/submit', {})).json(), { ok: true, result: { ok: 1 } });
  await post(base, '/done');
  assert.deepEqual(await s.done, { status: 'done' });
}));
