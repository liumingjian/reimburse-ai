#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { takeInventory, intakeOpenItems } from '../src/inventory.mjs';
import { classifyInventory, classifyOpenItems } from '../src/classify.mjs';
import { buildEvents, eventOpenItems } from '../src/events.mjs';
import { maskNumber } from '../src/parse.mjs';
import { normalizeMaterialScope } from '../src/material-scope.mjs';
import { sourceKeyOf } from '../src/workspace.mjs';

const COMMAND = 'material-baseline-readonly';
const USAGE = '用法：node kernel/bin/material-baseline-readonly.mjs --dir <材料目录> '
  + '[--task-scope <scope.json|任务目录|meta.json>] [--legacy-comparison]';

class CliError extends Error {
  constructor(message, code = 'ARGUMENT_ERROR') {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

const nextValue = (argv, index, name) => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`${name} 后面必须跟一个值`);
  return value;
};

/** 只解析显式参数；脚本不从 BAOX_HOME 或任务索引猜目录。 */
export function parseArgs(argv) {
  let dir = null;
  let taskScope = null;
  let legacyComparison = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--dir':
        dir = nextValue(argv, i, '--dir');
        i += 1;
        break;
      case '--task-scope':
        taskScope = nextValue(argv, i, '--task-scope');
        i += 1;
        break;
      case '--legacy-comparison':
        legacyComparison = true;
        break;
      default:
        throw new CliError(`不认识的参数：${argv[i]}`);
    }
  }
  if (help) return { help: true, dir: dir ? path.resolve(dir) : null, taskScope, legacyComparison };
  if (!dir) throw new CliError(`缺少 --dir <材料目录>。${USAGE}`);
  return {
    help: false,
    dir: path.resolve(dir),
    taskScope: taskScope ? path.resolve(taskScope) : null,
    legacyComparison,
  };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`${label} 不可读或不是 JSON：${error.message}`, 'SCOPE_INVALID');
  }
}

/**
 * 读取任务留下的 scope 事实，但不认领任务。传原任务 meta.json/任务目录时，后续读取器
 * 只按同 hash 读取已有图片读数和分摊，仍不加载或写回任何任务账本；也允许直接传 scope 记录。
 */
export function readTaskScope(input, sourceKey) {
  if (!input) return null;
  let inputPath = path.resolve(input);
  let stat;
  try { stat = fs.statSync(inputPath); } catch (error) {
    throw new CliError(`--task-scope 路径不可读：${error.message}`, 'SCOPE_INVALID');
  }
  if (stat.isDirectory()) inputPath = path.join(inputPath, 'meta.json');
  const raw = readJson(inputPath, '--task-scope');
  const record = raw?.materialScope ?? raw;
  if (!record || typeof record !== 'object' || !Array.isArray(record.exclusions)) {
    throw new CliError('--task-scope 必须是 scope JSON，或包含 materialScope.exclusions 的任务 meta.json',
      'SCOPE_INVALID');
  }
  if (record.sourceKey && record.sourceKey !== sourceKey) {
    throw new CliError('--task-scope 的 sourceKey 与 --dir 不一致，拒绝套用别的材料目录排除范围',
      'SCOPE_SOURCE_MISMATCH');
  }
  let scope;
  try { scope = normalizeMaterialScope(record); } catch (error) {
    throw new CliError(`--task-scope 内容无效：${error.message}`, 'SCOPE_INVALID');
  }
  return {
    inputLabel: path.basename(input),
    scope,
    taskContext: raw?.materialScope && typeof raw.createdAt === 'string' && typeof raw.taskId === 'string'
      ? raw : null,
    scopeId: typeof record.scopeId === 'string' ? record.scopeId : null,
    taskId: typeof record.taskId === 'string' ? record.taskId : null,
    sourceKey: record.sourceKey ?? null,
    recordedAt: record.recordedAt ?? null,
  };
}

const centsSummary = (amounts) => ({
  netCents: amounts?.netCents ?? null,
  taxCents: amounts?.taxCents ?? null,
  totalCents: amounts?.totalCents ?? null,
});

const materialSummary = (material) => ({
  materialId: material.materialId,
  relPath: material.relPath,
  fileName: material.fileName,
  format: material.format ?? null,
  size: material.size ?? null,
  contentHash: material.contentHash ?? null,
  readStatus: material.readStatus ?? null,
  disposition: material.disposition ?? null,
  reason: material.reason ?? null,
  ...(material.scopeReason ? { scopeReason: material.scopeReason } : {}),
});

const identitySummary = (identity) => identity ? ({
  scheme: identity.scheme,
  maskedNumber: maskNumber(identity.number),
  ...(identity.code ? { maskedCode: maskNumber(identity.code) } : {}),
}) : null;

