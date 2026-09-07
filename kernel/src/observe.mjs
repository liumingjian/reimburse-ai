/**
 * 采集观测。这里是**唯一**碰文件系统、CDP 和时钟的地方，判定在 state.mjs 里。
 *
 * 这样分开，是为了让状态判定的测试能在一台没有 Chrome 的机器上跑完 ——
 * 采集这一侧本来就只能在真机上验，把判断混进来就等于把判断也搬上真机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, SCHEMA_FILE } from './paths.mjs';
import { SCHEMA_VERSION } from './state.mjs';
import * as chrome from './chrome.mjs';
import { probeIdentity } from './probe.mjs';
import { readBinding } from './binding.mjs';
import { takeInventory, intakeOpenItems } from './inventory.mjs';
import { classifyInventory, classifyOpenItems } from './classify.mjs';
import { buildWorkOrder, pendingConfirmations } from './vision.mjs';
import { openDisputes } from './dispute.mjs';
import { findLiveTaskForSource, sourceKeyOf, taskDir, classificationRecorded,
  loadEventsLedger, loadCatalogVerification } from './workspace.mjs';
import { crossTaskDuplicates, historyOpenItems } from './history.mjs';
import { buildEvents, eventOpenItems, ALLOCATION_KINDS } from './events.mjs';
import { allocationRound, givenUpOpenItems } from './allocate.mjs';
import { loadSelection, applySelection, linesDigest, sameBasis } from './selection.mjs';
import { loadWriteApproval, approvalCovers } from './erpwrite.mjs';

/**
 * 数据目录的格式版本。没有这个文件就是这个内核自己写的那一版 ——
 * 1.0.0 之前的数据目录里没有它，而那些目录装的就是第 1 版的格式。
 */
export function readSchemaVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(paths.root, SCHEMA_FILE), 'utf8'));
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

  const obs = {
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

  // ERP 这半段（划事件、分摊、项目、核对、写入前确认）只在材料那一段全清之后才采。
  //
  // 不是省事，是**不抢答**：还有图没读、有读数没过目时，此刻的分流结果里
  // 那几张票根本还没有金额，硬去划事件只会得出"一个费用事件都构不成"，
  // 而那句话会盖在"该看图了"前面 —— 用户看到的是一个假的死路。
  const settled = !!task && !inventoryStale && obs.classificationRecorded
    && !obs.openItems.some((i) => i.blocking)
    && !obs.pendingImages.length && !obs.pendingReadings.length && !obs.pendingDisputes.length;
  if (!settled) return obs;

  return { ...obs, ...observeErpHalf(task, classification, obs.openItems) };
}

/**
 * 主干后半段的观测：事件划分、逐段分摊、项目归属、ERP 只读核对、写入前的点头。
 *
 * 每一样都是**现算的**（`buildEvents` / `applySelection` 都是纯函数），
 * 落盘的那几份只用来回答两个问题：这一版的账本记过没有（`events_pending`），
 * 以及用户是不是对**现在这一份内容**点过头。现算的东西不拿来判"记过没有"，
 * 落盘的东西不拿来当"现在是什么样" —— 两边搞反，账本就永远缺一版，
 * 或者旧结论会套在新材料上。
 */
function observeErpHalf(task, classification, materialItems) {
  const built = buildEvents(classification, task);
  const ledger = loadEventsLedger(task, built.versionId);

  // 待分摊的那几张票。用户明说"认不出"的不再问，改成一条待办 ——
  // 一直问下去只会让他随口报一个凑得平的数。
  const allocationNotes = built.notes.filter((n) => ALLOCATION_KINDS.has(n.kind));
  const givenUp = givenUpOpenItems(task, allocationNotes);
  const gaveUpIds = new Set(givenUp.map((g) => g.materialId));
  const stillAsking = allocationNotes.filter((n) => !gaveUpIds.has(n.materialId));

  const selection = loadSelection(task);
  const catalog = loadCatalogVerification(task);
  const applied = applySelection(built, classification, selection, catalog);
  // 「还没做选择」和「选择过期了」不是待办，它们就是 project_unassigned 本身；
  // 费用类别推不出来那几条才是要人处置的待办。
  const OWN = new Set(['task_selection_required', 'task_selection_stale']);

  const preview = { lines: applied.lines, homeCity: applied.homeCity,
    purpose: selection?.purpose ?? null, versionId: built.versionId };

  return {
    events: built,
    eventCount: built.events.length,
    // 账本要既在这一版上，又对得上现在这批明细：用户补了一次分摊，明细从一行变成三行，
    // 版本号一动不动，而账本记的还是那一行。
    eventsRecorded: !!ledger && ledger.versionId === built.versionId
      && linesDigest(ledger) === linesDigest(built),
    // 事件层的待办（证据归属不唯一、没有费用发生日期、一个事件都构不成）
    // 和选择层推不出费用类别的那几条，一起并进材料待办 —— 它们的收场都在用户那一侧。
    openItems: [
      // 材料那一段的待办原样留着（不拦路的那几条也在里面），后半段的接在后面。
      ...materialItems,
      ...eventOpenItems(built).filter((i) => !ALLOCATION_KINDS.has(i.kind)),
      ...givenUp,
      ...applied.notes.filter((n) => !OWN.has(n.kind)),
    ],
    allocationRound: allocationRound(task, stillAsking),
    selectionApplied: applied.applied,
    lines: applied.lines,
    homeCity: applied.homeCity,
    purpose: selection?.purpose ?? null,
    // 核对记录也钉在这批明细上。过期的记录等于没核对过 —— 不是"上次是好的"。
    catalogFresh: sameBasis(catalog, built),
    catalogProblems: sameBasis(catalog, built) ? (catalog.problems ?? []) : [],
    catalogCheckedAt: sameBasis(catalog, built) ? (catalog.verifiedAt ?? null) : null,
    writePreview: preview,
    writeApproved: approvalCovers(loadWriteApproval(task), preview),
  };
}

/**
 * 收下用户在终端上说的话时，要重算的那一份后半段观测。
 *
 * 和 `observeTask` 用的是**同一个** `observeErpHalf`，不是另抄一份：
 * 问出去的那份内容和收回来时核对的那份内容，必须由同一段代码算出来 ——
 * 各算各的，两边迟早会错开，而错开的样子是"用户点的头落在另一份内容上"。
 */
export async function erpSnapshot(sourceDir, task) {
  const dir = path.resolve(sourceDir);
  const inventory = await takeInventory(dir);
  const classification = classifyInventory(dir, inventory, task);
  return { inventory, classification, ...observeErpHalf(task, classification, []) };
}
