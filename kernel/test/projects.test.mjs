import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-projects-'));
process.env.BAOX_HOME = home;

const { readBook, writeBook, bookPath, selectableProjects, annotateProjects } =
  await import('../src/projects.mjs');

const ALICE = { account: 'alice', tenant: 'tenant-a' };
const BOB = { account: 'bob', tenant: 'tenant-a' };

test('项目簿按 tenant/account 隔离，ownerless 全局文件不被认领', () => {
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({
    projects: [{ number: '39163', name: '旧全局项目' }],
  }));
  writeBook(ALICE, { projects: [{ number: 'a-1', name: 'Alice 项目', lastVerdict: 'confirmed' }] });

  assert.equal(readBook(ALICE).projects[0].name, 'Alice 项目');
  assert.equal(readBook({ account: ' alice ', tenant: 'tenant-a' }).projects[0].name, 'Alice 项目');
  assert.deepEqual(readBook(BOB), { projects: [] });
  assert.ok(bookPath(ALICE).startsWith(path.join(home, 'projects')));
  assert.notEqual(bookPath(ALICE), bookPath(BOB));
});

test('只有 confirmed 且未过期的本人的项目可用于新选择', () => {
  writeBook(ALICE, { projects: [
    { number: 'ok', name: '可选', lastVerdict: 'confirmed' },
    { number: 'expired', name: '已过期', expiresOn: '2020-01-01', lastVerdict: 'confirmed' },
    { number: 'bad', name: '复检失败', lastVerdict: 'missing' },
  ] });
  const candidates = selectableProjects(ALICE, '2026-09-09');
  assert.deepEqual(candidates.map((p) => p.number), ['ok']);
  const annotated = annotateProjects(readBook(ALICE).projects, '2026-09-09');
  assert.equal(annotated.find((p) => p.number === 'expired').selectable, false);
  assert.equal(annotated.find((p) => p.number === 'bad').statusLabel, '复检未通过');
});

test('缺少复检结论的项目默认未确认且不可进入 allowlist', () => {
  writeBook(ALICE, { projects: [{ number: 'legacy', name: '未核验项目' }] });

  const project = readBook(ALICE).projects[0];
  assert.equal(project.lastVerdict, 'unconfirmed');
  assert.deepEqual(selectableProjects(ALICE, '2026-09-09'), []);
  assert.equal(annotateProjects([project], '2026-09-09')[0].statusLabel, '复检未通过');
});

test('不安全项目号即使标成 confirmed 也不能进入候选', () => {
  writeBook(ALICE, { projects: [{ number: "bad'number", name: '不安全', lastVerdict: 'confirmed' }] });
  assert.deepEqual(selectableProjects(ALICE, '2026-09-09'), []);
  const annotated = annotateProjects(readBook(ALICE).projects, '2026-09-09')[0];
  assert.equal(annotated.selectable, false);
  assert.match(annotated.statusLabel, /项目号不安全/);
});

test('坏项目簿不会被后续写入静默覆盖', () => {
  const file = bookPath(ALICE);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(readBook(ALICE), { projects: [] });
  assert.throws(() => writeBook(ALICE, { projects: [] }), /无法读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');

  fs.writeFileSync(file, JSON.stringify({ owner: { account: 'bob', tenant: 'tenant-a' }, projects: [] }));
  assert.throws(() => writeBook(ALICE, { projects: [] }), /身份不匹配/);
});
