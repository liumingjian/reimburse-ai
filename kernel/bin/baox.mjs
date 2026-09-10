#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { paths, ensureDir, migrateOnStartup, ensureSchemaVersionFile } from '../src/paths.mjs';
import * as chrome from '../src/chrome.mjs';
import { probeIdentity, ERP_ORIGIN } from '../src/probe.mjs';
// 本地页面只剩两处：重新绑定身份，和浏览完整项目目录。读数确认在终端上
// （`confirm_table`），逐段分摊在终端上（`ask_user`），通用单选页整个下线了。
import { serveTaskSelection, serveIdentityConfirmation } from '../src/serve.mjs';
import { buildWorkOrder, ingestReadings, pendingConfirmations,
  READING_VERSION, DOC_TYPES } from '../src/vision.mjs';
import { applyTerminalVerdict } from '../src/confirm.mjs';
import { takeInventory, intakeOpenItems } from '../src/inventory.mjs';
import { classifyInventory, classifyOpenItems, summarize } from '../src/classify.mjs';
import { buildEvents, eventOpenItems, reconcile } from '../src/events.mjs';
import { loadSelection, submitSelection, applySelection, linesDigest } from '../src/selection.mjs';
import { CATEGORIES } from '../src/categories.mjs';
import { findLiveTaskForSource, createTask, recordInventory, recordClassification,
  recordEvents, recordInvoiceSightings, abandonTask, loadIndex,
  sourceKeyOf, taskDir , recordCatalogVerification, loadCatalogVerification,
  recordErpAttempt, recordErpWrite, liveTasks, archiveMigratedTasks } from '../src/workspace.mjs';
import { crossTaskDuplicates, historyOpenItems, holdsInvoices } from '../src/history.mjs';
import { authorizedPage, verifyExpenseItems, verifyProject, PROJECT_FORM } from '../src/erpcatalog.mjs';
import { openSession, formTabs, sectionAnchors, showSection, readGrid, headerField,
  writeHeader, writeCell, selectOption, cellTarget, cellMatches, leaveEdit } from '../src/erpform.mjs';
import { readReconciliation, classifyReconciliation, attemptRecord } from '../src/erpreconcile.mjs';
import { gateIdentity, readBinding, writeBinding, bindingVerdict } from '../src/binding.mjs';
import { observeEnvironment, observeTask } from '../src/observe.mjs';
import { nextResponse } from '../src/next.mjs';
import { ingestReread, autoSettleAgreed } from '../src/dispute.mjs';
import { SCHEMA_VERSION as NEXT_SCHEMA_VERSION } from '../src/state.mjs';
import { currentSourceKey, currentSourceDir, currentIssuedArgv } from '../src/steptoken.mjs';
import { guardVerdict, refusalPayload, recordRefusal } from '../src/guard.mjs';
import { resetHome } from '../src/reset.mjs';

// 退出码是给 Skill 用的确定性信号：
//   0 完成   1 内核出错   2 硬阻塞（内核拒绝继续，任何"确认继续"都不能绕过）
const OK = 0, ERR = 1, BLOCKED = 2;

// 数据目录搬家的结果。搬完要在这条命令的输出里说一句迁到哪了 —— 用户的报销记录
// 换了地方而没人告诉他，比不搬还糟。
let migrated = null;

const out = (obj, code = OK) => {
  process.stdout.write(JSON.stringify(migrated ? { ...obj, migrated } : obj, null, 2) + '\n');
  process.exit(code);
};

// 搬家（0.9.x 的 ~/Library/Application Support/baox 之类 -> ~/.baox）在任何命令之前做掉，
// 而且只做一次。这里在 out 之后、命令之前，因为它必须在下面那个 try 之外跑：数据目录
// 都还没定下来的时候，任何命令都无从谈起。
// 搬不动就硬停：继续跑等于在一个空的新目录里从头开始，而用户的任务还在旧目录里 ——
// 那是一种看起来正常、实则丢了全部历史的失败，比直接停住坏得多。
try {
  migrated = process.argv[2] === 'reset' ? null : migrateOnStartup();
  if (migrated) {
    // 搬完立刻把 0.9.x 的在途任务标记成存档，理由见 workspace.mjs 的 archiveMigratedTasks。
    // 就在这一次说清楚：那些任务不会接着往下走，同一个目录下次是从头开始的新任务。
    const archived = archiveMigratedTasks();
    if (archived.length) {
      migrated = { ...migrated, archivedTasks: archived.map((t) => t.taskId),
        note: `${archived.length} 个 0.9.x 的在途任务已存档：它们的读数没有本版要求的看图凭据，`
          + '不会被接着往下走；材料和记录一份没动，同一个材料目录下次会新建任务重走一遍。'
          + '它们仍然占着自己那些发票（跨任务查重看得见），确认不再报销可以逐个作废。' };
    }
  }
} catch (err) {
  out({ command: process.argv[2] ?? null, status: 'migration_failed', error: err.message,
    hint: `把旧数据目录整份拷到 ${paths.root} 之后重试；旧目录没有被动过。` }, BLOCKED);
}

// 这份内核自己的根目录和版本号。内核就地运行，所以这就是唯一的那一份；
// 版本号要出现在每一次体检里，否则试用者报回来的问题钉不到具体哪一版。
const SELF = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const VERSION = (() => {
  try { return fs.readFileSync(path.join(SELF, 'VERSION'), 'utf8').trim() || null; } catch { return null; }
})();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const has = (name) => process.argv.includes(`--${name}`);

const yuan = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));

/**
 * 盘点 -> 分流。后面每一层都要站在一次确定的分流结果上，所以统一走这里。
 * 任一层还有硬阻塞就把阻塞原样带回去，不往下算。
 */
async function upToClassification(dir) {
  const inventory = await takeInventory(dir);
  const existing = findLiveTaskForSource(sourceKeyOf(dir));
  const task = existing ?? createTask(dir);
  const rec = recordInventory(task, inventory);

  const intakeItems = intakeOpenItems(inventory);
  if (intakeItems.some((i) => i.blocking)) {
    return { blocked: { stage: 'intake', openItems: intakeItems, readyForNextStep: false,
      task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
      note: '材料盘点还有未清的待确认项，先处理它们' } };
  }
  const classification = classifyInventory(dir, inventory, rec.task);
  recordClassification(rec.task, classification);
  const classifyItems = classifyOpenItems(classification);
  if (classifyItems.some((i) => i.blocking)) {
    return { blocked: { stage: 'classify', openItems: classifyItems, readyForNextStep: false,
      task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
      note: '材料分流与解析还有未清的待确认项，先处理它们再谈费用事件' } };
  }

  // 发票身份齐了才谈得上跨任务比对，所以这一层排在分流之后。
  recordInvoiceSightings(rec.task, classification);
  const history = crossTaskDuplicates(rec.task, classification);
  const historyItems = historyOpenItems(history);
  if (historyItems.some((i) => i.blocking)) {
    return { task: rec.task, inventory, classification, history, historyItems,
      blocked: { stage: 'history', openItems: historyItems, readyForNextStep: false,
        task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
        note: '有发票同时躺在另一个报销任务里；同一张发票不能报两次' } };
  }
  return { task: rec.task, inventory, classification, history, historyItems, blocked: null };
}

