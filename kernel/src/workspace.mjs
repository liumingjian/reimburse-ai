import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, ensureDir } from './paths.mjs';

// 任务工作区。它是跨报销任务长期存在的事实存储 —— 历史发票身份要靠它做重复检测，
// `ERP 写入结果未知` 的任务也不能被清理，所以这里不做任何自动清理。

const tasksRoot = () => path.join(paths.root, 'tasks');
const indexPath = () => path.join(tasksRoot(), 'index.json');

// 源目录的绝对路径不落盘（契约：日志不持久化原目录绝对路径）。
// 落盘的只有它的哈希用于识别同一个目录，外加一个仅供展示的目录名。
export const sourceKeyOf = (absDir) =>
  crypto.createHash('sha256').update(path.resolve(absDir), 'utf8').digest('hex').slice(0, 16);

const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v) => {
  ensureDir(path.dirname(p));
  // 先写临时文件再改名：中途中断不会留下半个 JSON。
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
};

/** 任务还没结束、可以继续往下走的状态。 */
const LIVE = new Set(['open']);

export function loadIndex() {
  return readJson(indexPath(), { tasks: [] });
}

export function taskDir(task) {
  return path.join(tasksRoot(), `${task.createdAt.slice(0, 10)}-${task.taskId}`);
}

export function findLiveTaskForSource(sourceKey) {
  return loadIndex().tasks.find((t) => t.sourceKey === sourceKey && LIVE.has(t.status)) ?? null;
}

export function createTask(absDir) {
  const task = {
    taskId: crypto.randomBytes(5).toString('hex'),
    createdAt: new Date().toISOString(),
    status: 'open',
    sourceKey: sourceKeyOf(absDir),
    sourceLabel: path.basename(path.resolve(absDir)),
    currentVersionId: null,
  };
  const idx = loadIndex();
  idx.tasks.push(task);
  writeJson(indexPath(), idx);
  ensureDir(path.join(taskDir(task), 'inventories'));
  writeJson(path.join(taskDir(task), 'meta.json'), task);
  return task;
}

/**
 * 把一次材料盘点记进任务。同一个版本重复盘点不产生新记录（幂等）。
 * 版本变化时旧的 ERP 就绪快照立即失效 —— 这里只负责记下这个事实。
 */
export function recordInventory(task, inventory) {
  const dir = taskDir(task);
  const file = path.join(dir, 'inventories', `${inventory.versionId}.json`);
  const isNewVersion = task.currentVersionId !== inventory.versionId;
  const firstTime = !fs.existsSync(file);

  if (firstTime) writeJson(file, inventory);

  const updated = { ...task, currentVersionId: inventory.versionId, updatedAt: new Date().toISOString() };
  writeJson(path.join(dir, 'meta.json'), updated);

  const idx = loadIndex();
  const i = idx.tasks.findIndex((t) => t.taskId === task.taskId);
  if (i > -1) idx.tasks[i] = updated;
  writeJson(indexPath(), idx);

  const known = fs.readdirSync(path.join(dir, 'inventories')).filter((f) => f.endsWith('.json'));
  return {
    task: updated,
    isNewVersion,
    supersededVersionId: isNewVersion ? task.currentVersionId : null,
    versionCount: known.length,
  };
}
