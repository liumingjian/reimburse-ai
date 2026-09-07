import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeProject, purgeInvalidProjects, recheckAll } from '../src/projectmaintain.mjs';
import { readBook, writeBook, selectableProjects } from '../src/projects.mjs';

// 每个用例自己一个数据根：整理动作要真的改簿子，改的必须是临时目录里那一份。
function freshHome() {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-maintain-'));
  return process.env.BAOX_HOME;
}

const p = (number, over = {}) => ({
  number,
  name: `项目 ${number}`,
  confirmedAt: '2026-09-01T02:00:00.000Z',
  expiresOn: null,
  lastCheckedAt: '2026-09-01T02:00:00.000Z',
  lastVerdict: 'confirmed',
  ...over,
});

const seed = (...projects) => { freshHome(); writeBook({ projects }); };
const numbers = (book) => book.projects.map((x) => x.number);

// ---- 假的 ERP 查询 --------------------------------------------------------
// 和录入闸门的用例同一条路子（projectintake.test.mjs）：注入 erpcatalog 那一层的
// **查询函数**，喂 2026-09-05 实测的报文形状——外层数组直接是行集，每行按 FieldKeys
// 顺序排的标量数组 [FNumber, FName, FDocumentStatus, FForbidStatus]。判定走的是真的
// 批量核对逻辑，不是一份自己编好的判定结果。
//
// 每个假查询都计次：AC 明说"复检对整簿只发一次查询"，那就只有调用次数证得了。

const counting = (impl) => {
  const fake = async (...args) => { fake.calls += 1; fake.args.push(args); return impl(...args); };
  fake.calls = 0;
  fake.args = [];
  return fake;
};

// 单据状态 C 是已审核，禁用状态 A 是未禁用；两者同时成立才允许被引用。
const erpRow = (number, name, doc = 'C', forbid = 'A') => [number, name, doc, forbid];
const rowsOf = (rows) => counting(async () => ({ ok: true, rows }));
const transportFail = (reason = 'ERP 查询返回了非 JSON 内容：<html>') =>
  counting(async () => ({ ok: false, reason }));

/** 身份已 matched 的会话。真机上它是一条 CDP 地址，这里只要它不是 null。 */
const loggedIn = async () => ({ ok: true, wsUrl: 'ws://fake', probe: { status: 'matched' } });
const loggedOut = async () => ({ ok: false, probe: { status: 'no_session' } });

const recheck = (query, opts = {}) => recheckAll({
  gate: loggedIn, run: query, now: () => '2026-09-07T03:00:00.000Z', today: '2026-09-07', ...opts,
});

/* ================================================================= 单行删除 */

test('删除一条：它从簿子里消失，别的一条不动', () => {
  seed(p('111454'), p('111455'), p('111456'));

  const r = removeProject('111455');

  assert.equal(r.status, 'removed');
  assert.equal(r.removed.number, '111455');
  assert.deepEqual(numbers(r.book), ['111454', '111456']);
});

test('删除是硬删，落盘后读得回来', () => {
  seed(p('111454'), p('111455'));

  removeProject('111454');

  // 重新读一遍盘：删除不是内存里的一个标记，它真的从文件里没了。
  assert.deepEqual(numbers(readBook()), ['111455']);
});

test('删一个不在簿子里的号：不是错误，簿子一条不动', () => {
  // 页面上两下点在同一行、或者两个页面开着同一本簿子，都会走到这里。
  // 用户要的结果（这个号不在簿子里）已经成立了，没有必要为此报一个错。
  seed(p('111454'));

  const r = removeProject('999999');

  assert.equal(r.status, 'not_found');
  assert.deepEqual(numbers(r.book), ['111454']);
  assert.deepEqual(numbers(readBook()), ['111454']);
});

test('删除只按项目号删，删的是哪一条不受失效判定影响', () => {
  // 失效项是最该被删掉的那些，删除这条路径不能只对"还能选"的项目管用。
  seed(p('111454'), p('111455', { expiresOn: '2020-01-01' }));

  const r = removeProject('111455');

  assert.equal(r.status, 'removed');
  assert.deepEqual(numbers(r.book), ['111454']);
});

/* ========================================================== 清理全部失效 */

