import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intakeProject, MAX_QUERIES } from '../src/projectintake.mjs';
import { readBook, writeBook } from '../src/projects.mjs';

// 每个用例自己一个数据根：录入闸门要真的写簿子，写的必须是临时目录里那一份。
function freshHome() {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-intake-'));
  return process.env.BAOX_HOME;
}

// ---- 假的 ERP 查询 --------------------------------------------------------
// 全程不联网：注入的是 verifyProject 这一层，喂的是它实测报文形状下会给出的答案。
// 每个假查询都计次——"明确判定一次都不重试"和"传输层失败重试到 3 次"这两条
// 只有靠调用次数才证得了。

const counting = (impl) => {
  const fake = async (...args) => { fake.calls += 1; return impl(...args); };
  fake.calls = 0;
  return fake;
};

const verdictOf = (v) => counting(async (_ws, number) => ({ ok: true, number, ...v }));
const confirmed = (name) => verdictOf({ verdict: 'confirmed', name });
const missing = () => verdictOf({ verdict: 'missing' });
const ambiguous = (count = 2) => verdictOf({ verdict: 'ambiguous', count });
const forbidden = (name) => verdictOf({ verdict: 'unusable', name, documentStatus: 'C', forbidStatus: 'B' });
const unaudited = (name) => verdictOf({ verdict: 'unusable', name, documentStatus: 'A', forbidStatus: 'A' });
const transportFail = (reason = 'ERP 查询返回了非 JSON 内容：<html>') =>
  counting(async () => ({ ok: false, reason }));

/** 身份已 matched 的会话。真机上它是一条 CDP 地址，这里只要它不是 null。 */
const loggedIn = async () => ({ ok: true, wsUrl: 'ws://fake', probe: { status: 'matched', identity: { account: 'lmj' } } });
const loggedOut = async () => ({ ok: false, probe: { status: 'no_session' } });

const run = (number, verify, opts = {}) =>
  intakeProject(number, { gate: loggedIn, verify, now: () => '2026-09-07T03:00:00.000Z', ...opts });

// ---- confirmed：进簿，名称取 ERP 回读值 ------------------------------------

test('ERP 确认的项目当场进簿，名称是 ERP 回读值', async () => {
  freshHome();
  const verify = confirmed('安图特某某研发项目');
  const r = await run('111454', verify);

  assert.equal(r.status, 'admitted');
  assert.equal(verify.calls, 1);
  assert.deepEqual(r.entry, {
    number: '111454',
    name: '安图特某某研发项目',
    confirmedAt: '2026-09-07T03:00:00.000Z',
    expiresOn: null,
    lastCheckedAt: '2026-09-07T03:00:00.000Z',
    lastVerdict: 'confirmed',
  });
  // 落盘了，而且返回的簿子就是盘上那一份。
  assert.deepEqual(readBook().projects, [r.entry]);
  assert.deepEqual(r.book.projects, [r.entry]);
});

test('用户打的名字没有权威性：进簿的名称一律是 ERP 回读值', async () => {
  freshHome();
  const r = await run('111454', confirmed('ERP 里的真名'), { name: '用户自己打的名字' });
  assert.equal(r.entry.name, 'ERP 里的真名');
  assert.equal(readBook().projects[0].name, 'ERP 里的真名');
});

test('粘进来的项目号两头的空白不算数', async () => {
  freshHome();
  const r = await run('  111454\n', confirmed('某某项目'));
  assert.equal(r.status, 'admitted');
  assert.equal(r.entry.number, '111454');
});

// ---- 四类明确判定：拒绝录入，各自一条话术，一次都不重试 ---------------------

test('查无此号被拒，话术指向改成真实存在的项目号', async () => {
  freshHome();
  const verify = missing();
  const r = await run('999999', verify);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'missing');
  assert.match(r.note, /真实存在的项目号/);
  assert.equal(verify.calls, 1, '明确判定一次都不重试');
  assert.deepEqual(readBook().projects, [], '被拒的项目号一个字节都不落盘');
});

