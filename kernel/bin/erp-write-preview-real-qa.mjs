#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildErpWritePreview } from '../src/erp-write-preview.mjs';

// Explicit, read-only audit for a captured task. It is kept out of the normal
// test suite because its expected result is tied to the captured task state.
const base = path.resolve(process.env.BAOX_REAL_TASK_DIR
  ?? '/Users/lmj/.baox/tasks/2026-09-08-b34804ed20');
const read = (name) => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));

const task = read('meta.json');
const built = read(`events/${task.currentVersionId}.json`);
const selection = read('selection.json');
const catalog = read('catalog.json');
const receiptCheck = read('erp-receipt-check.json');
const attempts = read('erp-attempts.json');

const result = buildErpWritePreview({ task, built, selection, catalog, receiptCheck });
if (result.ready) {
  throw new Error('真实任务的旧选择意外生成了可写预览；应因缺少本人 project_book/ERP 来源而阻塞');
}

const codes = result.problems.map((problem) => problem.code);
if (!codes.includes('project_source_not_ready') || !codes.includes('projects_from_not_ready')) {
  throw new Error(`真实任务未报告 project_book 来源阻塞：${codes.join(', ')}`);
}

const strictAttempts = (attempts.attempts ?? []).filter((attempt) => attempt.readings?.taskMatch);
const historical = strictAttempts.at(-1) ?? null;
if (historical && historical.readings.taskMatch.ok !== false) {
  throw new Error('真实历史逐行回读记录不是阻塞状态');
}
if (receiptCheck.checks?.length !== 4) {
  throw new Error(`真实任务应有 4 条逐票收票核对，实际是 ${receiptCheck.checks?.length ?? 0} 条`);
}
const hasFourThreeRejection = historical?.readings.taskMatch?.reasons?.some((reason) =>
  /要求 4 条明细，ERP 实际为 3 条/.test(reason));
if (!hasFourThreeRejection) {
  throw new Error('真实历史证据中没有找到四张收票、三条明细的逐行拒绝理由');
}

console.log(JSON.stringify({
  readOnly: true,
  taskId: task.taskId,
  versionId: task.currentVersionId,
  receiptChecks: receiptCheck.checks?.length ?? 0,
  previewReady: result.ready,
  blockedBy: [...new Set(codes)],
  historicalStrictReadback: historical?.readings.taskMatch ?? null,
}, null, 2));
