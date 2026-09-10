import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import url from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-material-scope-home-'));
process.env.BAOX_HOME = home;

const { takeInventory, takeInventoryForTask, intakeOpenItems } = await import('../src/inventory.mjs');
const { createTask, recordInventory, recordMaterialScope, loadIndex } = await import('../src/workspace.mjs');

const pdf = (suffix = '') => Buffer.from(`%PDF-1.4\n${suffix}\n`, 'ascii');
const write = (root, rel, bytes) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};

const scopeFor = (inventory, relPath) => {
  const material = inventory.materials.find((item) => item.relPath === relPath);
  return {
    schemaVersion: 1,
    exclusions: [{ relPath, contentHash: material.contentHash, size: material.size,
      reason: 'already_reimbursed_parse_only' }],
  };
};

test('普通 inventory 不隐藏文件，显式 task scope 只排除精确 hash/size 的文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-scope-'));
  write(root, 'keep.pdf', pdf('keep'));
  write(root, 'expired/old.pdf', pdf('old'));
  const ordinary = await takeInventory(root);
  const scope = scopeFor(ordinary, 'expired/old.pdf');
  const scoped = await takeInventory(root, { scope });

  assert.deepEqual(ordinary.materials.map((item) => item.relPath), ['expired/old.pdf', 'keep.pdf']);
  assert.deepEqual(scoped.materials.map((item) => item.relPath), ['keep.pdf']);
  assert.equal(scoped.excluded.length, 1);
  assert.equal(scoped.excluded[0].scopeReason, 'already_reimbursed_parse_only');
  assert.deepEqual(scoped.scopeMismatches, []);
  assert.deepEqual((await takeInventory(root)).materials.map((item) => item.relPath),
    ['expired/old.pdf', 'keep.pdf'], '普通解析 QA 仍看到全部文件');

  const keepOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-scope-keep-'));
  write(keepOnly, 'keep.pdf', pdf('keep'));
  assert.equal(scoped.versionId, (await takeInventory(keepOnly)).versionId,
    '已明确排除的四类 QA 材料不改变原有效版本');
});

test('新增文件进入 version，排除文件变更或缺失不自动隐藏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-scope-change-'));
  write(root, 'keep.pdf', pdf('keep'));
  write(root, 'expired/old.pdf', pdf('old'));
  const ordinary = await takeInventory(root);
  const scope = scopeFor(ordinary, 'expired/old.pdf');
  const before = await takeInventoryForTask(root, { materialScope: scope });

  write(root, 'expired/old.pdf', pdf('changed'));
  const changed = await takeInventoryForTask(root, { materialScope: scope });
  assert.equal(changed.excluded.length, 0);
  assert.ok(changed.materials.some((item) => item.relPath === 'expired/old.pdf'));
  assert.equal(changed.scopeMismatches[0].status, 'changed');
  assert.ok(intakeOpenItems(changed).some((item) => item.kind === 'material_scope_mismatch'));
  assert.notEqual(changed.versionId, before.versionId);

  fs.rmSync(path.join(root, 'expired/old.pdf'));
  const missing = await takeInventoryForTask(root, { materialScope: scope });
  assert.equal(missing.scopeMismatches[0].status, 'missing');
  assert.equal(missing.excluded.length, 0);

  write(root, 'expired/old.pdf', pdf('old'));
  write(root, 'future.pdf', pdf('future'));
  const added = await takeInventoryForTask(root, { materialScope: scope });
  assert.ok(added.materials.some((item) => item.relPath === 'future.pdf'));
  assert.equal(added.excluded.length, 1);
  assert.notEqual(added.versionId, before.versionId);
});

test('记录 scope 只追加审计 revision，不改 currentVersionId', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-scope-record-'));
  write(root, 'keep.pdf', pdf('keep'));
  const inventory = await takeInventory(root);
  const task = createTask(root);
  recordInventory(task, inventory);
  const result = recordMaterialScope(task, {
    schemaVersion: 1,
    exclusions: [{ relPath: 'keep.pdf', contentHash: inventory.materials[0].contentHash,
      size: inventory.materials[0].size, reason: 'already_reimbursed_parse_only' }],
  });
  assert.equal(result.task.currentVersionId, inventory.versionId);
  assert.equal(result.task.erpWriteState, undefined);
  assert.ok(fs.existsSync(result.filePath));
  const loaded = loadIndex().tasks.find((item) => item.taskId === task.taskId);
  assert.equal(loaded.materialScope.scopeId, result.scope.scopeId);
  assert.equal(loaded.currentVersionId, inventory.versionId);
});

test('正式 scope-materials CLI 只写显式 scope，不改任务 version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-scope-cli-'));
  write(root, 'keep.pdf', pdf('keep'));
  write(root, 'expired/old.pdf', pdf('old'));
  const ordinary = await takeInventory(root);
  const scope = scopeFor(ordinary, 'expired/old.pdf');
  const task = createTask(root);
  const scoped = await takeInventoryForTask(root, { materialScope: scope });
  recordInventory(task, scoped);
  const scopeFile = path.join(home, `${path.basename(root)}-scope.json`);
  fs.writeFileSync(scopeFile, `${JSON.stringify(scope)}\n`);
  const bin = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'bin', 'baox.mjs');
  const output = execFileSync(process.execPath,
    [bin, 'scope-materials', '--dir', root, '--file', scopeFile, '--i-am-a-human'],
    { encoding: 'utf8', env: { ...process.env, BAOX_HOME: home } });
  const result = JSON.parse(output);
  assert.equal(result.status, 'recorded');
  assert.equal(result.inventory.versionMatches, true);
  assert.equal(result.task.currentVersionId, scoped.versionId);
  assert.equal(result.task.erpWriteState, null);
});
