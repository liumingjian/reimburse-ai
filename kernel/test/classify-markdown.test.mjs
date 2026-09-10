import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { takeInventory } from '../src/inventory.mjs';
import { classifyInventory, classifyOpenItems, markdownMaterialPaths } from '../src/classify.mjs';
import { ingest, prepare } from '../src/pdf-markdown.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-classify-markdown-'));

const MARKDOWN = [
  '电子发票(普通发票)',
  '发票号码:12345678901234567890',
  '开票日期:2026年09月01日',
  '| 项目 | 金额 | 税额 |',
  '| --- | --- | --- |',
  '| 合计 | ¥18.25 | ¥0.55 |',
  '| 价税合计 | ¥18.80 | |',
].join('\n');

const evidence = (lineStart, quote) => [{ lineStart, lineEnd: lineStart, quote }];

function candidateFor(artifact, overrides = {}) {
  return {
    schemaVersion: 1,
    materialId: artifact.materialId,
    contentHash: artifact.contentHash,
    source: {
      kind: 'agent_from_markdown',
      converter: 'markitdown',
      converterVersion: '0.1.7',
      runtimeLockHash: artifact.source.runtimeLockHash,
      markdownHash: artifact.source.markdownHash,
    },
    documentType: 'invoice',
    kind: 'vat_common',
    kindEvidence: evidence(1, '电子发票(普通发票)'),
    fields: {
      invoiceNumber: '12345678901234567890',
      issueDate: '2026-09-01',
      netAmount: '18.25',
      taxAmount: '0.55',
      totalAmount: '18.80',
      ...(overrides.fields ?? {}),
    },
    segments: [],
    fieldEvidence: {
      invoiceNumber: evidence(2, '发票号码:12345678901234567890'),
      issueDate: evidence(3, '开票日期:2026年09月01日'),
      netAmount: evidence(6, '¥18.25'),
      taxAmount: evidence(6, '¥0.55'),
      totalAmount: evidence(7, '¥18.80'),
      ...(overrides.fieldEvidence ?? {}),
    },
    fieldStatus: {
      invoiceNumber: 'explicit', issueDate: 'explicit', netAmount: 'explicit',
      taxAmount: 'explicit', totalAmount: 'explicit', ...(overrides.fieldStatus ?? {}),
    },
    fieldBasis: overrides.fieldBasis ?? {},
    unreadable: overrides.unreadable ?? [],
    issues: overrides.issues ?? [],
  };
}

function task() {
  return {
    taskId: 'task-markdown',
    createdAt: '2026-09-09T00:00:00.000Z',
    currentVersionId: null,
    identity: { account: 'luo.liu', tenant: 'tenant-1' },
  };
}

test('默认 PDF 分类必须先有 MarkItDown artifact，不能静默回退旧 parser', async () => {
  process.env.BAOX_HOME = tempDir();
  const sourceDir = tempDir();
  fs.writeFileSync(path.join(sourceDir, 'invoice.pdf'), Buffer.from('%PDF-1.4\nfixture', 'ascii'));
  const inventory = await takeInventory(sourceDir);
  const currentTask = task();

  const before = classifyInventory(sourceDir, inventory, currentTask);
  assert.equal(before.results[0].parseStatus, 'markdown_conversion_required');
  assert.ok(classifyOpenItems(before).some((item) => item.kind === 'markdown_conversion_required'));
  assert.equal(before.results[0].role, null, '没有候选时不能沿用旧解析器的角色判断');

  const material = inventory.materials[0];
  const paths = markdownMaterialPaths(currentTask, inventory.versionId, material.materialId);
  const sourcePath = path.join(sourceDir, material.relPath);
  const prepared = await prepare({ sourcePath, materialId: material.materialId,
    outputPath: paths.artifactPath, converter: async () => ({ status: 'converted', markdown: MARKDOWN }) });
  fs.writeFileSync(paths.markdownPath, prepared.artifact.markdown);
  fs.writeFileSync(paths.numberedMarkdownPath, prepared.artifact.numberedMarkdown);
  fs.writeFileSync(paths.candidatePath, JSON.stringify(candidateFor(prepared.artifact), null, 2));
  const accepted = await ingest({ artifact: prepared.artifact, submission: paths.candidatePath,
    outputPath: paths.candidateRecordPath, overwrite: true });
  assert.equal(accepted.verdict, 'accepted');

  const after = classifyInventory(sourceDir, inventory, currentTask);
  const result = after.results[0];
  assert.equal(result.parseStatus, 'parsed');
  assert.equal(result.source, 'agent_from_markdown');
  assert.equal(result.identity.scheme, 'einvoice-20');
  assert.equal(result.fields.totalAmount.cents, 1880);
  assert.equal(result.candidateSources.markdownHash, prepared.artifact.source.markdownHash);
  assert.equal(result.candidateSources.fieldEvidence.totalAmount[0].quote, '¥18.80');
  assert.equal(classifyOpenItems(after).some((item) => item.kind.startsWith('markdown_')), false);

  fs.writeFileSync(paths.numberedMarkdownPath, `${prepared.artifact.numberedMarkdown}\n被改过`);
  const sidecarChanged = classifyInventory(sourceDir, inventory, currentTask);
  assert.equal(sidecarChanged.results[0].parseStatus, 'markdown_conversion_required',
    '带编号 sidecar 被改动时必须重新生成，不能继续用 embedded artifact');
  fs.writeFileSync(paths.numberedMarkdownPath, prepared.artifact.numberedMarkdown);

  fs.writeFileSync(paths.reextractPath, JSON.stringify({
    schemaVersion: 1, taskId: currentTask.taskId, versionId: inventory.versionId,
    materialId: material.materialId, contentHash: material.contentHash,
    markdownHash: prepared.artifact.source.markdownHash,
  }));
  const invalidated = classifyInventory(sourceDir, inventory, currentTask);
  assert.equal(invalidated.results[0].parseStatus, 'markdown_candidate_required',
    '同 hash 重新抽取请求必须使旧 accepted record 失效');
});
