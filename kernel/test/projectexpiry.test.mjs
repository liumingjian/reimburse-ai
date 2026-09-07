import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  localToday, isValidDay, invalidReasons, isSelectable, selectableProjects,
  annotateProjects, noCandidatesNote, readBook, writeBook, EXPIRED, UNCONFIRMED,
} from '../src/projects.mjs';

// 每个用例自己一个数据根：可选集合是现读簿子算出来的，读的必须是临时目录里那一份。
function freshHome() {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-expiry-'));
  return process.env.BAOX_HOME;
}

const p = (over = {}) => ({
  number: '111454',
  name: '某某研发项目',
  confirmedAt: '2026-09-07T02:00:00.000Z',
  expiresOn: null,
  lastCheckedAt: '2026-09-07T02:00:00.000Z',
  lastVerdict: 'confirmed',
  ...over,
});

// ---- 日期粒度与本地日期 ----------------------------------------------------

test('今天是本地日期，不是 UTC 日期', () => {
  // 本地时间构造的 23:30，在 UTC 那边可能已经是第二天了。按本地日期比较意味着
  // 用户填 12-31 就该在他自己的 12-31 一整天里都还能选中。
  assert.equal(localToday(new Date(2026, 5, 30, 23, 30)), '2026-06-30');
  assert.equal(localToday(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});

test('过期时间只认 YYYY-MM-DD，而且要是真实存在的一天', () => {
  assert.equal(isValidDay('2026-12-31'), true);
  assert.equal(isValidDay('2026-02-29'), false, '2026 不是闰年，2-29 不存在');
  assert.equal(isValidDay('2024-02-29'), true);
  for (const bad of ['2026-13-01', '2026-00-10', '2026-12-32', '26-12-31', '2026/12/31',
    '2026-12-31T00:00:00Z', '', ' ', 'banana', null, undefined, 20261231]) {
    assert.equal(isValidDay(bad), false, `不该收下 ${String(bad)}`);
  }
});

// ---- 失效来源一：过期时间已过 ----------------------------------------------

test('留空即永不过期', () => {
  assert.deepEqual(invalidReasons(p({ expiresOn: null }), '2099-12-31'), []);
});

test('过期时间当天还能选，过了那天才失效', () => {
  const today = '2026-06-30';
  assert.deepEqual(invalidReasons(p({ expiresOn: '2026-06-30' }), today), [],
    '填的是结题日，那一整天都还该能选');
  assert.deepEqual(invalidReasons(p({ expiresOn: '2026-07-01' }), today), []);
  assert.deepEqual(invalidReasons(p({ expiresOn: '2026-06-29' }), today), [EXPIRED]);
});

test('读不出来的过期时间当作已过期，不当作永不过期', () => {
  // 簿子是人眼可读、可手改的文件，就会有改坏的那一天。读不懂一个日期时
  // 「当它永不过期」等于让一个来路不明的项目继续可选——宁可它落在失效那边，
  // 用户在维护页上看得见、能改能删。
  assert.deepEqual(invalidReasons(p({ expiresOn: 'banana' }), '2026-06-30'), [EXPIRED]);
  assert.deepEqual(invalidReasons(p({ expiresOn: '2026-02-30' }), '2026-06-30'), [EXPIRED]);
});

// ---- 失效来源二：最近一次判定不是 confirmed --------------------------------

test('最近一次判定不是 confirmed 就失效', () => {
  const today = '2026-06-30';
  for (const v of ['unusable', 'missing', 'ambiguous', 'banana']) {
    assert.deepEqual(invalidReasons(p({ lastVerdict: v }), today), [UNCONFIRMED], v);
  }
  assert.deepEqual(invalidReasons(p({ lastVerdict: 'confirmed' }), today), []);
});

// ---- 两个来源取并集 --------------------------------------------------------

test('两个来源取并集：命中任意一条即失效，都命中就都记下来', () => {
  const today = '2026-06-30';
  assert.deepEqual(
    invalidReasons(p({ expiresOn: '2026-01-01', lastVerdict: 'unusable' }), today),
    [EXPIRED, UNCONFIRMED],
    '维护页要说清是哪一类问题，两条都命中就两条都说');
  assert.equal(isSelectable(p({ expiresOn: '2026-01-01' }), today), false);
  assert.equal(isSelectable(p({ lastVerdict: 'unusable' }), today), false);
  assert.equal(isSelectable(p(), today), true);
});

test('拿不出一个能比的今天就现算一个，不把整簿当成没过期', () => {
  // `.filter(isSelectable)` 会把数组下标当第二个参数递进来。真发生的时候，
  // 「拿 0 去比日期」的结果是所有过期项目又都可选了——正好把这一票废掉。
  assert.equal(isSelectable(p({ expiresOn: '2000-01-01' }), 0), false);
  assert.equal(isSelectable(p({ expiresOn: '2000-01-01' })), false);
  assert.equal(isSelectable(p({ expiresOn: '2099-01-01' })), true);
});

// ---- 可选集合：现读现算 ----------------------------------------------------

test('可选集合把两类失效项都排除在外，簿子本身一条不少', () => {
  freshHome();
  writeBook({ projects: [
    p({ number: '111454' }),
    p({ number: '111455', expiresOn: '2026-01-01' }),
    p({ number: '111456', lastVerdict: 'unusable' }),
    p({ number: '111457', expiresOn: '2099-01-01' }),
  ] });

  assert.deepEqual(selectableProjects('2026-06-30').map((x) => x.number), ['111454', '111457']);
  assert.equal(fs.readFileSync(path.join(process.env.BAOX_HOME, 'projects.json'), 'utf8')
    .match(/111456/g).length, 1, '失效不触发任何自动删除：条目还在盘上');
});

test('可选集合每次都现读现算，不做快照', () => {
  freshHome();
  writeBook({ projects: [p({ number: '111454', expiresOn: '2026-06-30' })] });
  assert.equal(selectableProjects('2026-06-30').length, 1);
  // 同一份簿子，只是日子过去了——不重启、不刷新，下一次问就已经不可选。
  assert.equal(selectableProjects('2026-07-01').length, 0);

  // 中途在维护页加的项目，下一次问就要能选到。
  writeBook({ projects: [p({ number: '111454', expiresOn: '2026-06-30' }), p({ number: '111458' })] });
  assert.deepEqual(selectableProjects('2026-07-01').map((x) => x.number), ['111458']);
});

// ---- 维护页要用的那份标注 --------------------------------------------------

test('标注给出可选与否和失效原因，措辞由内核给，页面不自己编', () => {
  const today = '2026-06-30';
  const [ok, expired, unusable, both] = annotateProjects([
    p({ number: '1', expiresOn: '2099-01-01' }),
    p({ number: '2', expiresOn: '2026-01-01' }),
    p({ number: '3', lastVerdict: 'unusable' }),
    p({ number: '4', expiresOn: '2026-01-01', lastVerdict: 'missing' }),
  ], today);

  assert.equal(ok.selectable, true);
  assert.deepEqual(ok.invalidReasons, []);
  assert.equal(ok.statusLabel, '可选');
  assert.equal(ok.statusNote, null, '可选的那条不需要一句说明');

  assert.equal(expired.selectable, false);
  assert.deepEqual(expired.invalidReasons, [EXPIRED]);
  assert.match(expired.statusNote, /已过期/);
  assert.equal(expired.statusLabel, '已过期');
  assert.match(expired.statusNote, /2026-01-01/, '说清过期在哪一天，用户才知道要不要改');

  assert.equal(unusable.selectable, false);
  assert.deepEqual(unusable.invalidReasons, [UNCONFIRMED]);
  assert.match(unusable.statusNote, /禁用|未审核/);

  assert.equal(unusable.statusLabel, '复检未通过');
  assert.deepEqual(both.invalidReasons, [EXPIRED, UNCONFIRMED]);
  assert.equal(both.statusLabel, '已过期・复检未通过', '两条都命中就两条都摆出来');
  assert.match(both.statusNote, /已过期/);
  assert.match(both.statusNote, /查不到/);

  // 标注是加出来的，原有字段一个不动——它下面还接着落盘和 ERP 核对。
  assert.equal(expired.number, '2');
  assert.equal(expired.expiresOn, '2026-01-01');
});

// ---- 手改坏的过期时间不许变成"永不过期" ------------------------------------

test('手改成不是字符串的过期时间照样落在失效那边，不被规整成永不过期', () => {
  // 读簿子时把一个读不懂的值收敛成 null，等于把"读不懂这个日期"翻译成"永不过期"——
  // 一个来路不明的项目就这么重新可选了，正好是这条规则想挡的那一头。
  freshHome();
  const base = {
    number: 'X', name: '手改过的项目', confirmedAt: '2026-09-07T02:00:00.000Z',
    lastCheckedAt: '2026-09-07T02:00:00.000Z', lastVerdict: 'confirmed',
  };
  const home = process.env.BAOX_HOME;
  for (const [i, bad] of [20261231, true, {}, ['2026-12-31']].entries()) {
    fs.writeFileSync(path.join(home, 'projects.json'),
      JSON.stringify({ projects: [{ ...base, number: `X${i}`, expiresOn: bad }] }));
    const [p] = readBook().projects;
    assert.notEqual(p.expiresOn, null, `${JSON.stringify(bad)} 不该被读成"没填"`);
    assert.deepEqual(invalidReasons(p, '2026-06-30'), [EXPIRED],
      `${JSON.stringify(bad)} 读不出来就该算已过期`);
    assert.equal(selectableProjects('2026-06-30').length, 0);
  }
});

test('两头带空白的过期时间是个能读懂的日子，不因为一个空格就算过期', () => {
  freshHome();
  fs.writeFileSync(path.join(process.env.BAOX_HOME, 'projects.json'), JSON.stringify({
    projects: [{ number: 'X', name: '手改过的项目', confirmedAt: '2026-09-07T02:00:00.000Z',
      expiresOn: '  2026-12-31  ', lastCheckedAt: '2026-09-07T02:00:00.000Z',
      lastVerdict: 'confirmed' }],
  }));
  assert.equal(readBook().projects[0].expiresOn, '2026-12-31');
  assert.equal(selectableProjects('2026-06-30').length, 1);
});

test('空白串和没这个键一样都是留空＝永不过期', () => {
  freshHome();
  fs.writeFileSync(path.join(process.env.BAOX_HOME, 'projects.json'), JSON.stringify({
    projects: [
      { number: 'A', name: 'a', confirmedAt: 'x', expiresOn: '   ', lastCheckedAt: 'x', lastVerdict: 'confirmed' },
      { number: 'B', name: 'b', confirmedAt: 'x', lastCheckedAt: 'x', lastVerdict: 'confirmed' },
    ],
  }));
  assert.deepEqual(readBook().projects.map((p) => p.expiresOn), [null, null]);
  assert.equal(selectableProjects('2099-12-31').length, 2);
});

// ---- 没有候选：两种成因，两种下一步 ----------------------------------------

test('簿子真的一条都没有，那句话说的是去录入', () => {
  const note = noCandidatesNote([]);
  assert.match(note, /录入/);
  assert.doesNotMatch(note, /过期/, '一条都没有的时候扯过期时间只会让人摸不着头脑');
});

test('簿子非空、只是全失效了，那句话不许说"簿子是空的"，要指向改过期时间', () => {
  // 对着满满一页项目被告知"项目簿是空的，去录入吧"，用户只会以为 baox 把他的项目弄丢了。
  const note = noCandidatesNote([
    p({ number: '1', expiresOn: '2026-01-01' }),
    p({ number: '2', lastVerdict: 'unusable' }),
  ], '2026-06-30');
  assert.doesNotMatch(note, /簿子是空的|项目簿是空的/);
  assert.match(note, /2 条/, '有几条要说出来，用户才对得上他看见的那一页');
  assert.match(note, /已过期/);
  assert.match(note, /复检未通过/);
  assert.match(note, /把过期时间改掉/, '下一步是改过期时间，不是再录一遍');
  assert.match(note, /一条都没被删掉/, '要先按住"我的项目是不是被删了"这个念头');
});

test('拿不到整本簿子时给一句两种成因都成立的话', () => {
  // submitSelection 只拿到注入的可选集合，故意不去读盘。
  const note = noCandidatesNote();
  assert.match(note, /录入/);
  assert.match(note, /已过期|过期时间/);
});