test('清理全部失效：过期的和复检没过的都删掉，可选的一条不动', () => {
  seed(
    p('111454'),                                        // 可选
    p('111455', { expiresOn: '2026-01-01' }),           // 过期
    p('111456', { lastVerdict: 'unusable' }),           // 复检未通过
    p('111457', { expiresOn: '2099-12-31' }),           // 还没到期，可选
  );

  const r = purgeInvalidProjects('2026-09-07');

  assert.equal(r.status, 'purged');
  assert.equal(r.removedCount, 2);
  assert.deepEqual(r.removed.map((x) => x.number), ['111455', '111456']);
  assert.deepEqual(numbers(r.book), ['111454', '111457']);
  assert.deepEqual(numbers(readBook()), ['111454', '111457'], '落盘了，不是内存里删了一下');
});

test('没有失效项时清理是一次空操作，簿子一个字节都不用改', () => {
  seed(p('111454'), p('111455'));

  const r = purgeInvalidProjects('2026-09-07');

  assert.equal(r.status, 'none');
  assert.equal(r.removedCount, 0);
  assert.deepEqual(numbers(r.book), ['111454', '111455']);
});

test('清理看的是此刻的失效判定：跨过那一天之前，同一条还留着', () => {
  seed(p('111455', { expiresOn: '2026-06-30' }));

  assert.equal(purgeInvalidProjects('2026-06-30').status, 'none', '过期时间当天还没过期');
  assert.deepEqual(numbers(readBook()), ['111455']);

  assert.equal(purgeInvalidProjects('2026-07-01').removedCount, 1);
  assert.deepEqual(numbers(readBook()), []);
});

test('空簿上的清理不炸，也不写盘', () => {
  freshHome();

  const r = purgeInvalidProjects('2026-09-07');

  assert.equal(r.status, 'none');
  assert.deepEqual(numbers(r.book), []);
});

/* ================================================================= 复检全部 */

test('复检对整簿只发一次查询，簿子里有几条都一样', async () => {
  seed(p('111454'), p('111455'), p('111456'));
  const query = rowsOf([
    erpRow('111454', '项目一'), erpRow('111455', '项目二'), erpRow('111456', '项目三'),
  ]);

  const r = await recheck(query);

  assert.equal(r.status, 'done');
  assert.equal(query.calls, 1, '整簿一次批量查询，不是每条一次往返');
  // 三个号都在同一条过滤串里，这才是"一次覆盖全簿"。
  const filter = query.args[0][1].filter;
  for (const n of ['111454', '111455', '111456']) assert.ok(filter.includes(n), `${n} 要在这一次查询里`);
});

test('复检更新每条的最近判定与检查时间', async () => {
  seed(p('111454'), p('111455'));
  const query = rowsOf([erpRow('111454', '项目一'), erpRow('111455', '项目二', 'C', 'B')]);

  await recheck(query);

  const [a, b] = readBook().projects;
  assert.equal(a.lastVerdict, 'confirmed');
  assert.equal(a.lastCheckedAt, '2026-09-07T03:00:00.000Z');
  assert.equal(b.lastVerdict, 'unusable', '禁用状态不是 A，不能再引用');
  assert.equal(b.lastCheckedAt, '2026-09-07T03:00:00.000Z');
});

test('结果集里缺席的项目号被记为 missing', async () => {
  // 录进来之后在 ERP 那边被删掉的项目，就是这样现形的：批量查询里它根本不回来。
  seed(p('111454'), p('111455'));
  const query = rowsOf([erpRow('111454', '项目一')]);

  await recheck(query);

  const byNumber = Object.fromEntries(readBook().projects.map((x) => [x.number, x]));
  assert.equal(byNumber['111454'].lastVerdict, 'confirmed');
  assert.equal(byNumber['111455'].lastVerdict, 'missing');
});

test('一个号在 ERP 里对上多条：记 ambiguous，baox 不替用户挑', async () => {
  seed(p('111454'));
  const query = rowsOf([erpRow('111454', '重名一'), erpRow('111454', '重名二')]);

  await recheck(query);

  assert.equal(readBook().projects[0].lastVerdict, 'ambiguous');
});

test('还没审核的项目记 unusable', async () => {
  seed(p('111454'));

  await recheck(rowsOf([erpRow('111454', '还没审核的项目', 'A', 'A')]));

  assert.equal(readBook().projects[0].lastVerdict, 'unusable');
});

test('复检后变成失效的项目从可选集合消失，但仍在簿子里，没有被自动删除', async () => {
  seed(p('111454'), p('111455'));

  await recheck(rowsOf([erpRow('111454', '项目一')]));

  assert.deepEqual(numbers(readBook()), ['111454', '111455'], '标记归标记，删除归用户');
  assert.deepEqual(selectableProjects('2026-09-07').map((x) => x.number), ['111454']);
});

