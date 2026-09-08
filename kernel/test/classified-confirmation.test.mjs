import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-confirm-stage-home-'));
process.env.BAOX_HOME = home;
const { createTask, taskDir } = await import('../src/workspace.mjs');
const { classifiedDetailAggregate, classifiedDetailDigest, confirmAndStage,
  confirmationStatus, cleanupOwnedStaging } = await import('../src/classified-confirmation.mjs');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture = () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-confirm-stage-source-'));
  fs.mkdirSync(path.join(sourceDir, 'nested'));
  fs.writeFileSync(path.join(sourceDir, 'nested', 'voucher.pdf'), '%PDF-1.4 voucher');
  fs.writeFileSync(path.join(sourceDir, 'reference.pdf'), '%PDF-1.4 reference');
  const voucherHash = hash(path.join(sourceDir, 'nested', 'voucher.pdf'));
  const referenceHash = hash(path.join(sourceDir, 'reference.pdf'));
  const inventory = { versionId: 'v-fixture', materials: [
    { materialId: 'm-voucher', relPath: 'nested/voucher.pdf', fileName: 'voucher.pdf', contentHash: voucherHash },
    { materialId: 'm-reference', relPath: 'reference.pdf', fileName: 'reference.pdf', contentHash: referenceHash },
  ] };
  const classification = { versionId: 'v-fixture', results: [
    { materialId: 'm-voucher', role: 'primary_voucher' },
    { materialId: 'm-reference', role: 'reference' },
  ] };
  const events = { events: [{ eventId: 'ev-01', voucherMaterialId: 'm-voucher', maskedNumber: '***1234',
    referenceMaterialIds: ['m-reference'] }] };
  const lines = [{ lineId: 'ev-01', eventId: 'ev-01', voucherMaterialId: 'm-voucher',
    date: '2026-09-08', totalAmount: '18.80', amountSource: 'voucher_face', city: '广州',
    route: null, category: 'local_city_transport', categoryLabel: '本地市内交通' }];
  const task = createTask(sourceDir);
  const aggregate = classifiedDetailAggregate({ inventory, classification, events, lines });
  return { sourceDir, task, inventory, classification, events, lines, aggregate };
};

test('完整明细一行一次，摘要覆盖日期金额来源地理类别关联和行变化', () => {
  const f = fixture();
  assert.equal(f.aggregate.rows.length, 1);
  assert.match(f.aggregate.readingBasisDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.aggregate.rows[0], {
    lineRef: 'ev-01', materialRef: 'm-voucher', voucher: '***1234', date: '2026-09-08',
    amount: '18.80', amountSource: 'voucher_face', city: '广州', route: null,
    category: 'local_city_transport', categoryLabel: '本地市内交通',
    association: { primary: 'm-voucher', references: ['m-reference'] },
  });
  const original = classifiedDetailDigest(f.aggregate);
  for (const [key, value] of [['date', '2026-09-09'], ['amount', '19.80'],
    ['amountSource', 'user_allocation'], ['city', '北京'], ['category', 'remote_city_transport']]) {
    const changed = structuredClone(f.aggregate);
    changed.rows[0][key] = value;
    assert.notEqual(classifiedDetailDigest(changed), original, `${key} 变化必须使确认失效`);
  }
  const readingChanged = classifiedDetailAggregate({ ...f, classification: { ...f.classification,
    results: f.classification.results.map((r) => r.materialId === 'm-voucher'
      ? { ...r, fields: { totalAmount: '18.80' }, fieldSources: { totalAmount: 'vision' } } : r) } });
  assert.notEqual(classifiedDetailDigest(readingChanged), original, '读数事实变化必须使确认失效');
  const associated = structuredClone(f.aggregate);
  associated.rows[0].association.references.push('m-other');
  assert.notEqual(classifiedDetailDigest(associated), original);
  const extra = structuredClone(f.aggregate);
  extra.rows.push({ ...extra.rows[0], lineRef: 'ev-02' });
  assert.notEqual(classifiedDetailDigest(extra), original);
});

test('确认原子复制仅主要凭证，保留源文件，清单与权限可复核', () => {
  const f = fixture();
  const digest = classifiedDetailDigest(f.aggregate);
  const record = confirmAndStage({ ...f, digest });
  assert.equal(record.digest, digest);
  const status = confirmationStatus(f.task, f.aggregate);
  assert.equal(status.confirmed, true);
  assert.equal(status.staged, true);
  assert.equal(status.manifest.files.length, 1, '参考材料不能暂存');
  const entry = status.manifest.files[0];
  assert.equal(entry.materialId, 'm-voucher');
  assert.equal(entry.sourceRelativePath, 'nested/voucher.pdf');
  assert.equal(entry.sourceHash, f.inventory.materials[0].contentHash);
  assert.equal(entry.version, 'v-fixture');
  assert.match(entry.stagedName, /^m-voucher-[a-f0-9]{64}\.pdf$/);
  const stagedDir = path.join(taskDir(f.task), record.stagingDirectory);
  assert.equal(fs.statSync(stagedDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stagedDir, entry.stagedName)).mode & 0o777, 0o600);
  assert.equal(hash(path.join(stagedDir, entry.stagedName)), entry.sourceHash);
  assert.ok(fs.existsSync(path.join(f.sourceDir, 'nested', 'voucher.pdf')), '只能复制，不能移动');
  assert.ok(!status.manifest.files.some((x) => x.materialId === 'm-reference'));
});

