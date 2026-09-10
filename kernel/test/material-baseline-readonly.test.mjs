import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import url from 'node:url';
import crypto from 'node:crypto';

const bin = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'bin',
  'material-baseline-readonly.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-baseline-home-'));

const pdf = (suffix) => Buffer.from(`%PDF-1.4\n${suffix}\n`, 'ascii');
const write = (root, relPath, bytes) => {
  const file = path.join(root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const runCli = (args) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8',
  env: { ...process.env, BAOX_HOME: home },
});
const parseOutput = (run) => JSON.parse(run.stdout);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('只读基线 CLI 要求显式 --dir，并拒绝未知参数', () => {
  const missing = runCli([]);
  assert.equal(missing.status, 2);
  assert.equal(parseOutput(missing).code, 'ARGUMENT_ERROR');

  const unknown = runCli(['--dir', os.tmpdir(), '--nope']);
  assert.equal(unknown.status, 2);
  assert.equal(parseOutput(unknown).code, 'ARGUMENT_ERROR');
});

test('只读基线不创建任务、不写 BAOX_HOME，并输出材料 hash、阻塞和事件结构', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-baseline-source-'));
  const keep = pdf('keep');
  const excluded = pdf('excluded');
  write(root, 'keep.pdf', keep);
  write(root, 'expired/already.pdf', excluded);
  const scopeFile = path.join(os.tmpdir(), `baox-baseline-scope-${Date.now()}.json`);
  fs.writeFileSync(scopeFile, JSON.stringify({ schemaVersion: 1, exclusions: [{
    relPath: 'expired/already.pdf', contentHash: hash(excluded), size: excluded.length,
    reason: 'already_reimbursed_parse_only',
  }] }));
  const before = fs.readFileSync(path.join(root, 'keep.pdf'));
  const beforeEntries = fs.readdirSync(root, { recursive: true }).sort();

  const result = runCli(['--dir', root, '--task-scope', scopeFile]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = parseOutput(result);
  assert.equal(report.readOnly, true);
  assert.equal(report.scope.applied, true);
  assert.equal(report.inventory.materialCount, 1);
  assert.equal(report.inventory.excludedCount, 1);
  assert.equal(report.inventory.excluded[0].contentHash, hash(excluded));
  assert.equal(report.scope.exclusions[0].reason, 'already_reimbursed_parse_only');
  assert.ok('blocking' in report);
  assert.ok('events' in report && Array.isArray(report.events.events));
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), beforeEntries);
  assert.deepEqual(fs.readFileSync(path.join(root, 'keep.pdf')), before);
  assert.deepEqual(fs.readdirSync(home), [], '只读基线不能创建 BAOX_HOME 数据');
  fs.rmSync(scopeFile, { force: true });
});

test('scope sourceKey 不属于材料目录时拒绝，避免套用别的任务排除清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-baseline-source-mismatch-'));
  write(root, 'keep.pdf', pdf('keep'));
  const scopeFile = path.join(os.tmpdir(), `baox-baseline-mismatch-${Date.now()}.json`);
  fs.writeFileSync(scopeFile, JSON.stringify({ sourceKey: 'not-this-directory', schemaVersion: 1,
    exclusions: [{ relPath: 'keep.pdf', contentHash: hash(pdf('keep')), size: pdf('keep').length,
      reason: 'already_reimbursed_parse_only' }] }));
  const result = runCli(['--dir', root, '--task-scope', scopeFile]);
  assert.equal(result.status, 2);
  assert.equal(parseOutput(result).code, 'SCOPE_SOURCE_MISMATCH');
  fs.rmSync(scopeFile, { force: true });
});