/**
 * 盘点 -> 分流 -> 费用事件。任务选择这一层必须站在一批**已经确认干净**的候选明细上：
 * 材料整理还有硬阻塞就不能打开任务选择页（设计共识第四节）。
 */
async function upToEvents(dir) {
  const up = await upToClassification(dir);
  if (up.blocked) return up;
  const built = buildEvents(up.classification, up.task);
  recordEvents(up.task, built);
  const items = eventOpenItems(built);
  if (items.some((i) => i.blocking)) {
    return { blocked: { stage: 'events', openItems: items.filter((i) => i.blocking), readyForNextStep: false,
      task: { taskId: up.task.taskId, workspace: taskDir(up.task) },
      note: '费用事件这一层还有硬阻塞，材料整理没确认完，不能进入任务选择' } };
  }
  return { ...up, built, blocked: null };
}

const [, , cmd] = process.argv;

// —— 模型不拼命令 ——
// 模型敲得动的只有两样：`next`，和内核**刚刚**放进 `step.argv` 的那一条命令行。
// 其余子命令在检测到自己被 Agent 调起时当场拒绝；它们仍然留着给人手敲排障
// （末尾加 --i-am-a-human），只是模型自己拼不出来。判据和措辞都在 guard.mjs 里。
//
// 这一段必须在 switch 之前、在任何**命令**副作用之前：拒绝一条命令的意义在于它
// **没有跑过**，跑到一半再拒等于没拒。（数据目录迁移在它上面就做掉了，那一步与
// 敲的是哪条命令无关。）
{
  const verdict = guardVerdict({ cmd, argv: process.argv.slice(2), env: process.env,
    issuedArgv: currentIssuedArgv() });
  if (!verdict.allowed) {
    recordRefusal({ cmd, markers: verdict.markers, logsDir: paths.logs });
    out(refusalPayload({ cmd, markers: verdict.markers, reason: verdict.reason }), BLOCKED);
  }
}

// 数据格式版本落盘。没有这个文件的目录（0.9.x 迁过来的，或者刚建的）就是这一版写的，
// 补一份 schema.json；已经有了就一个字都不动 —— 里面写着 2 的目录是未来某一版的，
// 把它改回 1 等于让 schema_too_new 这道闸永远不触发。
if (cmd !== 'reset') ensureSchemaVersionFile();

