/**
 * 采集观测。这里是**唯一**碰文件系统、CDP 和时钟的地方，判定在 state.mjs 里。
 *
 * 这样分开，是为了让状态判定的测试能在一台没有 Chrome 的机器上跑完 ——
 * 采集这一侧本来就只能在真机上验，把判断混进来就等于把判断也搬上真机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';
import { SCHEMA_VERSION } from './state.mjs';
import * as chrome from './chrome.mjs';
import { probeIdentity } from './probe.mjs';
import { readBinding } from './binding.mjs';
import { takeInventory, intakeOpenItems } from './inventory.mjs';
import { classifyInventory, classifyOpenItems } from './classify.mjs';
import { buildWorkOrder, pendingConfirmations } from './vision.mjs';
import { openDisputes } from './dispute.mjs';
import { findLiveTaskForSource, sourceKeyOf, taskDir, classificationRecorded } from './workspace.mjs';
import { crossTaskDuplicates, historyOpenItems } from './history.mjs';

/**
 * 数据目录的格式版本。没有这个文件就是这个内核自己写的那一版。
 * 现在还没有谁写它 —— 把 `schemaVersion` 正式定为 1 并落盘是批次 6 的事，
 * 在那之前 `schema_too_new` 只会在未来某一版写了这个文件之后才可能出现。
 */
export function readSchemaVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(paths.root, 'schema.json'), 'utf8'));
    return Number(v.schemaVersion) || SCHEMA_VERSION;
  } catch {
    return SCHEMA_VERSION;
  }
}

/**
 * 采一次环境观测（state-machine.md A 表要的全部事实）。
 *
 * Chrome 没起来就不探针：探针要等页面加载，最长 30 秒，而这时候答案已经定了
 * —— 先把 Chrome 起来。这不是优化，是不让用户为一个已知的结论等半分钟。
 */
export async function observeEnvironment() {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  const cdpUp = !!(await chrome.version());
  return {
    schemaVersion: readSchemaVersion(),
    nodeVersion: process.versions.node,
    nodeMajor,
    cdpUp,
    probe: cdpUp ? await probeIdentity() : null,
    binding: readBinding(),
  };
}

/**
 * 采一次任务观测（state-machine.md B 表这一段要的事实）。
 *
 * 三件事在这里定下来，判定那一侧一件都不重做：
 *
 *  1. **盘点是现盘的**。每次都重新走一遍材料目录、重新算内容哈希 ——
 *     材料版本因此永远是「此刻目录里是什么」。用户加一个文件、换一个文件，
 *     下一次 `next` 内核自己就发现盘点过期了；不靠模型记得说一声，也不留缓存，
 *     缓存正是「没发现材料变了」的来源。
 *  2. **分类是现算的**。落盘的那份是账本，但拿账本判开放项会漏掉刚交上来的读数
 *     —— 账本记的是上一次 `classify` 时的世界。所以开放项现算，
 *     `classify_pending` 只看账本在不在。
 *  3. **这里不写盘**。观测改变被观测的东西，幂等就无从谈起：写盘的是 `step.argv`
 *     里那条命令，不是问一句「现在该做什么」。
 */
export async function observeTask(sourceDir) {
  const dir = path.resolve(sourceDir);
  const inventory = await takeInventory(dir);
  const task = findLiveTaskForSource(sourceKeyOf(dir));

  // 没有任务时 currentVersionId 无从比起 —— 那是 task_none，不是盘点过期。
  const inventoryStale = !!task && task.currentVersionId !== inventory.versionId;
  const classification = classifyInventory(dir, inventory, task);
  // 跨任务查重：拿发票身份去比对本机上别的任务还占着的票。只读别的任务落盘的摘要，
  // 一个字都不往回写。没有任务时无从比起（本任务自己都还没有身份摘要）。
  const history = task ? crossTaskDuplicates(task, classification) : null;

  return {
    taskObserved: true,
    sourceDir: dir,
    task: task ? {
      taskId: task.taskId,
      sourceLabel: task.sourceLabel,
      workspace: taskDir(task),
      currentVersionId: task.currentVersionId,
      erpWriteState: task.erpWriteState ?? null,
    } : null,
    inventoryVersionId: inventory.versionId,
    materialCount: inventory.materials.length,
    inventoryStale,
    classificationRecorded: task && !inventoryStale
      ? classificationRecorded(task, inventory.versionId)
      : false,
    openItems: [
      ...intakeOpenItems(inventory),
      ...classifyOpenItems(classification),
      ...(history ? historyOpenItems(history) : []),
    ],
    // 还没读、或者读过但字节已经变了的图。已确认的读数会被投影成解析结果，不在这里出现。
    // 被驳回过的那几张也在里面，各自带着上次没过的理由 —— 那是重读唯一有用的输入。
    pendingImages: task
      ? buildWorkOrder(dir, inventory, classification, task).filter((i) => !i.alreadyRead)
      : [],
    // 读过、还没被用户过目的读数。它是终端那张定宽表格的全部内容。
    pendingReadings: task ? pendingConfirmations(task, inventory) : [],
    // 用户指了错、还没收场的那几份。证据链、重读结果、守恒缺口都在里面 ——
    // 摆给用户看的每一句话都从这里取，模型不补一个字。
    pendingDisputes: task ? openDisputes(task, inventory, dir) : [],
  };
}