test('一号对多条被拒，话术说明 baox 不替用户挑', async () => {
  freshHome();
  const verify = ambiguous(3);
  const r = await run('111454', verify);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'ambiguous');
  assert.match(r.note, /不替你挑/);
  assert.match(r.note, /3 条/);
  assert.equal(verify.calls, 1);
  assert.deepEqual(readBook().projects, []);
});

test('已禁用和还没审核都被拒，两者话术可区分', async () => {
  freshHome();
  const off = await run('111454', forbidden('已结题的项目'));
  const draft = await run('111455', unaudited('刚建还没审的项目'));

  assert.equal(off.status, 'rejected');
  assert.equal(off.verdict, 'unusable');
  assert.equal(draft.status, 'rejected');
  assert.equal(draft.verdict, 'unusable');

  assert.match(off.note, /已被禁用/);
  assert.match(draft.note, /还没审核/);
  assert.notEqual(off.note, draft.note, '两种不能引用的原因要说得出区别');
  assert.deepEqual(readBook().projects, []);
});

test('四类明确判定全都只查一次——ERP 已经给了答案，再问两遍还是同一个答案', async () => {
  for (const [label, verify] of [['missing', missing()], ['ambiguous', ambiguous()],
    ['forbidden', forbidden('x')], ['unaudited', unaudited('x')]]) {
    freshHome();
    await run('111454', verify);
    assert.equal(verify.calls, 1, `${label} 不该重试`);
  }
});

// ---- 传输层失败：重试到 MAX_QUERIES 次 -------------------------------------

test('传输层失败重试满 MAX_QUERIES 次才算失败', async () => {
  freshHome();
  const verify = transportFail('ERP 查询返回了非 JSON 内容：<html>');
  const r = await run('111454', verify);

  assert.equal(r.status, 'query_failed');
  assert.equal(verify.calls, MAX_QUERIES, `查询要发满 ${MAX_QUERIES} 次`);
  assert.equal(MAX_QUERIES, 3);
  assert.match(r.note, /稍后再试/);
  assert.match(r.note, /非 JSON/, '最后一次失败的原因要带出来，不然没法排障');
  assert.deepEqual(readBook().projects, [], '没问出答案就不写盘');
});

test('中途恢复的查询照样算数，不白白跑满次数', async () => {
  freshHome();
  let n = 0;
  const verify = counting(async (_ws, number) => (++n < 3
    ? { ok: false, reason: '查询超时' }
    : { ok: true, number, verdict: 'confirmed', name: '某某项目' }));

  const r = await run('111454', verify);
  assert.equal(r.status, 'admitted');
  assert.equal(verify.calls, 3);
  assert.equal(readBook().projects[0].name, '某某项目');
});

// ---- 没有会话：既不失败也不重试 --------------------------------------------

test('没有 matched 会话时不写盘、不重试，答的是"请先登录"', async () => {
  freshHome();
  const verify = counting(async () => assert.fail('没登录就不该发出任何查询'));
  const r = await run('111454', verify, { gate: loggedOut });

  assert.equal(r.status, 'not_logged_in');
  assert.notEqual(r.status, 'query_failed', '没登录不是录入失败');
  assert.equal(verify.calls, 0);
  assert.match(r.note, /登录/);
  assert.deepEqual(readBook().projects, []);
});

// ---- 安全键：在任何查询发生之前就拒 ----------------------------------------

test('不安全的项目号在任何查询发生之前就被拒', async () => {
  freshHome();
  const verify = counting(async () => ({ ok: true, verdict: 'confirmed', name: '不该走到这里' }));
  const r = await run("111454' or '1'='1", verify);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'unsafe');
  assert.equal(verify.calls, 0, '假查询一次都不该被调用');
  assert.match(r.note, /不能安全查询的字符/, '沿用既有的拒绝语');
  assert.deepEqual(readBook().projects, []);
});