try {
  switch (cmd) {
    case 'reset': {
      const result = await resetHome(paths.root);
      out({ command: 'reset', ...result }, result.status === 'reset' ? OK : BLOCKED);
    }

    case 'doctor': {
      const [major] = process.versions.node.split('.').map(Number);
      const checks = {
        node: { value: process.versions.node, ok: major >= 21,
          hint: major >= 21 ? null : '内核用 Node 内建的全局 WebSocket 走 CDP，需要 Node 21 及以上' },
        chrome: { value: chrome.findChrome(), ok: !!chrome.findChrome(), hint: chrome.findChrome() ? null : '未找到 Chrome' },
        dataDir: { value: paths.root, ok: true },
        cdp: { value: chrome.CDP_PORT, ok: !!(await chrome.version()), hint: '专用 Chrome 未在运行；跑 baox chrome-up' },
      };
      ensureDir(paths.root);
      out({ command: 'doctor', version: VERSION, platform: process.platform, checks,
        ready: checks.node.ok && checks.chrome.ok }, checks.node.ok && checks.chrome.ok ? OK : ERR);
    }

    case 'chrome-up': {
      const info = await chrome.launch({ openUrl: arg('url', `${ERP_ORIGIN}/k3cloud/html5/index.aspx`) });
      out({ command: 'chrome-up', ...info, profile: paths.chromeProfile,
        note: '这是 baox 专用的 Chrome 实例和独立 profile，和你日常那个 Chrome 互不影响；请在这个窗口里用你本人的账号登录 ERP' });
    }

    case 'probe': {
      // 会话 + 个人绑定，一次判完。只有 matched 放行 —— 「有人登录着」从来不是
      // 「该报销的那个人登录着」。
      const r = await gateIdentity();
      out({ command: 'probe', ...r }, r.status === 'matched' ? OK : BLOCKED);
    }

    case 'confirm-identity': {
      // 个人绑定进入系统的唯一通道。页面上的每个值都是内核刚从 ERP 读到的，
      // 用户只能认或不认；对话里说「是我」不算数。
      const probe = await probeIdentity();
      if (probe.status !== 'matched') {
        out({ command: 'confirm-identity', ...probe,
          note: '读不出当前登录身份，没有可确认的东西；先在专用 Chrome 里登录 ERP' }, BLOCKED);
      }
      const previous = readBinding();
      const verdict = bindingVerdict(previous, probe.identity);
      if (verdict === 'incomplete') {
        out({ command: 'confirm-identity', status: 'identity_incomplete', identity: probe.identity,
          hint: 'ERP 页面上读不出登录账号或账套，绑不出一个可比的身份；请重新登录一次再试' }, BLOCKED);
      }
      if (verdict === 'matched') {
        out({ command: 'confirm-identity', status: 'already_confirmed', binding: previous,
          note: '这台机器已经绑定在当前登录的这个身份上，不需要再确认' });
      }
      if (verdict === 'mismatched') {
        // 改绑只在手上没活的时候允许。进行中的任务里，上半程的材料是按原来那个人
        // 记的，中途换人等于把一份报销记在两个人头上。
        const live = liveTasks();
        if (live.length > 0) {
          out({ command: 'confirm-identity', status: 'rebind_blocked', binding: previous,
            identity: probe.identity,
            liveTasks: live.map((t) => ({ taskId: t.taskId, sourceLabel: t.sourceLabel,
              erpWriteState: t.erpWriteState ?? null })),
            hint: `这台机器绑定的是 ${previous.displayName ?? previous.account}，当前登录的是 `
              + `${probe.identity.displayName}，而且还有 ${live.length} 个进行中的任务。`
              + '进行中的任务不能中途换人：先把它们走完或作废（baox abandon-task），再来改绑' }, BLOCKED);
        }
      }
      const r = await serveIdentityConfirmation(
        { identity: probe.identity, previous: verdict === 'mismatched' ? previous : null },
        { timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
          onReady: (u) => process.stderr.write(`已在浏览器里打开页面（确认报销人身份）；没弹出就手动打开：${u}\n`) });
      if (r.status !== 'submitted') {
        out({ command: 'confirm-identity', ...r,
          note: '没有收到确认，身份没有绑定；重跑一次这条命令' }, ERR);
      }
      const binding = writeBinding(probe.identity);
      out({ command: 'confirm-identity', status: 'confirmed', binding, replaced: previous,
        note: '这台机器上的 baox 从现在起只替这个身份报销' });
    }

    case 'erp-read': {
      // 只读回读费用报销单页面：单据页签是新增还是修改、明细网格和收票网格各是什么。
      // 保存后置条件要靠它，所以它自己必须一点副作用都没有。
      const gate = await authorizedPage();
      if (!gate.ok) {
        out({ command: 'erp-read', identity: gate.probe,
          note: '身份没核对通过，不读 ERP 页面' }, BLOCKED);
      }
      const session = await openSession(gate.wsUrl);
      try {
        const tabs = await formTabs(session);
        if (tabs.length === 0) {
          out({ command: 'erp-read', formOpen: false, anchors: await sectionAnchors(session),
            note: '页面上没有打开的费用报销单（既没有"新增"也没有"修改"页签）' }, BLOCKED);
        }
        // 明细是懒渲染的，不点出来网格根本不在 DOM 里。
        const shown = await showSection(session, '明细信息');
        const detail = await readGrid(session, 0);
        const receipts = await readGrid(session, 1);
        out({
          command: 'erp-read',
          formOpen: true,
          formMode: tabs[0].mode,
          formTabs: tabs.map((t) => t.label),
          sectionShown: shown.ok ? shown.anchor.label : shown.reason,
          detail,
          receipts,
          note: '只读回读，没有点击任何值控件、没有写入、没有保存',
        }, OK);
      } finally {
        session.close();
      }
    }

    case 'erp-reconcile': {
      // ERP 对账：四项只读读数 -> 一个对账中断点 -> 两种处置之一。
      // 这里是一层薄壳，判定在 erpreconcile.mjs 里（那是纯函数，能不开浏览器测）。
      //
      // 退出码：`转人工` -> 2（硬阻塞，任何"确认继续"都不能绕过）；其余 -> 0。
      // 这里的 0 **不表示"可以继续写 ERP"**，它只表示对账本身完成了。
      const gate = await authorizedPage();
      if (!gate.ok) {
        out({ command: 'erp-reconcile', identity: gate.probe,
          note: '身份没核对通过，不读 ERP 页面' }, BLOCKED);
      }
      const session = await openSession(gate.wsUrl);
      let readings;
      try {
        readings = await readReconciliation(session);
      } finally {
        session.close();
      }
      const verdict = classifyReconciliation(readings);

      // 审计落在这个目录对应的进行中任务上。没给 --dir 或者找不到任务时照常给结论，
      // 但要如实说这次对账没有落审计 —— 不能让"没记上"看起来像"记上了"。
      let audit = { recorded: false, note: '没有给 --dir，这次对账没有落进任何任务的审计清单' };
      const dir = arg('dir');
      if (dir) {
        const task = findLiveTaskForSource(sourceKeyOf(dir));
        if (task) {
          const rec = recordErpAttempt(task, attemptRecord({ ...verdict, readings }));
          audit = { recorded: true, taskId: task.taskId, attemptCount: rec.count };
        } else {
          audit = { recorded: false, note: '这个目录没有进行中的任务，这次对账没有落审计' };
        }
      }

      out({
        command: 'erp-reconcile',
        bucket: verdict.bucket,
        action: verdict.action,
        identity: verdict.identity,
        reasons: verdict.reasons,
        readings,
        audit,
        note: '只读对账：没有点击、没有滚动、没有导航、没有写入，也没有保存',
      }, verdict.action === '转人工' ? BLOCKED : OK);
    }

    case 'erp-fill': {
      // 写入通道的排练：按 save-contract 的稳定顺序往**新增**单上填字段，逐项回读，
      // **不保存**（这个分支里一行保存代码都没有）。不消耗发票，可以反复跑。
      //
      // 值一律从命令行显式给出。内核不从任何地方推断金额或事由 ——
      // 排练用的是什么值，必须是调用方写下来的。
      if (!has('rehearse')) {
        out({ command: 'erp-fill', wrote: false,
          note: '这条命令会往 ERP 页面真实写入字段，必须显式带 --rehearse；它仍然不会保存' }, BLOCKED);
      }
      // 会写 ERP 的命令一律必须绑定到一个任务。没有任务就没有地方记下"这批发票动过 ERP"，
      // 而记不下就等于这批发票可以在另一个任务里再报一次 —— 那是这套设计要防的头号错误。
      const fillDir = arg('dir');
      if (!fillDir) {
        out({ command: 'erp-fill', wrote: false,
          error: '缺少 --dir <材料目录>：会写 ERP 的命令必须绑定到一个任务，否则这次写入没有地方记' }, ERR);
      }
      const fillTask = findLiveTaskForSource(sourceKeyOf(fillDir));
      if (!fillTask) {
        out({ command: 'erp-fill', wrote: false,
          error: '这个目录没有进行中的报销任务，先跑 intake' }, ERR);
      }
      const gate = await authorizedPage();
      if (!gate.ok) {
        out({ command: 'erp-fill', wrote: false, identity: gate.probe,
          note: '身份没核对通过，不碰 ERP 页面' }, BLOCKED);
      }
      const session = await openSession(gate.wsUrl);
      try {
        const tabs = await formTabs(session);
        if (tabs.length === 0) {
          out({ command: 'erp-fill', wrote: false, formOpen: false,
            note: '页面上没有打开的费用报销单，无处可填' }, BLOCKED);
        }
        // 只往"新增"单上写。页签是"修改"意味着这是一张**已经存在的**单据，
        // 改它就越过了 v1 的权限上限（上限是保存草稿，不含修改既有单据）。
        if (tabs[0].mode !== 'new') {
          out({ command: 'erp-fill', wrote: false, formMode: tabs[0].mode, formTabs: tabs.map((t) => t.label),
            note: '当前页签是"修改"，说明这是一张已存在的单据；排练只在"新增"单上做' }, BLOCKED);
        }
        const shown = await showSection(session, '明细信息');
        if (!shown.ok) {
          out({ command: 'erp-fill', wrote: false, note: shown.reason, anchors: shown.anchors }, BLOCKED);
        }

        const row = Number(arg('row', '0'));
        // F7 列按编码写，回读出来是名称，所以预期回读成什么必须另外有出处：
        // 费用项目的名称取自只读主数据核对（同一份 ERP 事实），项目取项目号后缀。
        // 没有出处就不写 —— 写完只能"看着像对的"，那不算回读通过。
        const expenseCode = arg('expense');
        let catalog = null;
        if (expenseCode) {
          const verified = await verifyExpenseItems(gate.wsUrl);
          catalog = new Map((verified.checked ?? []).map((c) => [c.code, c]));
          const item = catalog.get(expenseCode);
          if (!item || item.verdict !== 'confirmed') {
            out({ command: 'erp-fill', wrote: false, expenseItem: item ?? null,
              note: `费用项目 ${expenseCode} 没有通过 ERP 只读核对，不拿它去写单据` }, BLOCKED);
          }
        }
        const expectOf = (col, value) => {
          if (col === '项目') return { mode: 'endsWith', value: `-${value}` };
          if (col === '费用项目') return { mode: 'equals', value: catalog.get(value).erpName };
          return null;
        };
        // save-contract 的稳定顺序：事由 -> 项目 -> 费用项目 -> 发票类型 -> 先费用金额后税额。
        // 发票类型必须排在金额之前：改发票类型会清空已填的税额。
        const plan = [
          ['header', 'FCAUSA', arg('cause')],
          ['cell', '项目', arg('project')],
          ['cell', '费用项目', arg('expense')],
          ['option', '发票类型', arg('invoice-type')],
          ['cell', '费用金额', arg('amount')],
          ['cell', '税额', arg('tax')],
        ].filter(([, , v]) => v !== null);
        if (plan.length === 0) {
          out({ command: 'erp-fill', wrote: false,
            note: '没有给任何字段值；至少给一个 --cause/--project/--expense/--invoice-type/--amount/--tax' }, ERR);
        }

        // —— 从这里往下开始有副作用，所以标记落在这一行之前 ——
        // 上面每一道闸（身份、页签、明细区、费用项目核对）都是只读的，走到这里才第一次写字段。
        // 记早了会把一次什么都没写成的排练变成永久占用；记晚了会留出"写进去了但没记下"的窗口。
        // 两者不对称：前者的代价是用户多跑一次只读对账，后者的代价是同一批发票被报两次。
        const marked = recordErpWrite(fillTask, 'erp-fill');
        const steps = [];
        // 先把上一轮遗留的税额清零，再写费用金额。
        // 实测：行里已有税额 58.05 时把费用金额改成 50.12，ERP 直接拒收 ——
        // 输入框里明明是 50.12，回车后单元格弹回 644.95，不报任何错。
        // save-contract 的"先费用金额后税额"说的是**干净的行**；
        // 排练要在同一行上反复跑，就得自己把这个前提补齐。
        if (arg('amount')) {
          const tax = await cellTarget(session, { which: 0, row, column: '税额', scroll: false });
          const current = tax.ok ? String(tax.text).replace(/[¥￥,\s]/g, '') : '';
          if (current !== '' && Number(current) !== 0) {
            const z = await writeCell(session, { which: 0, row, column: '税额', value: '0.00' });
            steps.push({ kind: 'cell', target: '税额（清零）', ...z });
          }
        }
        for (const [kind, target, value] of plan) {
          const r = kind === 'header' ? await writeHeader(session, target, value)
            : kind === 'option' ? await selectOption(session, { which: 0, row, column: target, option: value })
            : await writeCell(session, { which: 0, row, column: target, value,
                expect: expectOf(target, value) });
          steps.push({ kind, target, ...r });
          // 结构性失败就停：连编辑器都没拿到、格子滚不进视口、网格错位 ——
          // 后面的顺序是按前面已经生效算的，接着填只会掩盖问题。
          // 但"当场没回读到"不算结构性失败：最后写的那一格编辑器还开着，
          // 文本本来就是空的，成败由最终整行回读来判。
          if (r.after === null || r.after === undefined) break;
        }

        // 回读之前先让明细行离开编辑态：编辑态的单元格读出来是空的，
        // 那会把写成功了的字段误报成没写进去。
        const left = await leaveEdit(session);
        const detail = await readGrid(session, 0);
        const receipts = await readGrid(session, 1);

        // 最终判据取自**离开编辑态之后**的整行回读，不取每一步当场的轮询。
        // 当场轮询读的是还开着编辑器的单元格，最后写的那一格文本是空的 ——
        // 值明明进去了却报成没写进去。逐步结果留作诊断，成败看这一行。
        const finalRow = detail.ok ? detail.rows.find((r) => r.kind === 'data') : null;
        const header = await headerField(session, 'FCAUSA');
        const checks = plan.map(([kind, target, value]) => {
          const got = kind === 'header'
            ? (header.ok ? header.value : null)
            : (finalRow ? (finalRow.values[target] ?? '') : null);
          const expect = kind === 'cell' ? expectOf(target, value) : null;
          return { target, want: value, got,
            ok: got !== null && got !== '' && cellMatches(got, value, expect) };
        });
        const failed = checks.filter((c) => !c.ok);
        out({
          command: 'erp-fill',
          wrote: true,
          task: { taskId: marked.taskId, erpWriteState: marked.erpWriteState,
            erpWriteAt: marked.erpWriteAt, workspace: taskDir(marked) },
          formMode: tabs[0].mode,
          steps,
          checks,
          leftEditMode: left.ok ? !left.stillEditing : left.reason,
          detail,
          receipts,
          note: failed.length === 0
            ? '全部字段都写入并逐项回读通过；没有保存，这张单还是未保存的新增单'
            : `这些字段最终回读没通过：${failed.map((f) => f.target).join('、')}；没有保存`,
        }, failed.length === 0 ? OK : BLOCKED);
      } finally {
        session.close();
      }
    }

    case 'catalog': {
      // ERP 主数据的只读核对。身份不 matched 就一步都不往下走。
      const gate = await authorizedPage();
      if (!gate.ok) {
        out({ command: 'catalog', verified: false, identity: gate.probe,
          note: '身份没核对通过，不做任何 ERP 查询' }, BLOCKED);
      }

      // 两种用法：--project 核对单个项目号；--dir 核对某个任务已经选好的全部项目。
      const dir = arg('dir');
      const single = arg('project');
      const items = await verifyExpenseItems(gate.wsUrl);

      let ctx = null;
      let wanted = single ? [single] : [];
      if (dir) {
        const up = await upToEvents(dir);
        if (up.blocked) out({ command: 'catalog', ...up.blocked }, BLOCKED);
        const selection = loadSelection(up.task);
        if (!selection) {
          out({ command: 'catalog', verified: false,
            task: { taskId: up.task.taskId, workspace: taskDir(up.task) },
            note: '这个任务还没有做任务选择，没有项目号可核对；先跑 select-task' }, BLOCKED);
        }
        ctx = { task: up.task, built: up.built, selection };
        wanted = [...new Set(Object.values(selection.projects))];
      }

      const results = [];
      for (const n of wanted) results.push(await verifyProject(gate.wsUrl, n));
      const proj = single && !dir ? results[0] : null;

      // 查询本身失败不是"核对通过"，是"没核对成"，一律阻塞。
      const failed = [items, ...results].filter((r) => r && r.ok === false);
      const problems = [
        ...(items.problems ?? []),
        ...results.filter((r) => r.ok && r.verdict !== 'confirmed'),
      ];

      // 查询本身跑通了就落盘，**通过与否一并记下**。
      //
      // 只记通过的那一份会有两个后果，都不好：查无此项目时工作区里什么都没有，
      // 于是"没核对过"和"核对过、不合格"再也分不开 —— 内核只好一遍遍重新核对
      // 同一个不存在的项目号；而用户那一侧，一个硬停的理由会变得没有出处。
      //
      // 记下问题不等于放行：升级项目号来源的判据仍然是**这个号自己**
      // 明确 confirmed（selection.mjs 的 projectSourceOf），一条 missing 记录
      // 升不了任何一行的级。
      if (ctx && failed.length === 0) {
        recordCatalogVerification(ctx.task, {
          linesDigest: linesDigest(ctx.built),
          versionId: ctx.built.versionId,
          verifiedAt: new Date().toISOString(),
          identity: gate.probe.identity,
          projectFormId: PROJECT_FORM,
          projects: Object.fromEntries(results.map((r) => [r.number,
            { verdict: r.verdict, name: r.name ?? null }])),
          problems,
        });
      }

      out({
        command: 'catalog',
        identity: gate.probe.identity,
        verified: failed.length === 0 && problems.length === 0,
        expenseItems: items.ok
          ? { formId: items.formId, checked: items.checked }
          : { error: items.reason },
        project: proj && (proj.ok ? proj : { error: proj.reason }),
        task: ctx ? { taskId: ctx.task.taskId, workspace: taskDir(ctx.task) } : undefined,
        projects: ctx ? results.map((r) => (r.ok
          ? { number: r.number, verdict: r.verdict, name: r.name ?? null }
          : { error: r.reason })) : undefined,
        problems,
        queryFailures: failed.map((f) => f.reason),
        note: '只读核对：只证明主数据在 ERP 目录里存在且可引用，'
          + '不证明它在费用明细上保存得进去 —— 那要靠保存后回读',
      }, failed.length === 0 && problems.length === 0 ? OK : BLOCKED);
    }

    case 'intake': {
      const dir = arg('dir');
      if (!dir) out({ command: 'intake', error: '缺少 --dir <材料目录>' }, ERR);

      const inventory = await takeInventory(dir);
      const key = sourceKeyOf(dir);
      // 同一个目录再次运行时，恢复原任务而不是新建第二个（契约「重复运行与历史材料」）。
      const existing = findLiveTaskForSource(key);
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);

      const items = intakeOpenItems(inventory);
      const blocking = items.filter((i) => i.blocking);
      const byDisposition = {};
      for (const m of inventory.materials) byDisposition[m.disposition] = (byDisposition[m.disposition] ?? 0) + 1;

      out({
        command: 'intake',
        task: { taskId: rec.task.taskId, createdAt: rec.task.createdAt, status: rec.task.status,
          sourceLabel: rec.task.sourceLabel, resumed: !!existing, workspace: taskDir(rec.task) },
        inventory: { versionId: inventory.versionId, takenAt: inventory.takenAt,
          isNewVersion: rec.isNewVersion, supersededVersionId: rec.supersededVersionId,
          versionCount: rec.versionCount,
          materialCount: inventory.materials.length, ignoredCount: inventory.ignored.length,
          byDisposition },
        materials: inventory.materials.map(({ materialId, relPath, format, size, disposition, reason, contentHash }) =>
          ({ materialId, relPath, format, size, disposition, reason, contentHash: contentHash?.slice(0, 16) ?? null })),
        ignored: inventory.ignored,
        openItems: items,
        // 待确认项一条未清就不能进入下一步；这是契约的放行条件，不是建议。
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'classify': {
      const dir = arg('dir');
      if (!dir) out({ command: 'classify', error: '缺少 --dir <材料目录>' }, ERR);

      // 分流永远建立在一个确定的盘点版本之上，所以这里先重新盘一次（幂等）。
      // 盘点层还有硬阻塞时不往下解析：范围外和读不出来的材料先解决，再谈票种。
      const inventory = await takeInventory(dir);
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);

      const intakeItems = intakeOpenItems(inventory);
      const intakeBlocking = intakeItems.filter((i) => i.blocking);
      if (intakeBlocking.length) {
        out({ command: 'classify', stage: 'intake',
          task: { taskId: rec.task.taskId, resumed: !!existing, workspace: taskDir(rec.task) },
          inventory: { versionId: inventory.versionId, materialCount: inventory.materials.length },
          openItems: intakeItems,
          readyForNextStep: false,
          note: '材料盘点还有未清的待确认项，先处理它们再做分流与解析' }, BLOCKED);
      }

      const classification = classifyInventory(dir, inventory, rec.task);
      const file = recordClassification(rec.task, classification);
      recordInvoiceSightings(rec.task, classification);
      // 任务内重复和跨任务重复是两件事，但对用户是同一个问题，所以一次说完。
      const history = crossTaskDuplicates(rec.task, classification);
      const items = [...classifyOpenItems(classification), ...historyOpenItems(history)];
      const blocking = items.filter((i) => i.blocking);
      const byRole = {};
      for (const r of classification.results) {
        if (r.parseStatus === 'skipped') continue;
        byRole[r.role ?? 'unknown'] = (byRole[r.role ?? 'unknown'] ?? 0) + 1;
      }

      out({
        command: 'classify', stage: 'classify',
        task: { taskId: rec.task.taskId, resumed: !!existing, workspace: taskDir(rec.task) },
        inventory: { versionId: inventory.versionId, isNewVersion: rec.isNewVersion,
          supersededVersionId: rec.supersededVersionId, materialCount: inventory.materials.length },
        byRole,
        // 完整发票号码只留在任务工作区文件里，输出一律脱敏 ——
        // 重复分组的 identityKey 里也带着完整号码，这里一并去掉。
        materials: summarize(classification),
        duplicates: classification.duplicates.map(({ identityKey, ...d }) => d),
        crossTaskDuplicates: history.hits,
        historyScope: { scannedTasks: history.scannedTasks, checkedInvoices: history.checkedInvoices,
          coversErpExternalRecords: false },
        openItems: items,
        factsFile: file,
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'ocr-request': {
      // 图片材料的读取工单。内核不做 OCR —— 装本地 OCR 等于要求每台电脑都有它，
      // 而 Claude Code 自带视觉能力。所以这里只负责说清楚"读哪张、要什么、按什么格式回报"。
      const dir = arg('dir');
      if (!dir) out({ command: 'ocr-request', error: '缺少 --dir <材料目录>' }, ERR);
      const inventory = await takeInventory(dir);
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);
      const classification = classifyInventory(dir, inventory, rec.task);
      const items = buildWorkOrder(dir, inventory, classification, rec.task,
        { force: process.argv.includes('--force') });
      const todo = items.filter((i) => !i.alreadyRead);

      out({
        command: 'ocr-request',
        task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
        inventoryVersionId: inventory.versionId,
        submissionFormat: {
          version: READING_VERSION,
          docTypes: Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [k, v.label])),
          note: '逐字抄写票面上看得见的字符。看不清的字段写进 unreadable，不要猜、不要算、不要补全。',
        },
        // 真机试用里模型拿到工单就直接回报"图片显示不出来"——它一次都没打开过。
        next: '用 Read 工具逐个打开下面 items[].absPath 看图；没有打开过就不能说图片读不了，'
          + 'unreadable 说的是"看着的图上认不出这个字段"，不是"没看"。',
        items,
        pendingCount: todo.length,
      }, todo.length ? BLOCKED : OK);
    }

    case 'ocr-submit': {
      const dir = arg('dir');
      const file = arg('file');
      if (!dir || !file) out({ command: 'ocr-submit', error: '缺少 --dir <材料目录> 或 --file <读数 json>' }, ERR);
      const inventory = await takeInventory(dir);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'ocr-submit', error: '这个目录还没有进行中的报销任务，先跑 intake' }, ERR);
      recordInventory(task, inventory);

      const submission = JSON.parse(fs.readFileSync(file, 'utf8'));
      const verdicts = ingestReadings(dir, inventory, task, submission);
      const rejected = verdicts.filter((v) => v.verdict === 'rejected');

      out({
        command: 'ocr-submit',
        task: { taskId: task.taskId, workspace: taskDir(task) },
        verdicts,
        accepted: verdicts.length - rejected.length,
        rejected: rejected.length,
        // 接收成功只是通过了结构校验，还不是已解析值 —— 必须再走一次用户确认。
        note: '通过结构校验的读数已存为字段候选；再问一次 baox next，'
          + '内核会渲染一张定宽表格请用户在终端上过目',
      }, rejected.length ? BLOCKED : OK);
    }

    case 'reread-submit': {
      // 争议里那次**独立重读**的收口。它和 ocr-submit 是两条不同的路：
      // 那条收的是一整张票的读数，这条只收争议里的那一个字段，而且只在
      // 一场还没收场的争议上收得下。
      //
      // 重读回来之后，内核当场判收敛，并且只在一种情形下自己拍板：重读和用户一致 ——
      // 一次不知道用户说了什么的独立重读，读出了和用户一样的值，这是机器能给出的
      // 最强的一种印证。即便如此，接受下来的读数仍然停在**未确认**：
      // 用户还要在整张表上点最后那一下。
      const dir = arg('dir');
      const file = arg('file');
      if (!dir || !file) out({ command: 'reread-submit', error: '缺少 --dir <材料目录> 或 --file <重读 json>' }, ERR);
      const inventory = await takeInventory(dir);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'reread-submit', error: '这个目录还没有进行中的报销任务，先跑 intake' }, ERR);

      const submission = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = ingestReread(dir, inventory, task, submission);
      const settled = result.verdict === 'accepted'
        ? autoSettleAgreed(task, result.materialId,
          inventory.materials.find((m) => m.materialId === result.materialId).contentHash)
        : null;

      out({
        command: 'reread-submit',
        task: { taskId: task.taskId, workspace: taskDir(task) },
        ...result,
        settled,
        note: result.verdict !== 'accepted'
          ? '这次重读没收下，理由见 reasons'
          : settled
            ? '重读和用户一致，这个值已经收下（来源记作 user）；再问一次 baox next，'
              + '内核会把整张读数再摆一次请用户过目'
            : '重读收下了。收敛结果要用户对着原件拍板 —— 再问一次 baox next，'
              + '内核会把两次机器读数和用户的值一起摆出来',
      }, result.verdict === 'accepted' ? OK : BLOCKED);
    }

    case 'confirm-readings': {
      // **只读**。确认这件事从这里搬走了 —— 它现在发生在终端上：内核在
      // `baox next` 里渲染一张定宽表格，用户当面表态，模型带着那一次性凭据回传。
      //
      // 这条命令剩下的用处只有一个：人手敲着看看现在有哪些读数等着确认。
      // 它不写一个字，也不弹页面。留一条能写的旁路，就等于留了第二条确认通道，
      // 而这一票的全部意义就是确认只有一条通道、且那条通道的另一头是人。
      const dir = arg('dir');
      if (!dir) out({ command: 'confirm-readings', error: '缺少 --dir <材料目录>' }, ERR);
      const inventory = await takeInventory(dir);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'confirm-readings', error: '这个目录还没有进行中的报销任务，先跑 intake' }, ERR);

      const pending = pendingConfirmations(task, inventory);
      out({
        command: 'confirm-readings',
        readOnly: true,
        pending: pending.length,
        items: pending,
        note: pending.length
          ? '这些读数等着用户过目。确认只在终端上发生：问一句 baox next，'
            + '内核会把它们渲染成表格；这条命令不确认任何东西'
          : '没有待确认的看图读数',
      }, OK);
    }


    case 'events': {
      // 费用事件与候选明细。永远建立在一次确定的分流结果之上，
      // 所以这里把盘点和分流都重跑一遍（幂等），任一层还有硬阻塞就不往下走。
      const dir = arg('dir');
      if (!dir) out({ command: 'events', error: '缺少 --dir <材料目录>' }, ERR);
      const { task, inventory, classification, blocked } = await upToClassification(dir);
      if (blocked) out({ command: 'events', ...blocked }, BLOCKED);

      const built = buildEvents(classification, task);
      const file = recordEvents(task, built);
      const items = eventOpenItems(built);
      const blocking = items.filter((i) => i.blocking);

      out({
        command: 'events', stage: 'events',
        task: { taskId: task.taskId, workspace: taskDir(task) },
        inventory: { versionId: inventory.versionId },
        eventCount: built.events.length,
        events: built.events.map((e) => ({
          eventId: e.eventId, voucherFileName: e.voucherFileName, kindLabel: e.kindLabel,
          maskedNumber: e.maskedNumber, index: e.index, of: e.of,
          date: e.date ?? null, city: e.city ?? null, route: e.route ?? null,
          dateEvidence: e.dateEvidence ?? null,
          splitBasis: e.splitBasis, splitNote: e.splitNote,
          amountSource: e.amountSource,
          netAmount: yuan(e.amounts.netCents), taxAmount: yuan(e.amounts.taxCents),
          totalAmount: yuan(e.amounts.totalCents),
          // 分位除不尽时余数落在哪一段，如实报出来，不藏。
          residue: e.residueCents ? (e.residueCents / 100).toFixed(2) : null,
          referenceCount: e.referenceMaterialIds.length,
        })),
        lineItems: built.lineItems,
        reconciliation: reconcile(built, classification),
        evidence: built.evidence,
        openItems: items,
        eventsFile: file,
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'select-task': {
      // 项目归属、常驻城市和事由。**只有这个页面上的提交动作能把它们定下来**；
      // 用户在对话里说"项目是 111454"不构成任务选择。
      const dir = arg('dir');
      if (!dir) out({ command: 'select-task', error: '缺少 --dir <材料目录>' }, ERR);
      const { task, built, blocked } = await upToEvents(dir);
      if (blocked) out({ command: 'select-task', ...blocked }, BLOCKED);

      // 上一次的选择只作预填：明细变过了就不再有效，用户仍然要重新看一遍再提交。
      const prev = loadSelection(task);
      const lines = built.lineItems.map((l) => {
        const ev = built.events.find((e) => e.eventId === l.eventId);
        return { lineId: l.lineId, fileName: ev.voucherFileName, kindLabel: ev.kindLabel,
          maskedNumber: l.maskedNumber, date: l.date, city: l.city, route: l.route,
          totalAmount: l.totalAmount, project: prev?.projects?.[l.lineId] ?? '' };
      });

      const result = await serveTaskSelection(
        { lines, homeCity: prev?.homeCity ?? '', purpose: prev?.purpose ?? '' },
        { timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
          onReady: (u) => process.stderr.write(`已在浏览器里打开页面（做任务选择）；没弹出就手动打开：${u}\n`) });
      if (result.status !== 'submitted') out({ command: 'select-task', ...result }, ERR);

      const r = submitSelection(task, built, result);
      if (r.verdict === 'rejected') {
        out({ command: 'select-task', verdict: r.verdict, reasons: r.reasons,
          note: '任务选择没有收下；重新跑 select-task' }, BLOCKED);
      }
      out({ command: 'select-task', verdict: r.verdict,
        homeCity: r.record.homeCity, purpose: r.record.purpose,
        lineCount: Object.keys(r.record.projects).length,
        projectSource: r.record.projectSource,
        note: '项目号来自用户，还没有和 ERP 项目目录核对过；跑 lines 看费用类别推导结果' }, OK);
    }

    case 'lines': {
      // 候选明细的最终形态：费用事实来自材料，费用类别来自内核推导，
      // 项目归属和事由来自任务选择页。三样来源在输出里各自标明，不混。
      const dir = arg('dir');
      if (!dir) out({ command: 'lines', error: '缺少 --dir <材料目录>' }, ERR);
      const { task, classification, built, blocked } = await upToEvents(dir);
      if (blocked) out({ command: 'lines', ...blocked }, BLOCKED);

      const applied = applySelection(built, classification, loadSelection(task), loadCatalogVerification(task));
      const blocking = applied.notes.filter((n) => n.blocking);
      out({
        command: 'lines', stage: 'task_selection',
        task: { taskId: task.taskId, workspace: taskDir(task) },
        selectionApplied: applied.applied,
        homeCity: applied.homeCity,
        lineCount: applied.lines.length,
        lines: applied.lines,
        // 对照表里哪几类有经过验证的 ERP 编码，如实摆出来，别让人以为四类都能落地。
        expenseItemCatalog: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) =>
          [k, { label: v.label, expenseItemCode: v.expenseItemCode, source: v.source ?? null,
            confirmedInErp: v.source === 'erp_save_readback' }])),
        openItems: applied.notes,
        readyForNextStep: blocking.length === 0,
        note: blocking.length === 0
          ? '候选明细已补齐；ERP 上传与保存草稿还没有实现'
          : '候选明细还不能进入 ERP，先处理上面的阻塞',
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'history': {
      // 单独看一眼跨任务重复检查的结果，不往下走。
      const dir = arg('dir');
      if (!dir) out({ command: 'history', error: '缺少 --dir <材料目录>' }, ERR);
      const up = await upToClassification(dir);
      if (up.blocked && up.blocked.stage !== 'history') out({ command: 'history', ...up.blocked }, BLOCKED);

      const blocking = up.historyItems.filter((i) => i.blocking);
      out({
        command: 'history', stage: 'history',
        task: { taskId: up.task.taskId, workspace: taskDir(up.task) },
        hits: up.history.hits,
        scannedTasks: up.history.scannedTasks,
        checkedInvoices: up.history.checkedInvoices,
        openItems: up.historyItems,
        readyForNextStep: blocking.length === 0,
        // 这句话不能省：查过 ≠ 没报过。
        note: 'baox 只查得到自己在本机记过的任务；ERP 里既有的报销记录还查不了',
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'tasks': {
      const tasks = loadIndex().tasks.map((t) => ({
        taskId: t.taskId, status: t.status, createdAt: t.createdAt, sourceLabel: t.sourceLabel,
        erpWriteState: t.erpWriteState ?? null, holdsInvoices: holdsInvoices(t),
        abandonedAt: t.abandonedAt ?? null, workspace: taskDir(t),
      }));
      out({ command: 'tasks', taskCount: tasks.length, tasks });
    }

    case 'abandon-task': {
      // 把一个不打算再报的任务作废，好让它占着的发票能在别的任务里用。
      // 这是状态变更，不是删除：任务工作区一份不动。
      const taskId = arg('task');
      if (!taskId) out({ command: 'abandon-task', error: '缺少 --task <taskId>' }, ERR);
      const r = abandonTask(taskId, arg('reason'));
      if (r.verdict === 'rejected') out({ command: 'abandon-task', ...r }, BLOCKED);
      out({ command: 'abandon-task', verdict: r.verdict,
        task: { taskId: r.task.taskId, status: r.task.status, sourceLabel: r.task.sourceLabel,
          abandonReason: r.task.abandonReason ?? null, workspace: taskDir(r.task) },
        note: '任务已作废，工作区文件原样保留；它原先占用的发票现在可以在别的任务里使用' });
    }

    case 'next': {
      // 模型唯一会敲的命令。问：`next --dir <材料目录>`；答：`next --after <token> [--result <文件>]`。
      // 这里是一层薄壳：采观测（observe）-> 判状态（state）-> 出 step（next），
      // 判断本身一点浏览器和文件系统都不碰，所以能在没有 Chrome 的机器上测。
      // 问得不对就答不了：这两种都不是状态机里的状态（那两张表里没有它们），
      // 而是「这一问根本没法判」，所以走 error + 1，不冒充成一个 step。
      const dir = arg('dir');
      if (dir && !(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
        out({ command: 'next', schemaVersion: NEXT_SCHEMA_VERSION,
          error: `材料目录不存在：${dir}`,
          speak: `我找不到这个材料目录：${dir}。请确认路径写对了，或者把材料放进去再叫我。` }, ERR);
      }
      // 只带 --after 回来时，材料目录从当前步骤的登记簿里找回来：材料这一段每一步
      // 都要重新盘那个目录，而 sourceKey 是单向哈希，还原不回路径。
      const sourceDir = dir ?? currentSourceDir();
      const sourceKey = sourceDir ? sourceKeyOf(sourceDir) : currentSourceKey();
      if (!sourceKey) {
        out({ command: 'next', schemaVersion: NEXT_SCHEMA_VERSION,
          error: '第一次问要带 --dir <材料目录>',
          speak: '我还不知道你要报销哪一批材料。请把材料目录告诉我。' }, ERR);
      }
      const after = arg('after');
      // 「交了东西」指的是文件真的在、真的有内容。声称做完不算数 —— 状态只认事实。
      const filed = (name) => {
        const p = arg(name);
        return !!p && fs.existsSync(p) && fs.statSync(p).size > 0;
      };
      // 两侧观测合成一份：环境（A 表）和材料（B 表）。判定要的全部事实都在这里采齐，
      // 判定那一侧一个文件都不再读。目录不在了（被删、被改名）就只答环境那一半 ——
      // 拿一个不存在的目录去盘点会抛错，而那不是一个状态。
      const env = await observeEnvironment();
      // 数据格式比内核新的时候，**连采集都不做**。判定的顺序把 schema_too_new 排在最前，
      // 但采集跑在判定之前：拿这一版的眼睛去读下一版写的任务文件，可能当场抛异常，
      // 于是「硬停（退出码 2）」就变成了「内核自己出错（退出码 1）」。硬停要真的最先。
      const tooNew = env.schemaVersion > NEXT_SCHEMA_VERSION;
      const materialsThere = !tooNew && !!sourceDir
        && fs.existsSync(sourceDir) && fs.statSync(sourceDir).isDirectory();

      // 用户在终端上的表态**先落盘，再采观测** —— 顺序反过来，内核会拿着确认前的
      // 那份观测再问一次同一张表。判据和闸门都在 confirm.mjs 里。
      // 认身份那一步在材料之前发生，所以这里的闸门是 `!tooNew` 而不是「材料在不在」：
      // 后者会让"我在替谁报销"这次点头在材料目录还没给出来的时候悄悄丢掉。
      // 材料那几步自己要的目录，由 applyTerminalVerdict 里那道 `!sourceDir` 挡着。
      const applied = !tooNew
        ? await applyTerminalVerdict({ sourceDir: materialsThere ? sourceDir : null, sourceKey, after,
            correctionFile: filed('correction') ? arg('correction') : null,
            // 对话提问的答案走 --result：那一步没有命令可跑，答案本身就是结果。
            resultFile: filed('result') ? arg('result') : null })
        : null;

      const observation = {
        ...env,
        // 环境那份观测采在表态落盘**之前**（它要先算出 tooNew 才谈得上收表态），
        // 所以刚认下的身份要补回来 —— 不补的话这一次应答仍然报 `env_identity_unbound`，
        // 用户刚认完就又看见同一张表，而绑定其实已经写进去了。
        // 材料那半份观测在下面重采，本来就带着最新的事实，不需要这样补。
        ...(applied?.verdict === 'identity_bound' ? { binding: applied.binding } : {}),
        ...(materialsThere ? await observeTask(sourceDir) : {}),
      };
      const response = nextResponse({ observation, sourceKey, after,
        hasResult: filed('result'),
        // 已经收下并处置过的纠正不再报「没处安放」—— 那句话是留给真的没处安放的。
        hasCorrection: filed('correction') && !applied });
      if (response.step?.kind === 'extract_images') {
        ensureDir(path.dirname(response.step.requestPath));
        const temporary = `${response.step.requestPath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(response.step.request, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, response.step.requestPath);
      }
      // 收下了什么，明说。用户点了头却看不出内核收没收到，是最难排的一种障。
      out(applied ? { ...response, applied } : response, response.exit);
    }

    default:
      out({ error: `未知命令 ${cmd ?? '(空)'}`, commands: ['next', 'reset', 'doctor', 'chrome-up', 'probe', 'confirm-identity', 'intake', 'classify',
        'ocr-request', 'ocr-submit', 'confirm-readings', 'reread-submit',
        'history', 'events', 'select-task', 'lines',
        'tasks', 'abandon-task', 'catalog', 'erp-read', 'erp-reconcile', 'erp-fill'] }, ERR);
  }
} catch (err) {
  out({ command: cmd, error: err.message, code: err.code ?? null }, ERR);
}
