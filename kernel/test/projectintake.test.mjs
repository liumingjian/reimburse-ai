import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intakeProject, MAX_RETRIES } from '../src/projectintake.mjs';
import { readBook, writeBook } from '../src/projects.mjs';

// 每个用例自己一个数据根：录入闸门要真的写簿子，写的必须是临时目录里那一份。
function freshHome() {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-intake-'));
  return process.env.BAOX_HOME;
}

// ---- 假的 ERP 查询 --------------------------------------------------------
// 按既有做法（erpcatalog.test.mjs）注入 erpcatalog 那一层的**查询函数**，喂的是
// 2026-09-05 实测的报文形状：外层数组直接就是行集，每行按 FieldKeys 顺序排的标量数组
// [FNumber, FName, FDocumentStatus, FForbidStatus]。判定逻辑走的是真的 verifyProject，
// 不是一份自己编的判定结果——那样的话行到判定这一段就没人试过。
//
// 每个假查询都计次："明确判定一次都不重试"和"传输层失败重试满 MAX_RETRIES 次"
// 这两条只有靠调用次数才证得了。全程不联网、不碰真实 ERP。

const counting = (impl) => {
  const fake = async (...args) => { fake.calls += 1; return impl(...args); };
  fake.calls = 0;
  return fake;
};

// 单据状态 C 是已审核，禁用状态 A 是未禁用；只有两者同时成立才允许被引用。
const erpRow = (number, name, doc = 'C', forbid = 'A') => [number, name, doc, forbid];
const rowsOf = (rows) => counting(async () => ({ ok: true, rows }));

const confirmed = (name) => rowsOf([erpRow('111454', name)]);
const missing = () => rowsOf([]);
const ambiguous = (count = 2) =>
  rowsOf(Array.from({ length: count }, (_, i) => erpRow('111454', `重名项目 ${i + 1}`)));
const forbidden = (name) => rowsOf([erpRow('111454', name, 'C', 'B')]);
const unaudited = (name) => rowsOf([erpRow('111454', name, 'A', 'A')]);
const transportFail = (reason = 'ERP 查询返回了非 JSON 内容：<html>') =>
  counting(async () => ({ ok: false, reason }));

/** 身份已 matched 的会话。真机上它是一条 CDP 地址，这里只要它不是 null。 */
const loggedIn = async () => ({ ok: true, wsUrl: 'ws://fake', probe: { status: 'matched', identity: { account: 'lmj' } } });
const loggedOut = async () => ({ ok: false, probe: { status: 'no_session' } });

const run = (number, query, opts = {}) =>
  intakeProject(number, opts.expiresOn ?? null,
    { gate: loggedIn, run: query, now: () => '2026-09-07T03:00:00.000Z', ...opts });

// ---- confirmed：进簿，名称取 ERP 回读值 ------------------------------------

test('ERP 确认的项目当场进簿，名称是 ERP 回读值', async () => {
  freshHome();
  const query = confirmed('安图特某某研发项目');
  const r = await run('111454', query);

  assert.equal(r.status, 'admitted');
  assert.equal(query.calls, 1);
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
  const query = missing();
  const r = await run('999999', query);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'missing');
  assert.match(r.note, /真实存在的项目号/);
  assert.equal(query.calls, 1, '明确判定一次都不重试');
  assert.deepEqual(readBook().projects, [], '被拒的项目号一个字节都不落盘');
});

test('一号对多条被拒，话术说明 baox 不替用户挑', async () => {
  freshHome();
  const query = ambiguous(3);
  const r = await run('111454', query);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'ambiguous');
  assert.match(r.note, /不替你挑/);
  assert.match(r.note, /3 条/);
  assert.equal(query.calls, 1);
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
  for (const [label, query] of [['missing', missing()], ['ambiguous', ambiguous()],
    ['forbidden', forbidden('x')], ['unaudited', unaudited('x')]]) {
    freshHome();
    await run('111454', query);
    assert.equal(query.calls, 1, `${label} 不该重试`);
  }
});

// ---- 传输层失败：头一次之外再重试 MAX_RETRIES 次 ---------------------------

