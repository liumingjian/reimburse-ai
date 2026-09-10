import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-project-intake-'));
process.env.BAOX_HOME = home;

const { intakeProject } = await import('../src/projectintake.mjs');
const { readBook } = await import('../src/projects.mjs');

const ME = { account: 'fixture.user', tenant: 'tenant-a' };
const gate = async () => ({ ok: true, probe: { identity: ME }, page: { kind: 'ego-page' } });
const confirmedRun = async (page, query) => {
  assert.deepEqual(page, { kind: 'ego-page' });
  assert.match(query.filter, /FNumber = 'P-1'/);
  return { ok: true, rows: [['P-1', 'ERP 名称', 'C', 'A']] };
};

test('录入只保存 ERP confirmed 和 ERP 回读名称', async () => {
  const result = await intakeProject('P-1', '2026-12-31', {
    identity: ME, gate, run: confirmedRun, now: () => '2026-09-09T00:00:00.000Z',
  });
  assert.equal(result.status, 'admitted');
  assert.equal(result.entry.name, 'ERP 名称');
  assert.equal(readBook(ME).projects[0].name, 'ERP 名称');
  assert.equal(readBook(ME).projects[0].lastVerdict, 'confirmed');
});

test('非 confirmed、身份变化和非法过期日都不写入项目簿', async () => {
  const before = JSON.stringify(readBook(ME));
  const missing = await intakeProject('P-2', null, {
    identity: ME, gate, run: async () => ({ ok: true, rows: [] }),
  });
  assert.equal(missing.status, 'rejected');
  assert.equal(JSON.stringify(readBook(ME)), before);

  const mismatch = await intakeProject('P-3', null, {
    identity: ME,
    gate: async () => ({ ok: true, probe: { identity: { account: 'other', tenant: 'tenant-a' } }, page: {} }),
    run: confirmedRun,
  });
  assert.equal(mismatch.status, 'identity_mismatch');
  assert.equal(JSON.stringify(readBook(ME)), before);

  const badDate = await intakeProject('P-4', '09/09/2026', { identity: ME, gate });
  assert.equal(badDate.status, 'rejected');
  assert.equal(badDate.verdict, 'bad_expires_on');
  assert.equal(JSON.stringify(readBook(ME)), before);
});

test('ERP 项目核验完成后身份变化不会写入旧身份项目簿', async () => {
  let gates = 0;
  const result = await intakeProject('P-5', null, {
    identity: ME,
    gate: async () => ({ ok: true, probe: { identity: ++gates === 1
      ? ME : { account: 'other', tenant: 'tenant-a' } }, page: { kind: 'ego-page' } }),
    run: async () => ({ ok: true, rows: [['P-5', 'ERP 名称', 'C', 'A']] }),
  });
  assert.equal(result.status, 'identity_mismatch');
  assert.equal(readBook(ME).projects.some((project) => project.number === 'P-5'), false);
});
