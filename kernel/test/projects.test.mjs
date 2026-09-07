import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { readBook, writeBook, bookPath } from '../src/projects.mjs';

const KERNEL = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

// 每个用例自己一个数据根：簿子是个人绑定的一种，落在数据根下，
// 用既有的 BAOX_HOME 指向临时目录就能整本换掉，不碰真机上的那份。
function freshHome() {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-'));
  return process.env.BAOX_HOME;
}
const bookFile = (home) => path.join(home, 'projects.json');

// 形状取自本票定死的记录形状。
const entry = {
  number: '111454',
  name: '某某研发项目',
  confirmedAt: '2026-09-07T02:00:00.000Z',
  expiresOn: '2026-12-31',
  lastCheckedAt: '2026-09-07T02:00:00.000Z',
  lastVerdict: 'confirmed',
};

test('手工放进数据根的一份合法簿子，原样读得回来', () => {
  const home = freshHome();
  fs.writeFileSync(bookFile(home), JSON.stringify({
    projects: [entry, { ...entry, number: '111455', expiresOn: null }],
  }));

  const book = readBook();
  assert.equal(book.projects.length, 2);
  assert.deepEqual(book.projects[0], entry);
  assert.equal(book.projects[1].expiresOn, null, 'expiresOn 可为 null＝永不过期');
});

test('没有文件就是空簿，不抛错，也不在磁盘上留下东西', () => {
  const home = freshHome();
  assert.deepEqual(readBook(), { projects: [] });
  assert.equal(fs.existsSync(bookFile(home)), false, '读不该有副作用');
});

test('坏文件读成空簿，不抛错', () => {
  const home = freshHome();
  for (const bad of ['{ 这不是 JSON', '[]', '"字符串"', 'null', '{"projects": {"111454": {}}}', '']) {
    fs.writeFileSync(bookFile(home), bad);
    assert.deepEqual(readBook(), { projects: [] }, `坏成这样也要读成空簿：${bad}`);
  }
});

test('条目缺项目号就当它不存在，其余条目照读', () => {
  // 一条没有项目号的记录既选不了也显示不了，留着它只会让下游到处判空。
  const home = freshHome();
  fs.writeFileSync(bookFile(home), JSON.stringify({
    projects: [{ name: '没有项目号' }, entry, 'not-an-object', { number: '   ' }],
  }));
  const book = readBook();
  assert.equal(book.projects.length, 1);
  assert.equal(book.projects[0].number, '111454');
});

test('缺省字段补齐成 null，lastVerdict 缺省算 confirmed', () => {
  // 没有"未核验"状态：每条在写入那一刻都是 confirmed。
  const home = freshHome();
  fs.writeFileSync(bookFile(home), JSON.stringify({ projects: [{ number: '111454' }] }));
  assert.deepEqual(readBook().projects[0], {
    number: '111454', name: null, confirmedAt: null,
    expiresOn: null, lastCheckedAt: null, lastVerdict: 'confirmed',
  });
});

test('认不出来的 lastVerdict 原样留着，不往 confirmed 上靠', () => {
  // 失效判定是「lastVerdict !== 'confirmed'」，所以一个手改坏的值天然落在失效那边。
  // 规整成 confirmed 会让一个来路不明的项目重新可选——那是把坏数据洗成好数据。
  const home = freshHome();
  fs.writeFileSync(bookFile(home), JSON.stringify({
    projects: [{ number: '111454', lastVerdict: 'banana' }],
  }));
  assert.equal(readBook().projects[0].lastVerdict, 'banana');
});

test('写入是原子的，且写完读得回来', () => {
  const home = freshHome();
  const written = writeBook({ projects: [entry] });
  assert.deepEqual(readBook(), written);
  assert.deepEqual(written.projects[0], entry);

  // 临时文件不留在原地：rename 之后目录里只该有簿子本身。
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('projects.json')), ['projects.json']);
});

test('写入不会把半份文件留给读者', () => {
  // 原子写的判据：目标路径上要么是上一版，要么是这一版，没有中间态。
  // 拿一个写不进去的目录来模拟中途失败——目标文件必须一个字节都没动。
  const home = freshHome();
  writeBook({ projects: [entry] });
  const before = fs.readFileSync(bookFile(home), 'utf8');

  fs.chmodSync(home, 0o500);            // 目录只读：新的临时文件建不出来
  try {
    assert.throws(() => writeBook({ projects: [{ ...entry, number: '999999' }] }));
  } finally {
    fs.chmodSync(home, 0o700);
  }
  assert.equal(fs.readFileSync(bookFile(home), 'utf8'), before, '失败的写不能改动既有簿子');
  assert.equal(readBook().projects[0].number, '111454');
});