test('传输层失败要头一次加上 MAX_RETRIES 次重试才算失败', async () => {
  freshHome();
  const query = transportFail('ERP 查询返回了非 JSON 内容：<html>');
  const r = await run('111454', query);

  assert.equal(r.status, 'query_failed');
  assert.equal(MAX_RETRIES, 3, 'AC 定的是重试 3 次');
  assert.equal(query.calls, MAX_RETRIES + 1, '头一次问完之后还要再重试 3 次');
  assert.equal(r.queries, query.calls, '答里报的次数要和真发出去的次数对得上');
  assert.match(r.note, /稍后再试/);
  assert.match(r.note, /非 JSON/, '最后一次失败的原因要带出来，不然没法排障');
  assert.deepEqual(readBook().projects, [], '没问出答案就不写盘');
});

test('中途恢复的查询照样算数，不白白跑满次数', async () => {
  freshHome();
  let n = 0;
  const query = counting(async () => (++n < 3
    ? { ok: false, reason: '查询超时' }
    : { ok: true, rows: [erpRow('111454', '某某项目')] }));

  const r = await run('111454', query);
  assert.equal(r.status, 'admitted');
  assert.equal(query.calls, 3, '第三次就问出答案了，不该再问第四次');
  assert.equal(readBook().projects[0].name, '某某项目');
});

// ---- 没有会话：既不失败也不重试 --------------------------------------------

test('没有 matched 会话时不写盘、不重试，答的是"请先登录"', async () => {
  freshHome();
  const query = counting(async () => assert.fail('没登录就不该发出任何查询'));
  const r = await run('111454', query, { gate: loggedOut });

  assert.equal(r.status, 'not_logged_in');
  assert.notEqual(r.status, 'query_failed', '没登录不是录入失败');
  assert.equal(query.calls, 0);
  assert.match(r.note, /登录/);
  assert.deepEqual(readBook().projects, []);
});

// ---- 安全键：在任何查询发生之前就拒 ----------------------------------------

test('不安全的项目号在任何查询发生之前就被拒', async () => {
  freshHome();
  const query = confirmed('不该走到这里');
  const r = await run("111454' or '1'='1", query);

  assert.equal(r.status, 'rejected');
  assert.equal(r.verdict, 'unsafe');
  assert.equal(query.calls, 0, '假查询一次都不该被调用');
  assert.match(r.note, /不能安全查询的字符/, '沿用既有的拒绝语');
  assert.deepEqual(readBook().projects, []);
});

test('空项目号也是当场拒，不去问 ERP，而且话说得像人话', async () => {
  freshHome();
  const query = confirmed('不该走到这里');
  for (const bad of ['', '   ', null, undefined]) {
    const r = await run(bad, query);
    assert.equal(r.status, 'rejected', `${JSON.stringify(bad)} 该被拒`);
    assert.equal(r.verdict, 'unsafe');
    // 空框是"还没填"，不是"这个号有问题"。套上"含有不能安全查询的字符"就成了
    // 一句看不懂的话（项目号 "" 含有……），用户读完不知道该干什么。
    assert.match(r.note, /还没填项目号/, `${JSON.stringify(bad)} 的话术要说的是没填`);
    assert.doesNotMatch(r.note, /不能安全查询/);
  }
  assert.equal(query.calls, 0);
});

test('安全键先于会话判定：不安全的号连登录都不用问', async () => {
  freshHome();
  const query = confirmed('不该走到这里');
  const r = await run('bad number!', query, { gate: loggedOut });
  assert.equal(r.verdict, 'unsafe', '拼不进查询串的号，登不登录都一样是拒');
  assert.equal(query.calls, 0);
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

  const r = await run('111454', confirmed('ERP 里的新名字'), { expiresOn: '2027-06-30' });
  const book = readBook();

  assert.equal(r.status, 'admitted');
  assert.equal(book.projects.length, 2, '不新增重复行');
  const hit = book.projects.find((p) => p.number === '111454');
  assert.equal(hit.name, 'ERP 里的新名字', '名称刷新成 ERP 回读值');
  assert.equal(hit.confirmedAt, '2026-09-07T03:00:00.000Z', '时间刷新');
  assert.equal(hit.lastCheckedAt, '2026-09-07T03:00:00.000Z');
  assert.equal(hit.lastVerdict, 'confirmed', '刚核对过，重新算数');
  // 重录就是又填了一遍表，过期时间那一格也在表上：本次提交的值覆盖旧值（#79）。
  assert.equal(hit.expiresOn, '2027-06-30', '本次提交的过期时间覆盖旧值');
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
  for (const query of [missing(), transportFail(), confirmed('另一个项目')]) {
    const r = await run('111455', query);
    assert.ok(Array.isArray(r.book?.projects), `${r.status} 也要带回簿子`);
    assert.deepEqual(r.book, readBook());
  }
  const gated = await run('111456', counting(async () => ({})), { gate: loggedOut });
  assert.deepEqual(gated.book, readBook(), '没登录也要看得见现在有哪些项目');
});