test('复检不修改任何条目的过期时间', async () => {
  seed(
    p('111454', { expiresOn: '2099-12-31' }),
    p('111455', { expiresOn: null }),
    p('111456', { expiresOn: '2020-01-01' }),
  );

  await recheck(rowsOf([
    erpRow('111454', '项目一'), erpRow('111455', '项目二'), erpRow('111456', '项目三'),
  ]));

  assert.deepEqual(readBook().projects.map((x) => x.expiresOn),
    ['2099-12-31', null, '2020-01-01'], '过期时间是用户填的，复检碰都不该碰');
});

test('复检不改写名称与加入时间：它只更新判定与检查时间', async () => {
  seed(p('111454', { name: '录入那天回读的名字' }));

  await recheck(rowsOf([erpRow('111454', 'ERP 后来改成的名字')]));

  const [only] = readBook().projects;
  assert.equal(only.name, '录入那天回读的名字');
  assert.equal(only.confirmedAt, '2026-09-01T02:00:00.000Z');
});

test('传输层失败时不把整簿误判为失效：一条都不动', async () => {
  // 失败就是没检成，不是检出问题。把"没问出答案"写成 missing，等于一次网络抖动
  // 就让用户整本簿子在选择器里消失。
  seed(p('111454'), p('111455'));
  const query = transportFail();

  const r = await recheck(query);

  assert.equal(r.status, 'query_failed');
  assert.match(r.note, /没检成|没能|不是/);
  assert.deepEqual(readBook().projects.map((x) => x.lastVerdict), ['confirmed', 'confirmed']);
  assert.deepEqual(readBook().projects.map((x) => x.lastCheckedAt),
    ['2026-09-01T02:00:00.000Z', '2026-09-01T02:00:00.000Z'], '没检成就不算检过');
  assert.deepEqual(selectableProjects('2026-09-07').map((x) => x.number), ['111454', '111455']);
});

test('没有已确认身份的 ERP 会话：不查、不写，指路去登录', async () => {
  seed(p('111454'));
  const query = rowsOf([]);

  const r = await recheck(query, { gate: loggedOut });

  assert.equal(r.status, 'not_logged_in');
  assert.equal(query.calls, 0);
  assert.deepEqual(readBook().projects.map((x) => x.lastVerdict), ['confirmed']);
  assert.match(r.note, /登录/);
});

test('空簿复检一次查询都不发，也不用先去登录', async () => {
  freshHome();
  const query = rowsOf([]);

  const r = await recheck(query, { gate: async () => { throw new Error('空簿不该问会话'); } });

  assert.equal(r.status, 'empty');
  assert.equal(query.calls, 0);
});

test('手改进来的不安全项目号不进查询串，而且当场落在失效那边', async () => {
  // 簿子被明说是可手改的文件。录入闸门挡得住不安全的号，手改挡不住——
  // 而过滤串是要拼进 ERP 查询的，这个号一个字符都不能进去。
  seed(p("111454' or '1'='1"), p('111455'));
  const query = rowsOf([erpRow('111455', '正常项目')]);

  const r = await recheck(query);

  assert.equal(query.calls, 1);
  assert.ok(!query.args[0][1].filter.includes("or '1'='1"), '不安全的号不许拼进查询串');
  const byNumber = Object.fromEntries(readBook().projects.map((x) => [x.number, x]));
  assert.equal(byNumber["111454' or '1'='1"].lastVerdict, 'unsafe');
  assert.equal(byNumber['111455'].lastVerdict, 'confirmed');
});

test('全是不安全项目号的簿子：一次查询都不发，也不报成查询失败', async () => {
  seed(p("111454'; drop"));
  const query = rowsOf([]);

  const r = await recheck(query, { gate: async () => { throw new Error('没有可查的号就不该问会话'); } });

  assert.equal(r.status, 'done');
  assert.equal(query.calls, 0);
  assert.equal(readBook().projects[0].lastVerdict, 'unsafe');
});

test('复检回执把这一趟的结果分门别类地说出来', async () => {
  seed(p('111454'), p('111455'), p('111456'));

  const r = await recheck(rowsOf([erpRow('111454', '项目一'), erpRow('111456', '项目三', 'C', 'B')]));

  assert.equal(r.queries, 1);
  assert.equal(r.checkedCount, 3);
  assert.equal(r.confirmedCount, 1);
  // 复检把两条打成失效，但一条都没删——回执里要说清这一点，用户才知道下一步该干什么。
  assert.equal(r.invalidCount, 2);
  assert.deepEqual(numbers(r.book), ['111454', '111455', '111456']);
  assert.match(r.note, /没有删除|一条都没删|不删/);
});
