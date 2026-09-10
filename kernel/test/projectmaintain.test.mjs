import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-project-maintain-'));
process.env.BAOX_HOME = home;

const { writeBook, readBook } = await import('../src/projects.mjs');
const { removeProject, purgeInvalidProjects, recheckAll } = await import('../src/projectmaintain.mjs');

const ME = { account: 'fixture.user', tenant: 'tenant-a' };

test('删除项目只改变项目簿，清理失效项目不影响已选事实', () => {
  writeBook(ME, { projects: [
    { number: 'keep', name: '保留', lastVerdict: 'confirmed' },
    { number: 'old', name: '过期', expiresOn: '2020-01-01', lastVerdict: 'confirmed' },
  ] });
  assert.equal(removeProject('keep', ME).status, 'removed');
  const purged = purgeInvalidProjects(ME, '2026-09-09');
  assert.equal(purged.status, 'purged');
  assert.deepEqual(readBook(ME), { projects: [] });
  assert.match(purged.note, /历史任务/);
});

test('复检使用当前身份和 ERP 名称，并保留失败项目供用户处理', async () => {
  writeBook(ME, { projects: [
    { number: 'ok', name: '旧名称', lastVerdict: 'confirmed' },
    { number: 'gone', name: '仍保留', lastVerdict: 'confirmed' },
  ] });
  let calls = 0;
  const result = await recheckAll({
    identity: ME,
    gate: async () => ({ ok: true, probe: { identity: ME }, page: { kind: 'ego-page' } }),
    run: async (page, query) => {
      assert.deepEqual(page, { kind: 'ego-page' });
      calls += 1;
      return query.filter.includes("'ok'")
        ? { ok: true, rows: [['ok', '新名称', 'C', 'A']] }
        : { ok: true, rows: [] };
    },
    now: () => '2026-09-09T00:00:00.000Z', today: '2026-09-09',
  });
  assert.equal(result.status, 'done');
  assert.equal(calls, 2);
  assert.equal(readBook(ME).projects.find((p) => p.number === 'ok').name, '新名称');
  assert.equal(readBook(ME).projects.find((p) => p.number === 'gone').lastVerdict, 'missing');
});

test('ERP 复检完成后身份变化不会写回旧身份项目簿', async () => {
  writeBook(ME, { projects: [{ number: 'toctou', name: '旧名称', lastVerdict: 'confirmed' }] });
  let gates = 0;
  const result = await recheckAll({
    identity: ME,
    gate: async () => ({ ok: true, probe: { identity: ++gates === 1
      ? ME : { account: 'other', tenant: 'tenant-a' } }, page: { kind: 'ego-page' } }),
    run: async () => ({ ok: true, rows: [['toctou', '新名称', 'C', 'A']] }),
  });
  assert.equal(result.status, 'identity_mismatch');
  assert.equal(readBook(ME).projects[0].name, '旧名称');
});