// ---- 过期时间：录入时可填，也可留空 ----------------------------------------

test('录入时填的过期时间原样落进簿子', async () => {
  freshHome();
  const r = await run('111454', confirmed('某某项目'), { expiresOn: '2026-12-31' });
  assert.equal(r.status, 'admitted');
  assert.equal(r.entry.expiresOn, '2026-12-31');
  assert.equal(readBook().projects[0].expiresOn, '2026-12-31');
});

test('留空即永不过期，空白和没填一个样', async () => {
  // 不少项目根本没有明确结题日期。强制填只会逼人瞎填一个 2099，那这个字段就废了。
  for (const blank of [null, undefined, '', '   ']) {
    freshHome();
    const r = await run('111454', confirmed('某某项目'), { expiresOn: blank });
    assert.equal(r.status, 'admitted', `${JSON.stringify(blank)} 该被当成留空`);
    assert.equal(r.entry.expiresOn, null);
    assert.match(r.note, /永不过期/);
  }
});

test('填了过期时间就在录入回执里说一声，用户当场看得见自己填了什么', async () => {
  freshHome();
  const r = await run('111454', confirmed('某某项目'), { expiresOn: '2026-12-31' });
  assert.match(r.note, /2026-12-31/);
});

test('填了一个已经过去的日子照样收，但当场说清它已经不可选', async () => {
  // 不拦：用户有权把一个已结题的项目留在簿子里。但要是不吭声，他会以为
  // 加进去了就能选，回到选择器发现没有——那才是真的坑。
  freshHome();
  const r = await run('111454', confirmed('某某项目'),
    { expiresOn: '2020-01-01', today: '2026-09-07' });
  assert.equal(r.status, 'admitted');
  assert.equal(readBook().projects[0].expiresOn, '2020-01-01');
  assert.match(r.note, /已过期|不会出现在可选/);
});

test('不成日子的过期时间当场拒，而且在任何查询发生之前', async () => {
  freshHome();
  const query = confirmed('不该走到这里');
  for (const bad of ['2026-13-01', '2026-02-30', '2026/12/31', '下个月', '2026-12-31T00:00:00Z']) {
    const r = await run('111454', query, { expiresOn: bad });
    assert.equal(r.status, 'rejected', `${bad} 该被拒`);
    assert.equal(r.verdict, 'bad_expires_on');
    assert.match(r.note, /年-月-日|YYYY-MM-DD/);
  }
  assert.equal(query.calls, 0, '一个读不出来的日期不值得去问一次 ERP');
  assert.deepEqual(readBook().projects, [], '被拒的录入一个字节都不落盘');
});

test('过期时间读不出来时不去问会话，也不重试', async () => {
  freshHome();
  const query = confirmed('不该走到这里');
  const r = await run('111454', query, { expiresOn: '乱填的', gate: loggedOut });
  assert.equal(r.verdict, 'bad_expires_on', '日期填坏了，登不登录都一样是拒');
  assert.equal(query.calls, 0);
});

test('录入闸门只收项目号和过期时间，别的字段递进来也写不进簿子', async () => {
  freshHome();
  // 页面那一侧递什么都不该能改写簿子：名称永远是 ERP 回读值。
  const r = await intakeProject('111454', null, {
    gate: loggedIn, run: confirmed('ERP 回读的真名'), now: () => '2026-09-07T03:00:00.000Z',
    name: '我自己编的名字', lastVerdict: 'confirmed',
  });
  assert.equal(r.entry.name, 'ERP 回读的真名');
});

test('把依赖注入口误当成过期时间传进来，当场炸，不静悄悄地跑', async () => {
  // intakeProject(number, opts) 这个旧写法一旦残留，opts 会被当成过期时间，
  // 而 gate / run 全都落空——那是一次会去碰真 ERP 的调用。宁可响。
  freshHome();
  await assert.rejects(() => intakeProject('111454', { gate: loggedIn }),
    /过期时间/, '第二个参数是过期时间，不是依赖注入口');
});
