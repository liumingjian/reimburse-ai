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

/** 还在进行中的任务。改绑身份要看它 —— 手上有活的时候换人，等于把上半程的
 *  材料记在一个人头上、下半程记在另一个人头上。 */
export function liveTasks() {
  return loadIndex().tasks.filter((t) => LIVE.has(t.status));
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

/**
 * 把一次材料分流与解析记进任务。它永远从属于某个盘点版本 ——
 * 材料一变就是新版本，旧的解析结果作为历史事实留着，不再代表当前状态。
 */
export function recordClassification(task, classification) {
  const dir = path.join(taskDir(task), 'classifications');
  writeJson(path.join(dir, `${classification.versionId}.json`), classification);
  return path.join(dir, `${classification.versionId}.json`);
}

/**
 * 把一次费用事件构建记进任务。同样从属于某个盘点版本 ——
 * 材料一变，事件、证据关联和逐段分摊都要重新建立。
 */
export function recordEvents(task, built) {
  const dir = path.join(taskDir(task), 'events');
  writeJson(path.join(dir, `${built.versionId}.json`), built);
  return path.join(dir, `${built.versionId}.json`);
}

/**
 * 改任务状态。跨任务重复检查靠它区分"另一个任务还打算报这张票"和"那个任务已经作罢"。
 *
 * 只允许 `open` -> `abandoned`：一旦任务动过 ERP（包括写入结果未知），
 * 它占着的那些发票就不能靠改状态解除占用 —— 那要靠只读对账，不是靠声明。
 */
export function abandonTask(taskId, reason) {
  const idx = loadIndex();
  const i = idx.tasks.findIndex((t) => t.taskId === taskId);
  if (i < 0) return { verdict: 'rejected', reason: `没有这个任务 ${taskId}` };
  const t = idx.tasks[i];
  if (t.status === 'abandoned') return { verdict: 'noop', task: t };
  if (t.status !== 'open') {
    return { verdict: 'rejected', reason: `任务 ${taskId} 的状态是 ${t.status}，不是可以作废的进行中任务` };
  }
  if (t.erpWriteState) {
    return { verdict: 'rejected',
      reason: `任务 ${taskId} 已经动过 ERP（${t.erpWriteState}），它占用的发票要靠 ERP 只读对账解除，不能改状态` };
  }
  const updated = { ...t, status: 'abandoned', abandonedAt: new Date().toISOString(),
    abandonReason: reason ?? null };
  idx.tasks[i] = updated;
  writeJson(indexPath(), idx);
  writeJson(path.join(taskDir(updated), 'meta.json'), updated);
  return { verdict: 'abandoned', task: updated };
}

/**
 * 把这个任务当前持有的发票身份写成一份摘要，供跨任务重复检查读取。
 *
 * 它是**派生**的，每次分流都整份重写：用户把一张发票挪出目录，
 * 这里就跟着少一条，不会留下一条永远解不掉的占用。
 */
export function recordInvoiceSightings(task, classification) {
  const invoices = classification.results
    .filter((r) => r.identity)
    .map((r) => ({ identityKey: r.identity.key, number: r.identity.number,
      materialId: r.materialId, fileName: r.fileName }));
  const digest = { taskId: task.taskId, versionId: classification.versionId,
    updatedAt: new Date().toISOString(), invoices };
  writeJson(path.join(taskDir(task), 'invoices.json'), digest);
  return digest;
}

export function loadInvoiceSightings(task) {
  return readJson(path.join(taskDir(task), 'invoices.json'), null);
}

/**
 * 记一次 ERP 主数据只读核对的结果。
 *
 * 它绑在候选明细的指纹上，和任务选择用的是同一个指纹：明细一变，
 * 上次核对的那些项目号就未必还是这几行要用的，核对结果当即失效。
 */
export function recordCatalogVerification(task, record) {
  writeJson(path.join(taskDir(task), 'catalog.json'), record);
  return record;
}

export function loadCatalogVerification(task) {
  return readJson(path.join(taskDir(task), 'catalog.json'), null);
}

/**
 * 记下"这个任务已经往 ERP 发过写入"。
 *
 * 这是 erpWriteState 的**唯一**写入方。它必须在第一次副作用**之前**调用 ——
 * 顺序反过来就会出现"写进去了但没记下"的窗口，而那正是这套设计最怕的状态：
 * 发票可能已经被 ERP 消耗，任务却看起来干干净净，于是同一批材料可以再报一次。
 * 反过来"记下了但没写成"是安全的一侧：代价只是这批发票要靠只读对账来解锁。
 *
 * 时间戳只取第一次：后面的命令可以细化状态（dispatched -> saved），
 * 但"什么时候第一次碰的 ERP"是不会变的事实。
 */
export function recordErpWrite(task, state) {
  const idx = loadIndex();
  const i = idx.tasks.findIndex((t) => t.taskId === task.taskId);
  if (i < 0) throw new Error(`没有这个任务 ${task.taskId}`);
  const prev = idx.tasks[i];
  const updated = { ...prev, erpWriteState: state,
    erpWriteAt: prev.erpWriteAt ?? new Date().toISOString() };
  idx.tasks[i] = updated;
  writeJson(indexPath(), idx);
  writeJson(path.join(taskDir(updated), 'meta.json'), updated);
  return updated;
}

/**
 * 追加一条 ERP 动作尝试记录（目前只有只读对账这一种）。
 *
 * **只追加，不改写、不清理**：一次对账的判断依据必须能在事后原样复原，
 * 而"上一次读到什么"恰恰是判断这次读数可不可信的东西。
 * 记的是脱敏的事实（分、行数、中断点、处置），不是页面副本。
 */
export function recordErpAttempt(task, attempt) {
  const file = path.join(taskDir(task), 'erp-attempts.json');
  const log = readJson(file, { attempts: [] });
  log.attempts.push(attempt);
  writeJson(file, log);
  return { file, count: log.attempts.length };
}

export function loadErpAttempts(task) {
  return readJson(path.join(taskDir(task), 'erp-attempts.json'), { attempts: [] });
}