const classificationSummary = (result) => ({
  materialId: result.materialId,
  fileName: result.fileName,
  contentHash: result.contentHash ?? null,
  parseStatus: result.parseStatus ?? null,
  role: result.role ?? null,
  kind: result.kind ?? null,
  identity: identitySummary(result.identity),
  fields: {
    issueDate: result.fields?.issueDate ?? null,
    travelDate: result.fields?.travelDate ?? null,
    totalAmountCents: result.fields?.totalAmount?.cents ?? null,
  },
  amounts: result.amounts ? centsSummary(result.amounts) : null,
});

const eventSummary = (event) => ({
  eventId: event.eventId,
  voucherMaterialId: event.voucherMaterialId,
  voucherFileName: event.voucherFileName,
  maskedNumber: event.maskedNumber ?? null,
  kind: event.kind,
  referenceMaterialIds: event.referenceMaterialIds ?? [],
  date: event.date ?? null,
  dateEvidence: event.dateEvidence ?? null,
  checkOut: event.checkOut ?? null,
  endDate: event.endDate ?? event.checkOut ?? null,
  city: event.city ?? null,
  route: event.route ?? null,
  amounts: centsSummary(event.amounts),
  amountSource: event.amountSource ?? null,
  splitBasis: event.splitBasis ?? null,
});

function eventTotals(events) {
  const totals = events.map((event) => event.amounts?.totalCents);
  const complete = totals.every((value) => Number.isSafeInteger(value));
  return {
    complete,
    totalCents: complete ? totals.reduce((sum, value) => sum + value, 0) : null,
    source: 'sum of events[].amounts.totalCents; null when any event total is missing',
  };
}

const withStage = (stage, items) => items.filter((item) => item.blocking)
  .map((item) => ({ stage, ...item }));

/** 纯读取一次盘点、分流、事件构建；task 传 null 以禁止读取或写入任务状态。 */
export async function buildBaseline({ dir, taskScope = null, legacyComparison = false }) {
  const root = path.resolve(dir);
  const sourceKey = sourceKeyOf(root);
  const scopeRecord = readTaskScope(taskScope, sourceKey);
  const inventory = await takeInventory(root, { scope: scopeRecord?.scope ?? null });
  const intakeItems = intakeOpenItems(inventory);
  // 任务 context 只供现有读取器读取同 hash 的已确认图片读数/分摊；本命令不写回它。
  const task = scopeRecord?.taskContext ?? null;
  const classification = classifyInventory(root, inventory, task,
    { mode: legacyComparison ? 'legacy' : 'markdown' });
  const classifyItems = classifyOpenItems(classification);
  const built = buildEvents(classification, task);
  const eventItems = eventOpenItems(built);
  const blocking = [
    ...withStage('inventory', intakeItems),
    ...withStage('classification', classifyItems),
    ...withStage('events', eventItems),
  ];

  return {
    command: COMMAND,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    source: { label: path.basename(root), sourceKey },
    comparisonMode: legacyComparison ? 'legacy_parser_explicit' : 'markdown_candidate_default',
    scope: scopeRecord ? {
      applied: true,
      input: scopeRecord.inputLabel,
      scopeId: scopeRecord.scopeId,
      taskId: scopeRecord.taskId,
      taskContextUsed: !!scopeRecord.taskContext,
      recordedAt: scopeRecord.recordedAt,
      sourceKey: scopeRecord.sourceKey,
      exclusions: scopeRecord.scope.exclusions,
      observedExcluded: inventory.excluded.map(materialSummary),
    } : { applied: false, exclusions: [], observedExcluded: [] },
    inventory: {
      versionId: inventory.versionId,
      takenAt: inventory.takenAt,
      materialCount: inventory.materials.length,
      excludedCount: inventory.excluded.length,
      ignoredCount: inventory.ignored.length,
      materials: inventory.materials.map(materialSummary),
      excluded: inventory.excluded.map(materialSummary),
      ignored: inventory.ignored,
      scopeMismatches: inventory.scopeMismatches ?? [],
    },
    classification: {
      versionId: classification.versionId,
      classifiedAt: classification.classifiedAt,
      results: classification.results.map(classificationSummary),
      duplicates: classification.duplicates,
      openItems: classifyItems,
    },
    events: {
      versionId: built.versionId,
      eventCount: built.events.length,
      totals: eventTotals(built.events),
      events: built.events.map(eventSummary),
      notes: built.notes,
      openItems: eventItems,
    },
    blocking,
    status: blocking.length ? 'blocked' : 'ready_for_next_stage',
  };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { command: COMMAND, status: 'help', usage: USAGE };
  return buildBaseline(args);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const status = error instanceof CliError ? 'invalid_request' : 'read_failed';
    process.stdout.write(`${JSON.stringify({ command: COMMAND, status,
      code: error.code ?? 'READ_FAILED', error: error.message, usage: USAGE }, null, 2)}\n`);
    process.exitCode = error instanceof CliError ? 2 : 1;
  }
}