test('空项目号也是当场拒，不去问 ERP', async () => {
  freshHome();
  const verify = counting(async () => ({ ok: true, verdict: 'confirmed' }));
  for (const bad of ['', '   ', null, undefined]) {
    const r = await run(bad, verify);
    assert.equal(r.status, 'rejected', `${JSON.stringify(bad)} 该被拒`);
    assert.equal(r.verdict, 'unsafe');
  }
  assert.equal(verify.calls, 0);
});

test('安全键先于会话判定：不安全的号连登录都不用问', async () => {
  freshHome();
  const verify = counting(async () => ({ ok: true, verdict: 'confirmed' }));
  const r = await run('bad number!', verify, { gate: loggedOut });
  assert.equal(r.verdict, 'unsafe', '拼不进查询串的号，登不登录都一样是拒');
  assert.equal(verify.calls, 0);
});

// ---- 重复录入：刷新，不新增 ------------------------------------------------

test('重复录入同一项目号刷新既有条目，簿子长度不变', async () => {
  freshHome();
  writeBook({ projects: [
    { number: '111454', name: '旧名字', confirmedAt: '2026-01-01T00:00:00.000Z',
      expiresOn: '2026-12-31', lastCheckedAt: '2026-01-01T00:00:00.000Z', lastVerdict: 'unusable' },
    { number: '111455', name: '别的项目', confirmedAt: '2026-01-01T00:00:00.000Z',
      expiresOn: null, lastCheckedAt: '2026-01-01T00:00:00.000Z', lastVerdict: 'confirmed' },
  ] });

  const r = await run('111454', confirmed('ERP 里的新名字'));
  const book = readBook();

  assert.equal(r.status, 'admitted');
  assert.equal(book.projects.length, 2, '不新增重复行');
  const hit = book.projects.find((p) => p.number === '111454');
  assert.equal(hit.name, 'ERP 里的新名字', '名称刷新成 ERP 回读值');
  assert.equal(hit.confirmedAt, '2026-09-07T03:00:00.000Z', '时间刷新');
  assert.equal(hit.lastCheckedAt, '2026-09-07T03:00:00.000Z');
  assert.equal(hit.lastVerdict, 'confirmed', '刚核对过，重新算数');
  assert.equal(hit.expiresOn, '2026-12-31', '用户自己填的过期时间不该被一次重录抹掉');
  // 位置也不变：列表不该因为重录一条就重排。
  assert.deepEqual(book.projects.map((p) => p.number), ['111454', '111455']);
});

test('被拒的重录不动既有条目', async () => {
  freshHome();
  const before = writeBook({ projects: [
    { number: '111454', name: '原来就在簿子里', confirmedAt: '2026-01-01T00:00:00.000Z',
      expiresOn: null, lastCheckedAt: '2026-01-01T00:00:00.000Z', lastVerdict: 'confirmed' },
  ] });

  const r = await run('111454', forbidden('已被禁用了'));
  assert.equal(r.status, 'rejected');
  assert.deepEqual(readBook(), before, '一次被拒的录入不该改动簿子');
});

// ---- 每种结果都带着当前簿子回来 --------------------------------------------

test('无论录成没录成都带回当前簿子，页面据此就地刷新', async () => {
  freshHome();
  await run('111454', confirmed('某某项目'));
  for (const verify of [missing(), transportFail(), confirmed('另一个项目')]) {
    const r = await run('111455', verify);
    assert.ok(Array.isArray(r.book?.projects), `${r.status} 也要带回簿子`);
    assert.deepEqual(r.book, readBook());
  }
  const gated = await run('111456', counting(async () => ({})), { gate: loggedOut });
  assert.deepEqual(gated.book, readBook(), '没登录也要看得见现在有哪些项目');
});