test('文件 0600、目录 0700，与身份绑定同规格', () => {
  const home = freshHome();
  fs.rmSync(home, { recursive: true, force: true });   // 目录也由写入自己建
  writeBook({ projects: [entry] });
  assert.equal(fs.statSync(bookFile(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});

test('簿子就在数据根下，和 identity.json 平级', () => {
  const home = freshHome();
  assert.equal(bookPath(), path.join(home, 'projects.json'));
});

test('存储里不出现 ERP 会话、凭据或项目目录全量缓存', () => {
  // 簿子是用户自己誊录的那几条，不是 ERP 项目目录的镜像。
  const home = freshHome();
  writeBook({ projects: [entry], cookies: [{ name: 'ASP.NET_SessionId' }], catalog: [1, 2, 3] });
  const raw = JSON.parse(fs.readFileSync(bookFile(home), 'utf8'));
  assert.deepEqual(Object.keys(raw), ['projects']);
});

// ---- 只读命令 -------------------------------------------------------------
// 这一段跑真命令：AC 说的是"只读命令能如实输出全部条目"，
// 而"如实"和"不联网"都只有在进程边界上才证得了。

const runProjects = (home) => {
  const r = spawnSync(process.execPath, [path.join(KERNEL, 'bin', 'baox.mjs'), 'projects'],
    { env: { ...process.env, BAOX_HOME: home }, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout) };
};

test('projects 如实输出簿子里的全部条目，簿子上的字段一个不改', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-cli-'));
  const rows = [{ ...entry, expiresOn: '2099-12-31' },
    { ...entry, number: '111455', name: '另一个项目', expiresOn: null }];
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: rows }));

  const { code, json } = runProjects(home);
  assert.equal(code, 0);
  assert.equal(json.command, 'projects');
  assert.equal(json.projectCount, 2);
  // 输出在簿子那几个字段之上**加**了此刻的失效判定（selectable / statusLabel /
  // statusNote / invalidReasons），但一个原有字段都没动过——底下还接着落盘和 ERP 核对。
  const stored = json.projects.map((p) => ({
    number: p.number, name: p.name, confirmedAt: p.confirmedAt,
    expiresOn: p.expiresOn, lastCheckedAt: p.lastCheckedAt, lastVerdict: p.lastVerdict,
  }));
  assert.deepEqual(stored, rows, '一条不少、一个字段不改');
  assert.deepEqual(json.projects.map((p) => p.selectable), [true, true]);
  assert.equal(json.selectableCount, 2);
  assert.equal(json.bookPath, path.join(home, 'projects.json'));
});

test('projects 把失效的条目照样列出来，并说清它为什么不可选', () => {
  // 「我现在有哪些项目」的答案里，一条过期的项目不该凭空消失——它还在簿子里，
  // 只是选不中了。消失会让用户以为 baox 替他删了东西。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-cli-'));
  const rows = [
    { ...entry, number: '111454', expiresOn: '2099-12-31' },
    { ...entry, number: '111455', name: '过期的项目', expiresOn: '2020-01-01' },
    { ...entry, number: '111456', name: '复检没过的项目', expiresOn: null, lastVerdict: 'unusable' },
  ];
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: rows }));

  const { code, json } = runProjects(home);
  assert.equal(code, 0);
  assert.equal(json.projectCount, 3, '失效不触发任何自动删除');
  assert.deepEqual(json.projects.map((p) => p.selectable), [true, false, false]);
  assert.deepEqual(json.selectableNumbers, ['111454'], '可选集合是两个失效来源的并集之外那些');
  assert.equal(json.selectableCount, 1);
  assert.equal(json.projects[1].statusLabel, '已过期');
  assert.match(json.projects[1].statusNote, /2020-01-01/);
  assert.equal(json.projects[2].statusLabel, '复检未通过');
  assert.match(json.projects[2].statusNote, /禁用|未审核/);
  // 盘上那份一个字节没动：这条命令是只读的。
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects, rows);
});

test('簿子不存在时 projects 是成功的空答案，不是错误', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-cli-'));
  const { code, json } = runProjects(home);
  assert.equal(code, 0, '没有项目不是故障');
  assert.equal(json.projectCount, 0);
  assert.deepEqual(json.projects, []);
  assert.equal(json.selectableCount, 0);
  assert.ok(json.note.includes('空'), '空簿要给一句指引，不是一个空列表了事');
});

test('projects 不碰 ERP：不开浏览器、不在数据根里留下运行痕迹', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-cli-'));
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: [entry] }));
  assert.equal(runProjects(home).code, 0);
  // 任何一次 ERP 交互都要落 chrome-profile / run / logs，一个都不该出现。
  assert.deepEqual(fs.readdirSync(home).sort(), ['projects.json']);
});