test('路径逃逸、符号链接替换和哈希变化都拒绝，失败不落确认', () => {
  for (const attack of ['escape', 'symlink', 'changed']) {
    const f = fixture();
    if (attack === 'escape') f.inventory.materials[0].relPath = '../outside.pdf';
    if (attack === 'symlink') {
      fs.unlinkSync(path.join(f.sourceDir, 'nested', 'voucher.pdf'));
      fs.symlinkSync(path.join(f.sourceDir, 'reference.pdf'), path.join(f.sourceDir, 'nested', 'voucher.pdf'));
    }
    if (attack === 'changed') fs.appendFileSync(path.join(f.sourceDir, 'nested', 'voucher.pdf'), 'changed');
    assert.throws(() => confirmAndStage({ ...f, digest: classifiedDetailDigest(f.aggregate) }));
    assert.equal(confirmationStatus(f.task, f.aggregate).confirmed, false);
  }
});

test('暂存根符号链接和已有不可复核摘要目录都拒绝覆盖', () => {
  const linked = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-confirm-stage-outside-'));
  fs.symlinkSync(outside, path.join(taskDir(linked.task), 'erp-upload'));
  assert.throws(() => confirmAndStage({ ...linked, digest: classifiedDetailDigest(linked.aggregate) }));
  assert.deepEqual(fs.readdirSync(outside), []);

  const occupied = fixture();
  const digest = classifiedDetailDigest(occupied.aggregate);
  const uploadRoot = path.join(taskDir(occupied.task), 'erp-upload');
  fs.mkdirSync(path.join(uploadRoot, digest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(uploadRoot, digest, 'foreign'), 'keep');
  assert.throws(() => confirmAndStage({ ...occupied, digest }));
  assert.equal(fs.readFileSync(path.join(uploadRoot, digest, 'foreign'), 'utf8'), 'keep');
});

test('清单篡改使暂存失效，重试只重建本任务明确归属的摘要目录', () => {
  const f = fixture();
  const digest = classifiedDetailDigest(f.aggregate);
  confirmAndStage({ ...f, digest });
  const status = confirmationStatus(f.task, f.aggregate);
  const manifestFile = path.join(taskDir(f.task), status.record.stagingDirectory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files[0].sourceHash = '0'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  const tampered = confirmationStatus(f.task, f.aggregate);
  assert.equal(tampered.confirmed, true);
  assert.equal(tampered.staged, false);
  confirmAndStage({ ...f, digest });
  assert.equal(confirmationStatus(f.task, f.aggregate).staged, true);
});

test('暂存有任务归属标记并保留，只有显式受支持清理会删除归属匹配目录', () => {
  const f = fixture();
  confirmAndStage({ ...f, digest: classifiedDetailDigest(f.aggregate) });
  const status = confirmationStatus(f.task, f.aggregate);
  const stagedDir = path.join(taskDir(f.task), status.record.stagingDirectory);
  assert.ok(fs.existsSync(stagedDir), '普通生命周期不自动清理');
  fs.writeFileSync(path.join(stagedDir, '.baox-owner.json'), JSON.stringify({ taskId: 'forged' }), { mode: 0o600 });
  assert.equal(cleanupOwnedStaging(f.task).removed, 0, '归属不匹配不能删除');
  assert.ok(fs.existsSync(stagedDir));
  fs.writeFileSync(path.join(stagedDir, '.baox-owner.json'), JSON.stringify({
    version: 1, taskId: f.task.taskId, digest: status.record.digest,
  }), { mode: 0o600 });
  const tempName = `.${status.record.digest}.deadbeef.tmp`;
  const tempDir = path.join(taskDir(f.task), 'erp-upload', tempName);
  fs.mkdirSync(tempDir, { mode: 0o700 });
  fs.writeFileSync(path.join(tempDir, '.baox-owner.json'), JSON.stringify({
    version: 1, taskId: f.task.taskId, digest: status.record.digest,
  }), { mode: 0o600 });
  assert.equal(cleanupOwnedStaging(f.task).removed, 2);
  assert.ok(!fs.existsSync(stagedDir));
  assert.ok(!fs.existsSync(tempDir));
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
