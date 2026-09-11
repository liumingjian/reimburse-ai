#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { paths, migrateOnStartup, ensureSchemaVersionFile } from '../src/paths.mjs';
import { probeIdentity, ERP_ENTRY, ERP_ORIGIN } from '../src/probe.mjs';
import { egoRequiredError, openEgoTab } from '../src/ego.mjs';
import { browserMode, EGO_BROWSER, SYSTEM_BROWSER, openDefaultBrowser } from '../src/browser-open.mjs';
import { defaultBrowserInfo } from '../src/browser-read.mjs';
import { CDP_PORT, launch as launchChromium } from '../src/chrome.mjs';
// 本地页面只剩两处：重新绑定身份，和浏览完整项目目录。读数确认在终端上
// （`confirm_table`），逐段分摊在终端上（`ask_user`），通用单选页整个下线了。
import { serveTaskSelection, serveProjectBookPage, serveIdentityConfirmation } from '../src/serve.mjs';
import { buildWorkOrder, ingestReadings, pendingConfirmations,
  READING_VERSION, DOC_TYPES } from '../src/vision.mjs';
import { applyTerminalVerdict } from '../src/confirm.mjs';
import { takeInventory, takeInventoryForTask, intakeOpenItems } from '../src/inventory.mjs';
import { normalizeMaterialScope } from '../src/material-scope.mjs';
import { classifyInventory, classifyOpenItems, summarize, markdownMaterialPaths,
  validateMarkdownSidecars } from '../src/classify.mjs';
import { prepare as prepareMarkdown, load as loadMarkdownArtifact, pendingWorkOrder,
  ingest as ingestMarkdown, PDF_MARKDOWN_SCHEMA_PATH } from '../src/pdf-markdown.mjs';
import { buildEvents, eventOpenItems, reconcile } from '../src/events.mjs';
import { loadSelection, submitSelection, applySelection, linesDigest, sameBasis, isBookSelection } from '../src/selection.mjs';
import { CATEGORIES } from '../src/categories.mjs';
import { findLiveTaskForSource, createTask, recordInventory, recordClassification,
  recordEvents, recordInvoiceSightings, abandonTask, loadIndex,
  sourceKeyOf, taskDir , recordCatalogVerification, loadCatalogVerification,
  recordErpAttempt, recordErpWrite, liveTasks, archiveMigratedTasks,
  recoveryCredentialPath, recordMaterialScope } from '../src/workspace.mjs';
import { crossTaskDuplicates, historyOpenItems, holdsInvoices } from '../src/history.mjs';
import { authorizedPage, verifyExpenseItems, verifyProject, PROJECT_FORM } from '../src/erpcatalog.mjs';
import { openSession, formTabs, sectionAnchors, showSection, readGrid, headerField,
  writeHeader, writeCell, selectOption, cellTarget, cellMatches, leaveEdit } from '../src/erpform.mjs';
import { readErpForm } from '../src/erpread.mjs';
import { readReconciliation, classifyReconciliation, attemptRecord } from '../src/erpreconcile.mjs';
import { buildErpDraftPreview, fillApprovedPreview, saveApprovedPreview } from '../src/erp-draft-flow.mjs';
import { recordWriteApproval } from '../src/erpwrite.mjs';
import { invoiceUploadGroups } from '../src/invoice-upload.mjs';
import { erpWriteAdapterFor, erpFormAdapterFor } from '../src/erp-browser-adapters.mjs';
import { cdpReadOptions } from '../src/erp-cdp-read.mjs';
import { buildReceiptReadback } from '../src/erp-write-readback.mjs';
import { authorizeErpWritePage, prepareErpWrite } from '../src/erp-write-context.mjs';
import { gateIdentity, readBinding, writeBinding, bindingVerdict, autoBindIdentity } from '../src/binding.mjs';
import { observeEnvironment, observeTask } from '../src/observe.mjs';
import { lookupNetworkLocation } from '../src/location.mjs';
import { nextResponse } from '../src/next.mjs';
import { ingestReread, autoSettleAgreed } from '../src/dispute.mjs';
import { determineState, SCHEMA_VERSION as NEXT_SCHEMA_VERSION } from '../src/state.mjs';
import { currentSourceKey, currentSourceDir, currentIssuedArgv } from '../src/steptoken.mjs';
import { guardVerdict, refusalPayload, recordRefusal } from '../src/guard.mjs';
import { resetHome } from '../src/reset.mjs';
import { readBook, bookPath, selectableProjects, annotateProjects, noCandidatesNote, sameIdentity,
  PROJECT_BOOK_EMPTY, localToday } from '../src/projects.mjs';
import { classifiedDetailDigest } from '../src/classified-detail.mjs';
import { generatePreparation } from '../src/preparation.mjs';
import { intakeProject } from '../src/projectintake.mjs';
import { removeProject, purgeInvalidProjects, recheckAll } from '../src/projectmaintain.mjs';
import { hasRecoveryMarker, createLocalPreparationRecovery,
  validateLocalPreparationRecovery } from '../src/recovery-flow.mjs';
import { materializeStepArtifacts } from '../src/step-artifacts.mjs';
import { installRuntimeDependencies, inspectRuntimeDependencies } from '../src/runtime-dependencies.mjs';

// 退出码是给 Skill 用的确定性信号：
//   0 完成   1 内核出错   2 硬阻塞（内核拒绝继续，任何"确认继续"都不能绕过）
const OK = 0, ERR = 1, BLOCKED = 2;

function egoBlocked(command, note) {
  const error = egoRequiredError(command);
  out({ command, status: 'blocked', code: error.code, error: error.message, note }, BLOCKED);
}

async function authorizedReadPage(command, options = {}) {
  try {
    return await authorizedPage(options);
  } catch (error) {
    if (error?.code === 'EGO_TASK_SPACE_REQUIRED') {
      out({ command, status: 'blocked', code: error.code, error: error.message,
        note: '请先完成报销系统的浏览器环境准备，之后再继续。' }, BLOCKED);
    }
    throw error;
  }
}

const readReconciliationFor = (page, options = {}) => page?.automation === 'cdp'
  ? readReconciliation(page, { ...cdpReadOptions, ...options })
  : readReconciliation(page, options);

const recoveryBlocked = (task, result, command = null) => ({
  ...(command ? { command } : {}),
  ...recoveryBlock(task, command),
  recovery: {
    status: result?.status ?? 'credential_invalid',
    reasons: result?.reasons ?? ['本地恢复 fresh 只读核对没有通过'],
    credentialPath: result?.credentialPath ?? recoveryCredentialPath(task),
  },
});

// 数据目录搬家的结果。搬完要在这条命令的输出里说一句迁到哪了 —— 用户的报销记录
// 换了地方而没人告诉他，比不搬还糟。
let migrated = null;

const [, , cmd] = process.argv;

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
  migrated = cmd === 'reset' || cmd === 'doctor' ? null : migrateOnStartup();
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
const hasErpWriteState = (task) => task?.erpWriteState !== null
  && task?.erpWriteState !== undefined
  && String(task.erpWriteState).trim() !== '';

const recoveryBlock = (task, command = null) => ({ ...(command ? { command } : {}),
  status: 'erp_write_in_progress',
  task: { taskId: task.taskId, erpWriteState: task.erpWriteState, workspace: taskDir(task) },
  note: '这个任务已经动过 ERP，不能回到项目选择或重建账本；按当前恢复步骤继续处理' });

const writeDerived = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

async function markdownTask(dir, command) {
  const existing = findLiveTaskForSource(sourceKeyOf(dir));
  if (hasErpWriteState(existing)) {
    const recovery = await validateLocalPreparationRecovery(dir);
    if (!recovery.ok) out({ command, ...recoveryBlocked(existing, recovery),
      note: '本地恢复 fresh 只读核对没有通过，不能更新候选材料' }, BLOCKED);
  }
  const inventory = await takeInventoryForTask(dir, existing);
  const task = existing ?? createTask(dir);
  const rec = recordInventory(task, inventory);
  const intakeItems = intakeOpenItems(inventory);
  if (intakeItems.some((item) => item.blocking)) {
    out({ command, stage: 'intake', task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
      openItems: intakeItems, readyForNextStep: false }, BLOCKED);
  }
  return { task: rec.task, inventory };
}

async function convertMarkdownMaterials(dir, task, inventory) {
  const materials = [];
  for (const material of inventory.materials.filter((item) => item.format === 'pdf'
    && item.disposition === 'pending_classification')) {
    const paths = markdownMaterialPaths(task, inventory.versionId, material.materialId);
    const sourcePath = path.join(path.resolve(dir), material.relPath);
    let artifact;
    let sidecarsNeedRefresh = false;
    try {
      artifact = loadMarkdownArtifact(paths.artifactPath, { sourcePath, materialId: material.materialId });
      sidecarsNeedRefresh = artifact.status === 'converted'
        && !validateMarkdownSidecars(artifact, paths).ok;
    } catch {
      const prepared = await prepareMarkdown({ sourcePath, materialId: material.materialId,
        outputPath: paths.artifactPath, overwrite: true });
      artifact = prepared.artifact;
    }
    if (artifact.status !== 'converted' || sidecarsNeedRefresh) {
      if (sidecarsNeedRefresh) {
        fs.rmSync(paths.candidatePath, { force: true });
        fs.rmSync(paths.candidateRecordPath, { force: true });
        fs.rmSync(paths.reextractPath, { force: true });
      }
      const prepared = await prepareMarkdown({ sourcePath, materialId: material.materialId,
        outputPath: paths.artifactPath, overwrite: true });
      artifact = prepared.artifact;
    }
    if (artifact.status === 'converted') {
      writeDerived(paths.markdownPath, artifact.markdown);
      writeDerived(paths.numberedMarkdownPath, artifact.numberedMarkdown);
      const work = pendingWorkOrder(artifact);
      if (work.status === 'ready') writeDerived(paths.templatePath, `${JSON.stringify(work.candidateTemplate, null, 2)}\n`);
    }
    materials.push({
      materialId: material.materialId,
      fileName: material.fileName,
      contentHash: material.contentHash,
      status: artifact.status,
      error: artifact.error ?? null,
      paths,
      markdownHash: artifact.source?.markdownHash ?? null,
      numberedMarkdownHash: artifact.source?.numberedMarkdownHash ?? null,
    });
  }
  return materials;
}

/**
 * 盘点 -> 分流。后面每一层都要站在一次确定的分流结果上，所以统一走这里。
 * 任一层还有硬阻塞就把阻塞原样带回去，不往下算。
 */
async function upToClassification(dir, { allowRecovery = false, mode = 'markdown' } = {}) {
  const existing = findLiveTaskForSource(sourceKeyOf(dir));
  let recovery = null;
  if (hasErpWriteState(existing)) {
    if (!allowRecovery) {
      return { task: existing, blocked: { stage: 'erp_recovery', ...recoveryBlock(existing),
        readyForNextStep: false } };
    }
    recovery = await validateLocalPreparationRecovery(dir);
    if (!recovery.ok) {
      return { task: existing, blocked: { stage: 'erp_recovery',
        ...recoveryBlocked(existing, recovery), readyForNextStep: false } };
    }
  }
  const inventory = await takeInventoryForTask(dir, existing);
  const task = existing ?? createTask(dir);
  const rec = recordInventory(task, inventory);

  const intakeItems = intakeOpenItems(inventory);
  if (intakeItems.some((i) => i.blocking)) {
    return { blocked: { stage: 'intake', openItems: intakeItems, readyForNextStep: false,
      task: { taskId: rec.task.taskId, workspace: taskDir(rec.task) },
      note: '材料盘点还有未清的待确认项，先处理它们' } };
  }
  const classification = classifyInventory(dir, inventory, rec.task, { mode });
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
async function upToEvents(dir, options = {}) {
  const up = await upToClassification(dir, options);
  if (up.blocked) return up;
  const built = buildEvents(up.classification, up.task);
  recordEvents(up.task, built);
  const items = eventOpenItems(built);
  if (items.some((i) => i.blocking)) {
    return { blocked: { stage: 'events', openItems: items.filter((i) => i.blocking), readyForNextStep: false,
      task: { taskId: up.task.taskId, workspace: taskDir(up.task) },
      note: '费用事件这一层还有硬阻塞，材料整理没确认完，不能进入任务选择' } };
  }
  return { ...up, built, recovery: up.recovery ?? null, blocked: null };
}

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
if (cmd !== 'reset' && cmd !== 'doctor') ensureSchemaVersionFile();

try {
  switch (cmd) {
    case 'reset': {
      const result = await resetHome(paths.root);
      out({ command: 'reset', ...result }, result.status === 'reset' ? OK : BLOCKED);
    }

    case 'doctor': {
      // 体检只读取当前环境，不启动浏览器、不连接 CDP，也不创建数据文件。
      const mode = browserMode();
      let environment;
      try {
        environment = await observeEnvironment();
      } catch (error) {
        environment = {
          browserMode: mode,
          browserReadError: { code: error.code ?? 'BROWSER_READ_UNAVAILABLE', message: error.message },
          probe: { status: 'browser_read_unavailable', code: error.code ?? null, hint: error.message },
        };
      }
      const [major] = process.versions.node.split('.').map(Number);
      const readUnavailable = !!environment.browserReadError
        || environment.probe?.status === 'browser_read_unavailable';
      const checks = {
        node: { value: process.versions.node, ok: major >= 21,
          hint: major >= 21 ? null : '内核需要 Node 21 及以上' },
        browser: { value: mode, ok: true,
          hint: mode === EGO_BROWSER
            ? '仅显式 BAOX_BROWSER=ego 时使用 ego QA transport'
            : '使用操作系统默认浏览器，不启动专用 Chrome' },
        browserRead: { value: environment.probe?.status ?? null, ok: !readUnavailable,
          code: environment.browserReadError?.code ?? environment.probe?.code ?? null,
          hint: environment.browserReadError?.message ?? environment.probe?.hint ?? null },
        dataDir: { value: paths.root, ok: fs.existsSync(paths.root) },
      };
      const ready = checks.node.ok && checks.browser.ok && checks.browserRead.ok;
      out({ command: 'doctor', version: VERSION, platform: process.platform, browserMode: mode, checks,
        probe: environment.probe ?? null, ready }, ready ? OK : ERR);
    }

    case 'runtime-setup': {
      if (!has('yes')) {
        out({ command: 'runtime-setup', status: 'confirmation_required',
          speak: '运行时安装必须由 baox next 发出 --yes 的受管步骤触发。' }, BLOCKED);
      }
      const options = {
        home: process.env.BAOX_HOME ?? paths.root,
        pdfRuntimeDir: arg('pdf-runtime'),
        markitdownInstallDir: arg('markitdown-install'),
        ocrRuntimeDir: arg('ocr-runtime'),
        ocrInstallerPath: arg('ocr-installer'),
        ocrRequirementsPath: arg('ocr-requirements'),
      };
      try {
        const installed = installRuntimeDependencies(options);
        out({ command: 'runtime-setup', status: 'installed', ready: installed.ready,
          runtimes: installed.runtimes, missing: installed.missing }, OK);
      } catch (error) {
        let checked = null;
        try { checked = inspectRuntimeDependencies(options); } catch { /* keep install error */ }
        out({ command: 'runtime-setup', status: 'blocked', ready: false,
          code: error.code ?? 'RUNTIME_SETUP_FAILED', error: error.message,
          runtimes: checked?.runtimes ?? null, missing: checked?.missing ?? null }, BLOCKED);
      }
    }

    case 'browser-open': {
      const url = arg('url', ERP_ENTRY);
      const mode = browserMode();
      if (mode === EGO_BROWSER) {
        try {
          const page = await openEgoTab(url);
          out({ command: 'browser-open', browserMode: mode, transport: 'ego', url,
            status: 'opened', page }, OK);
        } catch (error) {
          if (error?.code === 'EGO_TASK_SPACE_REQUIRED') {
            out({ command: 'browser-open', browserMode: mode, status: 'blocked',
              code: error.code, error: error.message,
              note: '请先完成报销系统的浏览器环境准备，之后再继续。' }, BLOCKED);
          }
          throw error;
        }
      }
      const opened = await openDefaultBrowser(url);
      out({ command: 'browser-open', browserMode: SYSTEM_BROWSER, transport: 'system', url,
        status: opened === false ? 'skipped' : 'opened', opened }, OK);
    }

    case 'chrome-up': {
      if (browserMode() === EGO_BROWSER) {
        egoBlocked('chrome-up', 'chrome-up 是正式 Chromium 环境步骤；显式 QA 仍使用已确认的 ego task space。');
      }
      let defaultBrowser = null;
      try { defaultBrowser = await defaultBrowserInfo({ origin: ERP_ORIGIN }); } catch {}
      try {
        const launched = await launchChromium({
          port: CDP_PORT,
          openUrl: ERP_ENTRY,
          browserBundleId: defaultBrowser?.bundleId ?? null,
        });
        out({ command: 'chrome-up', status: 'ready', started: launched.started === true,
          port: CDP_PORT, browser: launched.Browser ?? null, profile: paths.chromeProfile,
          note: 'Chromium 自动化连接已准备好；请在新窗口登录后重新执行当前 next 步骤' }, OK);
      } catch (error) {
        out({ command: 'chrome-up', status: 'blocked', code: error.code ?? 'CHROMIUM_LAUNCH_FAILED',
          error: error.message,
          note: '没有启动成功 Chromium 自动化连接；没有打开、导入或保存 ERP' }, BLOCKED);
      }
    }

    case 'probe': {
      // 会话 + 个人绑定，一次判完。只有 matched 放行 —— 「有人登录着」从来不是
      // 「该报销的那个人登录着」。
      const r = await gateIdentity();
      out({ command: 'probe', ...r }, r.status === 'matched' ? OK : BLOCKED);
    }

    case 'projects': {
      // 只读诊断：个人项目簿按当前 tenant/account 隔离，不从任何全局旧文件迁入。
      const gate = await gateIdentity();
      if (gate.status !== 'matched') {
        out({ command: 'projects', ...gate,
          note: '身份没核对通过，不读取或修改个人项目簿' }, BLOCKED);
      }
      const identity = gate.identity;
      const book = readBook(identity);
      const projects = annotateProjects(book.projects);
      out({ command: 'projects', status: 'ready', identity,
        bookPath: bookPath(identity), projectCount: projects.length,
        selectableCount: projects.filter((p) => p.selectable).length, projects });
    }

    case 'projects-page': {
      // 这是 next 发出的用户维护页。页面常驻期间每一个动作都重新查身份，
      // 登录换人时拒绝写入原身份的项目簿。
      const initial = await gateIdentity();
      if (initial.status !== 'matched') {
        out({ command: 'projects-page', ...initial,
          note: '身份没核对通过，不打开个人项目簿维护页' }, BLOCKED);
      }
      const identity = initial.identity;
      const currentSession = async () => {
        const current = await gateIdentity();
        if (current.status !== 'matched') return { ok: false, current };
        if (!sameIdentity(identity, current.identity)) {
          return { ok: false, current: { ...current, status: 'identity_mismatch',
            note: '维护页打开后 ERP 登录身份发生变化，个人项目簿没有改动' } };
        }
        return { ok: true, current };
      };
      const sessionForCatalog = async () => {
        const checked = await currentSession();
        if (!checked.ok) return { ok: false, ...checked.current };
        return { ok: true, probe: checked.current, page: checked.current.page };
      };
      const result = await serveProjectBookPage({
        book: () => readBook(identity),
        today: localToday(),
      }, {
        timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
        onReady: (u) => process.stderr.write(`已在浏览器里打开页面（维护个人项目簿）；没弹出就手动打开：${u}\n`),
        onIntake: async (number) => {
          const checked = await currentSession();
          if (!checked.ok) return checked.current;
          return intakeProject(number, null, {
            identity,
            gate: sessionForCatalog,
          });
        },
        onRemove: async (number) => {
          const checked = await currentSession();
          if (!checked.ok) return checked.current;
          return removeProject(number, identity);
        },
        onPurge: async () => {
          const checked = await currentSession();
          if (!checked.ok) return checked.current;
          return purgeInvalidProjects(identity);
        },
        onRecheck: async () => {
          const checked = await currentSession();
          if (!checked.ok) return checked.current;
          return recheckAll({ identity, gate: sessionForCatalog });
        },
        onDone: async () => {
          const checked = await currentSession();
          return checked.ok ? { status: 'done', book: readBook(identity) } : checked.current;
        },
      });
      out({ command: 'projects-page', ...result, identity,
        bookPath: bookPath(identity), book: readBook(identity) },
      result.status === 'done' ? OK : ERR);
    }

    case 'scope-materials': {
      // 用户明确授权后才登记材料范围；这里不建任务、不盘点落账、不改 marker 或 version。
      const dir = arg('dir');
      const file = arg('file');
      if (!dir || !file) out({ command: 'scope-materials',
        error: '缺少 --dir <材料目录> 或 --file <scope json>' }, ERR);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'scope-materials', status: 'task_missing',
        note: '材料目录没有进行中的任务；scope 入口不会创建新任务' }, BLOCKED);

      let scope;
      try {
        scope = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        out({ command: 'scope-materials', status: 'scope_file_invalid',
          reasons: [`scope 文件不可读或不是 JSON：${error.message}`] }, BLOCKED);
      }

      // 先用普通 inventory 验证用户明确点名的每个文件仍是当前字节；
      // 未列入清单的新增文件照常进入 version，绝不因为目录名而隐藏。
      const fullInventory = await takeInventory(dir);
      const byPath = new Map(fullInventory.materials.map((material) => [material.relPath, material]));
      let normalized;
      try {
        normalized = normalizeMaterialScope(scope);
        const mismatches = normalized.exclusions.map((expected) => {
          const actual = byPath.get(expected.relPath);
          return actual && actual.contentHash === expected.contentHash && actual.size === expected.size
            ? null : { relPath: expected.relPath, expected,
              actual: actual ? { contentHash: actual.contentHash, size: actual.size } : null };
        }).filter(Boolean);
        if (mismatches.length) out({ command: 'scope-materials', status: 'scope_files_changed',
          mismatches, note: 'scope 文件必须重新按当前字节明确记录，未写入任何 scope' }, BLOCKED);
      } catch (error) {
        out({ command: 'scope-materials', status: 'scope_file_invalid', reasons: [error.message] }, BLOCKED);
      }

      const recorded = recordMaterialScope(task, normalized);
      const scopedInventory = await takeInventoryForTask(dir, recorded.task);
      const versionMatches = task.currentVersionId === scopedInventory.versionId;
      out({ command: 'scope-materials', status: versionMatches ? 'recorded' : 'recorded_but_stale',
        task: { taskId: recorded.task.taskId, erpWriteState: recorded.task.erpWriteState ?? null,
          currentVersionId: task.currentVersionId, workspace: taskDir(recorded.task) },
        scope: { scopeId: recorded.scope.scopeId, filePath: recorded.filePath,
          exclusions: recorded.scope.exclusions },
        inventory: { ordinaryVersionId: fullInventory.versionId,
          scopedVersionId: scopedInventory.versionId, versionMatches,
          materialCount: scopedInventory.materials.length,
          excludedCount: scopedInventory.excluded.length,
          scopeMismatches: scopedInventory.scopeMismatches },
        note: versionMatches
          ? '已记录显式材料排除；原任务 version 与 scoped inventory 一致，未修改 marker 或 version'
          : '已记录显式材料排除，但当前任务 version 仍与 scoped inventory 不一致；必须按 stale 流程处理，不能用 scope 绕过',
      }, versionMatches ? OK : BLOCKED);
    }

    case 'resume-local-preparation': {
      const dir = arg('dir');
      if (!dir) out({ command: 'resume-local-preparation', error: '缺少 --dir <材料目录>' }, ERR);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'resume-local-preparation', status: 'task_missing',
        note: '这个材料目录没有进行中的任务；恢复入口不创建新任务' }, BLOCKED);
      if (!hasRecoveryMarker(task)) {
        out({ command: 'resume-local-preparation', ...recoveryBlock(task),
          note: '当前任务没有 upload_dispatched marker，不能创建恢复凭据' }, BLOCKED);
      }
      const result = await createLocalPreparationRecovery(dir);
      if (!result.ok) {
        out({ command: 'resume-local-preparation', ...result,
          task: { taskId: task.taskId, workspace: taskDir(task) } }, BLOCKED);
      }
      out({ command: 'resume-local-preparation', status: result.status,
        task: { taskId: result.task.taskId, erpWriteState: result.task.erpWriteState,
          workspace: taskDir(result.task) },
        identity: result.identity,
        credentialPath: result.credentialPath,
        credentialId: result.credential.credentialId,
        receiptCount: result.credential.receiptBindings.length,
        capabilities: result.capabilities,
        note: '已完成逐票 ERP 只读回读；凭据只允许本地准备，不解除 ERP 写入闸，也没有修改任务 marker' });
    }

    case 'confirm-identity': {
      // 个人绑定进入系统的唯一通道。页面上的每个值都是内核刚从 ERP 读到的，
      // 用户只能认或不认；对话里说「是我」不算数。
      const probe = await probeIdentity();
      if (probe.status !== 'matched') {
        out({ command: 'confirm-identity', ...probe,
          note: browserMode() === EGO_BROWSER
            ? '读不出当前登录身份，没有可确认的东西；请先配置 BAOX_EGO_TASK_SPACE，并在 ego-browser task space 里登录 ERP'
            : '读不出当前登录身份，没有可确认的东西；请先在系统默认浏览器里打开并登录 ERP，完成只读权限后再试' }, BLOCKED);
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
      // 只读回读当前 ego 页面：页签、表头和两个按标题识别的网格。
      // 适配层不点击懒渲染区域，也不滚动字段；缺失内容会如实回报为不可读。
      const gate = await authorizedReadPage('erp-read');
      if (!gate.ok) {
        out({ command: 'erp-read', identity: gate.probe,
          note: '身份没核对通过，不读 ERP 页面' }, BLOCKED);
      }
      const snapshot = await readErpForm(gate.page);
      const tabs = snapshot.formTabs;
      if (tabs.length !== 1) {
        out({ command: 'erp-read', formOpen: false,
          formTabs: tabs.map((t) => t.label), anchors: snapshot.anchors,
          billNo: snapshot.billNo,
          detail: snapshot.detail, receipts: snapshot.receipts,
          note: tabs.length === 0
            ? '页面上没有打开的费用报销单（既没有"新增"也没有"修改"页签）'
            : `页面上同时开着 ${tabs.length} 个费用报销单页签，认不出该读哪一张` }, BLOCKED);
      }
      out({ command: 'erp-read', formOpen: true, formMode: tabs[0].mode,
        formTabs: tabs.map((t) => t.label), anchors: snapshot.anchors,
        billNo: snapshot.billNo, detail: snapshot.detail, receipts: snapshot.receipts,
        note: '只读回读，没有点击、滚动、导航、写入或保存' }, OK);
    }

    case 'erp-reconcile': {
      // ERP 对账：四项只读读数 -> 一个对账中断点 -> 两种处置之一。
      // 这里是一层薄壳，判定在 erpreconcile.mjs 里（那是纯函数，能不开浏览器测）。
      //
      // 退出码：`转人工` -> 2（硬阻塞，任何"确认继续"都不能绕过）；其余 -> 0。
      // 这里的 0 **不表示"可以继续写 ERP"**，它只表示对账本身完成了。
      const gate = await authorizedReadPage('erp-reconcile');
      if (!gate.ok) {
        out({ command: 'erp-reconcile', identity: gate.probe,
          note: '身份没核对通过，不读 ERP 页面' }, BLOCKED);
      }
      const readings = await readReconciliationFor(gate.page);
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
        note: '只读分类，不表示保存验收；没有点击、没有滚动、没有导航、没有写入，也没有保存',
      }, verdict.action === '转人工' ? BLOCKED : OK);
    }

    case 'erp-write': {
      const writeDir = arg('dir');
      if (!writeDir) out({ command: 'erp-write', status: 'blocked',
        error: '缺少 --dir <材料目录>' }, BLOCKED);
      const writeTask = findLiveTaskForSource(sourceKeyOf(writeDir));
      if (!writeTask) out({ command: 'erp-write', status: 'blocked',
        error: '这个目录没有进行中的报销任务，不能把发票写进 ERP' }, BLOCKED);
      if (hasErpWriteState(writeTask)) {
        out({ command: 'erp-write', ...recoveryBlock(writeTask),
          note: '当前任务已经触碰 ERP，不能再次导入或保存；请按恢复步骤核对当前单据' }, BLOCKED);
      }

      let gate;
      try {
        gate = await authorizeErpWritePage({
          authorize: (options) => authorizedReadPage('erp-write', options),
        });
      } catch (error) {
        out({ command: 'erp-write', status: 'blocked', code: error.code ?? 'chromium_automation_unavailable',
          error: error.message,
          note: '当前 Chrome/Edge 没有可接管的 Chromium 自动化连接；不会切换到 ego，也没有写入 ERP' }, BLOCKED);
      }
      if (!gate.ok) out({ command: 'erp-write', status: 'blocked', identity: gate.probe,
        note: '身份没核对通过，不打开报销单或导入发票' }, BLOCKED);

      let writeAdapter;
      let formAdapter;
      try {
        writeAdapter = erpWriteAdapterFor(gate.page);
        formAdapter = erpFormAdapterFor(gate.page);
      } catch (error) {
        out({ command: 'erp-write', status: 'blocked', code: error.code ?? 'chromium_automation_required',
          error: error.message, note: '当前页面没有受支持的 Chromium 写入连接；没有打开、导入或保存 ERP' }, BLOCKED);
      }

      const observed = await observeTask(writeDir);
      const preparation = observed.preparation;
      const packageInfo = observed.preparationPackage;
      const invoicePaths = packageInfo?.files?.invoices;
      if (observed.preparationConfirmed !== true || preparation?.ready !== true
        || observed.preparationPackageCurrent !== true || !observed.built || !observed.lines?.length
        || !Array.isArray(invoicePaths) || invoicePaths.length === 0) {
        out({ command: 'erp-write', status: 'blocked',
          task: { taskId: writeTask.taskId, workspace: taskDir(writeTask) },
          preparationConfirmed: observed.preparationConfirmed === true,
          preparationReady: preparation?.ready === true,
          packageCurrent: observed.preparationPackageCurrent === true,
          note: '当前任务没有通过最新准备包确认，ERP 没有打开、没有导入、没有保存' }, BLOCKED);
      }
      if (!observed.selectionApplied || observed.catalogFresh !== true) {
        out({ command: 'erp-write', status: 'blocked',
          note: '项目选择或 ERP 主数据核验已经过期，ERP 没有打开、没有导入、没有保存' }, BLOCKED);
      }

      // A pre-existing form may be reused only when it is the one empty new
      // form belonging to this task. Any existing data or modify form stops
      // before the write marker is recorded.
      let tabsBefore;
      try { tabsBefore = await formAdapter.formTabs(gate.page); } catch (error) {
        out({ command: 'erp-write', status: 'blocked', code: error.code ?? 'erp_read_failed',
          error: error.message, note: '无法确认当前 ERP 是否有唯一空白新增单，未写入' }, BLOCKED);
      }
      if (tabsBefore.length > 1 || tabsBefore.some((tab) => tab.mode !== 'new')) {
        out({ command: 'erp-write', status: 'blocked', formTabs: tabsBefore,
          note: 'ERP 当前不是唯一的费用报销单-新增空白单，未导入发票' }, BLOCKED);
      }
      if (tabsBefore.length === 1) {
        let before;
        try { before = await readReconciliationFor(gate.page); } catch (error) {
          out({ command: 'erp-write', status: 'blocked', code: error.code ?? 'erp_read_failed',
            error: error.message, note: '无法回读现有新增单的空白状态，未写入' }, BLOCKED);
        }
        const receiptRows = before.receiptsGrid?.rows?.filter((row) => row.kind === 'data') ?? [];
        if (before.formMode?.value !== 'new' || before.billNo?.value !== null || receiptRows.length !== 0) {
          out({ command: 'erp-write', status: 'blocked',
            note: '现有新增单不是可安全复用的空白单，未导入发票' }, BLOCKED);
        }
      }

      const versionId = observed.built.versionId;
      const freshGate = {
        status: 'matched',
        fresh: true,
        taskId: writeTask.taskId,
        versionId,
        identity: gate.probe.identity,
        scope: { taskId: writeTask.taskId, versionId, identity: gate.probe.identity },
      };
      const failBeforeMarker = (phase, error, extra = {}) => out({
        command: 'erp-write', status: 'blocked', phase,
        code: error?.code ?? null, error: error?.message ?? String(error),
        task: { taskId: writeTask.taskId, workspace: taskDir(writeTask) },
        ...extra,
        note: 'ERP 尚未导入或保存；未记录 upload_dispatched，可以修复页面上下文后重试',
      }, BLOCKED);

      try { invoiceUploadGroups(invoicePaths); } catch (error) {
        failBeforeMarker('invoice_validation', error);
      }

      let preparedWrite;
      try {
        preparedWrite = await prepareErpWrite({
          page: gate.page,
          navigate: (page) => writeAdapter.openNewReimbursement(page, { timeoutMs: 45_000 }),
          read: (page) => readReconciliationFor(page),
          openAssistant: (page) => writeAdapter.openInvoiceAssistant(page, { timeoutMs: 90_000 }),
          mark: () => recordErpWrite(writeTask, 'upload_dispatched'),
        });
      } catch (error) {
        failBeforeMarker(error?.phase ?? 'preflight', error, error?.details ?? {});
      }

      // From this point every ERP action is covered by the marker. If any
      // later action is uncertain, the task must enter recovery and never
      // retry the upload or save from this command.
      const { markedTask } = preparedWrite;
      const failAfterMarker = (phase, error, extra = {}) => out({
        command: 'erp-write', status: 'blocked', phase,
        code: error?.code ?? null, error: error?.message ?? String(error),
        task: { taskId: markedTask.taskId, erpWriteState: 'upload_dispatched', workspace: taskDir(markedTask) },
        ...extra,
        note: 'ERP 已进入不可重放的恢复态；不会自动重试导入或保存，请先按恢复步骤只读核对',
      }, BLOCKED);

      try {
        await writeAdapter.uploadAndImportInvoices(gate.page, invoicePaths, { timeoutMs: 210_000 });
      } catch (error) { failAfterMarker('invoice_import', error); }

      let imported;
      try { imported = await readReconciliationFor(gate.page); } catch (error) {
        failAfterMarker('receipt_readback', error);
      }
      const receiptFacts = buildReceiptReadback({
        grid: imported.receiptsGrid,
        invoices: preparation.document?.invoices ?? [],
        taskId: writeTask.taskId,
        versionId,
        identity: gate.probe.identity,
      });
      if (!receiptFacts.ok) {
        failAfterMarker('receipt_readback', new Error('导入后的 ERP 收票不能唯一对应当前准备包'), {
          problems: receiptFacts.problems,
        });
      }

      const selection = loadSelection(writeTask);
      const catalog = loadCatalogVerification(writeTask);
      const expenseItems = Array.isArray(catalog?.expenseItems) ? catalog.expenseItems : [];
      const draft = buildErpDraftPreview({
        task: writeTask,
        built: observed.built,
        lines: observed.lines,
        selection,
        catalog,
        expenseItems,
        receiptCheck: receiptFacts.receiptCheck,
        receiptReadback: receiptFacts.receiptReadback,
        freshGate,
      });
      if (!draft.ready) {
        failAfterMarker('preview', new Error('导入后的收票不能生成完整 ERP 明细预览'), {
          problems: draft.problems,
        });
      }
      const approval = recordWriteApproval(markedTask, draft.expectedPreview,
        { approvedVia: 'preparation_confirmation' });
      const readCurrent = (expectedPreview = null) =>
        readReconciliationFor(gate.page, { expectedPreview });
      let filled;
      try {
        filled = await fillApprovedPreview(gate.page, {
          approvedPreview: draft.expectedPreview,
          approval,
          freshGate,
          readCurrent,
          addRow: writeAdapter.addDetailRow,
          ops: {
            writeHeader: formAdapter.writeHeader,
            writeCell: formAdapter.writeCell,
            selectOption: formAdapter.selectOption,
            leaveEdit: formAdapter.leaveEdit,
          },
        });
      } catch (error) { failAfterMarker('fill', error); }
      if (!filled?.ok) {
        failAfterMarker('fill', new Error('ERP 明细填充或严格回读没有通过'), { result: filled });
      }

      let saved;
      try {
        saved = await saveApprovedPreview(gate.page, {
          approvedPreview: draft.expectedPreview,
          approval,
          freshGate,
          fillResult: filled,
          readCurrent,
          save: writeAdapter.saveReimbursement,
        });
      } catch (error) { failAfterMarker('save', error); }
      if (!saved?.ok || saved.status !== 'saved' || saved.saveAttempts !== 1) {
        failAfterMarker('save', new Error('保存后没有通过唯一单号、修改页签和严格回读验收'), { result: saved });
      }
      const savedTask = recordErpWrite(markedTask, 'saved');
      out({ command: 'erp-write', status: 'saved', saveAttempts: saved.saveAttempts,
        billNo: saved.billNo, task: { taskId: savedTask.taskId, erpWriteState: savedTask.erpWriteState,
          workspace: taskDir(savedTask) }, previewDigest: draft.expectedPreview.previewDigest,
        note: '发票已导入，已选择不生成费用明细，ERP 明细已逐项回读并保存为草稿' }, OK);
    }

    case 'erp-fill': {
      egoBlocked('erp-fill', 'erp-fill 尚未迁移到 ego-browser；没有写入 ERP。');
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
          const verified = await verifyExpenseItems(gate.page);
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
      const items = await verifyExpenseItems(gate.page);

      let ctx = null;
      let wanted = single ? [single] : [];
      if (dir) {
        const up = await upToEvents(dir, { allowRecovery: true,
          mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
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

      const projectBook = ctx ? selectableProjects(gate.probe.identity) : [];
      const bookByNumber = new Map(projectBook.map((project) => [project.number, project]));
      const results = [];
      for (const n of wanted) results.push(await verifyProject(gate.page, n));
      const checkedProjects = results.map((result) => {
        if (!ctx || !result?.ok || result.verdict !== 'confirmed') return result;
        const book = bookByNumber.get(result.number);
        if (!book || book.name === result.name) return result;
        return {
          ...result,
          verdict: 'name_mismatch',
          bookName: book.name ?? null,
          note: `项目号 ${result.number} 在 ERP 里叫「${result.name ?? '（无名称）'}」，`
            + `个人项目簿记的是「${book.name ?? '（无名称）'}」；请先核对项目簿和 ERP 主数据`,
        };
      });
      const proj = single && !dir ? checkedProjects[0] : null;

      // 查询本身失败不是"核对通过"，是"没核对成"，一律阻塞。
      const failed = [items, ...results].filter((r) => r && r.ok === false);
      const problems = [
        ...(items.problems ?? []),
        ...checkedProjects.filter((r) => r.ok && r.verdict !== 'confirmed'),
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
          // Version 2 records the expense-item read-only projection as well as
          // projects.  Older records intentionally become stale: the preparation
          // bundle must be able to cite the canonical ERP name for every code.
          catalogSchemaVersion: 2,
          linesDigest: linesDigest(ctx.built),
          versionId: ctx.built.versionId,
          verifiedAt: new Date().toISOString(),
          identity: gate.probe.identity,
          projectFormId: PROJECT_FORM,
          projects: Object.fromEntries(checkedProjects.map((r) => [r.number,
            { verdict: r.verdict, name: r.name ?? null }])),
          selectionSnapshot: {
            projects: Object.fromEntries(Object.entries(ctx.selection.projects).sort(([a], [b]) =>
              a.localeCompare(b))),
            projectBook: [...new Set(Object.values(ctx.selection.projects))]
              .sort()
              .map((number) => {
                const project = bookByNumber.get(number);
                return { number, name: project?.name ?? null };
              }),
          },
          // Keep the canonical records directly addressable by code.  The
          // preparation builder accepts this array as its expense-item catalog.
          expenseItems: items.ok ? items.checked : null,
          expenseItemFormId: items.ok ? items.formId : null,
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
        projects: ctx ? checkedProjects.map((r) => (r.ok
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

      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) out({ command: 'intake', ...recoveryBlock(existing),
        note: '动过 ERP 的任务不能通过 intake 重建或改写；先走本地恢复入口' }, BLOCKED);

      const inventory = await takeInventoryForTask(dir, existing);
      const key = sourceKeyOf(dir);
      // 同一个目录再次运行时，恢复原任务而不是新建第二个（契约「重复运行与历史材料」）。
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
          excludedCount: inventory.excluded.length,
          byDisposition },
        materials: inventory.materials.map(({ materialId, relPath, format, size, disposition, reason, contentHash }) =>
          ({ materialId, relPath, format, size, disposition, reason, contentHash: contentHash?.slice(0, 16) ?? null })),
        ignored: inventory.ignored,
        excluded: inventory.excluded.map(({ materialId, relPath, size, contentHash, scopeReason }) =>
          ({ materialId, relPath, size, contentHash, reason: scopeReason })),
        scopeMismatches: inventory.scopeMismatches,
        openItems: items,
        // 待确认项一条未清就不能进入下一步；这是契约的放行条件，不是建议。
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'markdown-convert': {
      const dir = arg('dir');
      if (!dir) out({ command: 'markdown-convert', error: '缺少 --dir <材料目录>' }, ERR);
      const prepared = await markdownTask(dir, 'markdown-convert');
      const materials = await convertMarkdownMaterials(dir, prepared.task, prepared.inventory);
      const blocking = materials.filter((item) => item.status !== 'converted');
      out({
        command: 'markdown-convert',
        task: { taskId: prepared.task.taskId, workspace: taskDir(prepared.task) },
        inventoryVersionId: prepared.inventory.versionId,
        schemaPath: PDF_MARKDOWN_SCHEMA_PATH,
        materials,
        readyForNextStep: blocking.length === 0,
        next: blocking.length
          ? '先处理 MarkItDown 转换失败的材料；转换成功后，读取每份 numberedMarkdownPath 并按 templatePath 填写 candidatePath'
          : '逐份读取 numberedMarkdownPath，按 templatePath 填写 candidatePath，再运行 markdown-ingest',
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'markdown-ingest': {
      const dir = arg('dir');
      if (!dir) out({ command: 'markdown-ingest', error: '缺少 --dir <材料目录>' }, ERR);
      const prepared = await markdownTask(dir, 'markdown-ingest');
      const records = [];
      for (const material of prepared.inventory.materials.filter((item) => item.format === 'pdf'
        && item.disposition === 'pending_classification')) {
        const paths = markdownMaterialPaths(prepared.task, prepared.inventory.versionId, material.materialId);
        const sourcePath = path.join(path.resolve(dir), material.relPath);
        let artifact;
        try {
          artifact = loadMarkdownArtifact(paths.artifactPath, { sourcePath, materialId: material.materialId });
        } catch (error) {
          records.push({ materialId: material.materialId, fileName: material.fileName,
            status: 'conversion_required', error: error.message, paths });
          continue;
        }
        if (artifact.status !== 'converted') {
          records.push({ materialId: material.materialId, fileName: material.fileName,
            status: 'conversion_required', error: artifact.error, paths });
          continue;
        }
        const sidecars = validateMarkdownSidecars(artifact, paths);
        if (!sidecars.ok) {
          records.push({ materialId: material.materialId, fileName: material.fileName,
            status: 'sidecar_invalid', error: sidecars.reason, paths });
          continue;
        }
        if (!fs.existsSync(paths.candidatePath)) {
          records.push({ materialId: material.materialId, fileName: material.fileName,
            status: 'candidate_required', paths, markdownHash: artifact.source.markdownHash });
          continue;
        }
        try {
          const result = await ingestMarkdown({ artifact, submission: paths.candidatePath,
            outputPath: paths.candidateRecordPath, overwrite: true });
          if (result.verdict === 'accepted') {
            fs.rmSync(paths.reextractPath, { force: true });
            records.push({ materialId: material.materialId, fileName: material.fileName,
              status: 'accepted', candidateRecordPath: paths.candidateRecordPath,
              markdownHash: artifact.source.markdownHash });
          } else {
            writeDerived(paths.reextractPath, `${JSON.stringify({ schemaVersion: 1,
              taskId: prepared.task.taskId, versionId: prepared.inventory.versionId,
              materialId: material.materialId, contentHash: material.contentHash,
              markdownHash: artifact.source.markdownHash, reason: 'candidate_rejected',
              errors: result.errors ?? [], requestedAt: new Date().toISOString() }, null, 2)}\n`);
            records.push({ materialId: material.materialId, fileName: material.fileName,
              status: 'rejected', errors: result.errors, paths });
          }
        } catch (error) {
          writeDerived(paths.reextractPath, `${JSON.stringify({ schemaVersion: 1,
            taskId: prepared.task.taskId, versionId: prepared.inventory.versionId,
            materialId: material.materialId, contentHash: material.contentHash,
            markdownHash: artifact.source.markdownHash, reason: 'candidate_rejected',
            errors: [error.message], requestedAt: new Date().toISOString() }, null, 2)}\n`);
          records.push({ materialId: material.materialId, fileName: material.fileName,
            status: 'rejected', errors: [error.message], paths });
        }
      }
      const blocking = records.filter((item) => item.status !== 'accepted');
      out({
        command: 'markdown-ingest',
        task: { taskId: prepared.task.taskId, workspace: taskDir(prepared.task) },
        inventoryVersionId: prepared.inventory.versionId,
        records,
        readyForNextStep: blocking.length === 0,
        next: blocking.length ? '候选未全部通过内核校验，修正 candidatePath 后重新运行'
          : '候选已落盘；下一步运行 classify 生成当前分类账本',
      }, records.some((item) => !['accepted', 'candidate_required', 'rejected'].includes(item.status))
        ? BLOCKED : OK);
    }

    case 'classify': {
      const dir = arg('dir');
      if (!dir) out({ command: 'classify', error: '缺少 --dir <材料目录>' }, ERR);

      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) {
        const recovery = await validateLocalPreparationRecovery(dir);
        if (!recovery.ok) out({ command: 'classify', ...recoveryBlocked(existing, recovery),
          note: '本地恢复 fresh 只读核对没有通过，不能在动过 ERP 的任务上做分类' }, BLOCKED);
      }

      // 分流永远建立在一个确定的盘点版本之上，所以这里先重新盘一次（幂等）。
      // 盘点层还有硬阻塞时不往下解析：范围外和读不出来的材料先解决，再谈票种。
      const inventory = await takeInventoryForTask(dir, existing);
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

      const classification = classifyInventory(dir, inventory, rec.task,
        { mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
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
          supersededVersionId: rec.supersededVersionId, materialCount: inventory.materials.length,
          excludedCount: inventory.excluded.length, scopeMismatches: inventory.scopeMismatches },
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
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) out({ command: 'ocr-request', ...recoveryBlock(existing),
        note: '动过 ERP 的任务不能重新开始看图读取' }, BLOCKED);
      const inventory = await takeInventoryForTask(dir, existing);
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);
      const classification = classifyInventory(dir, inventory, rec.task,
        { mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
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
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) out({ command: 'ocr-submit', ...recoveryBlock(existing),
        note: '动过 ERP 的任务不能重新提交看图读数' }, BLOCKED);
      const inventory = await takeInventoryForTask(dir, existing);
      const task = existing;
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
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) out({ command: 'reread-submit', ...recoveryBlock(existing),
        note: '动过 ERP 的任务不能重新提交看图争议读数' }, BLOCKED);
      const inventory = await takeInventoryForTask(dir, existing);
      const task = existing;
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
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      if (hasErpWriteState(existing)) out({ command: 'confirm-readings', ...recoveryBlock(existing),
        note: '动过 ERP 的任务不能重新确认看图读数' }, BLOCKED);
      const inventory = await takeInventoryForTask(dir, existing);
      const task = existing;
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
      const { task, inventory, classification, blocked } = await upToClassification(dir,
        { allowRecovery: true, mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
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
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      let recovery = null;
      if (hasErpWriteState(existing)) {
        recovery = await validateLocalPreparationRecovery(dir);
        if (!recovery.ok) out({ command: 'select-task', ...recoveryBlocked(existing, recovery),
          readyForNextStep: false }, BLOCKED);
      }
      const { task, built, blocked } = await upToEvents(dir,
        { allowRecovery: hasErpWriteState(existing),
          mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
      if (blocked) out({ command: 'select-task', ...blocked }, BLOCKED);

      if (hasErpWriteState(task) && !recovery?.ok) {
        out(recoveryBlock(task, 'select-task'), BLOCKED);
      }
      const session = await gateIdentity();
      if (session.status !== 'matched') {
        out({ command: 'select-task', ...session,
          note: '身份没核对通过，不打开项目选择页' }, BLOCKED);
      }
      const identity = session.identity;
      if (!sameIdentity(task.identity, identity)) {
        out({ command: 'select-task', status: 'identity_mismatch',
          task: { taskId: task.taskId, identity: task.identity ?? null, workspace: taskDir(task) },
          identity,
          note: '任务所属 tenant/account 与当前登录身份不一致；不把旧任务改绑到另一身份' }, BLOCKED);
      }
      const classified = await observeTask(dir,
        { mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
      if (classified.homeCityRequired || !classified.task?.homeCity) {
        out({ command: 'select-task', status: 'blocked', state: 'home_city_required',
          task: { taskId: task.taskId, workspace: taskDir(task) },
          note: '任务还没有当前身份的常驻城市快照，先完成常驻城市确认' }, BLOCKED);
      }
      if ((classified.openItems ?? []).some((item) => item.blocking)) {
        out({ command: 'select-task', status: 'blocked', state: 'intake_open_items',
          task: { taskId: task.taskId, workspace: taskDir(task) },
          openItems: classified.openItems.filter((item) => item.blocking),
          note: '分类明细还有未清的硬阻塞，不能进入项目选择' }, BLOCKED);
      }
      if (!classified.classifiedDetailComplete) {
        out({ command: 'select-task', status: 'blocked', state: 'classify_pending',
          task: { taskId: task.taskId, workspace: taskDir(task) },
          classifiedDetailComplete: classified.classifiedDetailComplete,
          note: '分类明细尚未整理完整，不能进入项目选择' }, BLOCKED);
      }
      const candidates = selectableProjects(identity);
      const book = readBook(identity);
      if (candidates.length === 0) {
        out({ command: 'select-task', status: PROJECT_BOOK_EMPTY,
          identity, task: { taskId: task.taskId, workspace: taskDir(task) },
          bookPath: bookPath(identity), projectCount: book.projects.length,
          selectableCount: 0, note: noCandidatesNote(book.projects) }, BLOCKED);
      }

      // 只有同一批明细、同一身份且确实来自个人项目簿的选择才作预填。
      // 全局旧选择保留为事实，但没有个人项目簿来源证据时不自动合法化。
      const previous = loadSelection(task);
      const prev = sameBasis(previous, built) && isBookSelection(previous)
        && sameIdentity(previous.identity, identity) ? previous : null;
      const previousSelectionWarning = previous && !prev
        ? '上一次记录没有当前本人项目簿来源证据，或已经过期；它不会自动沿用，请重新从本人项目簿确认。'
        : null;
      const classifiedDigest = classifiedDetailDigest(classified.classifiedPreview);
      const previewLines = classified.classifiedPreview?.lines ?? classified.lines ?? built.lineItems;
      const lines = previewLines.map((l) => {
        const ev = built.events.find((e) => e.eventId === l.eventId);
        return { lineId: l.lineId, fileName: ev.voucherFileName, kindLabel: ev.kindLabel,
          maskedNumber: l.maskedNumber, date: l.date, city: l.city, route: l.route,
          totalAmount: l.totalAmount, categoryLabel: l.categoryLabel ?? null,
          expenseItemCode: l.expenseItemCode ?? null, project: prev?.projects?.[l.lineId] ?? '' };
      });

      const result = await serveTaskSelection(
        { lines, projects: candidates, previousSelectionWarning,
          homeCity: task.homeCity, purpose: prev?.purpose ?? '' },
        { timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
          onReady: (u) => process.stderr.write(`已在浏览器里打开页面（做任务选择）；没弹出就手动打开：${u}\n`),
          onSubmit: async (body) => {
            const current = await gateIdentity();
            if (current.status !== 'matched') {
              return { verdict: 'rejected', reasons: ['提交时身份没有通过核对，任务选择没有收下'], status: current.status };
            }
            if (!sameIdentity(task.identity, current.identity)) {
              return { verdict: 'rejected', reasons: ['提交时 tenant/account 已变化，任务选择没有收下'],
                status: 'identity_mismatch' };
            }
            const existingNow = findLiveTaskForSource(sourceKeyOf(dir));
            let currentRecovery = null;
            if (hasErpWriteState(existingNow)) {
              currentRecovery = await validateLocalPreparationRecovery(dir);
              if (!currentRecovery.ok) return {
                ...recoveryBlocked(existingNow, currentRecovery, 'select-task'), verdict: 'rejected',
                reasons: currentRecovery.reasons ?? ['提交时本地恢复 fresh 只读核对没有通过'],
              };
            }
            const latest = await upToEvents(dir,
              { allowRecovery: hasErpWriteState(existingNow),
                mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
            if (latest.blocked || !latest.task || latest.task.taskId !== task.taskId) {
              return { verdict: 'rejected', reasons: [latest.blocked?.note ?? '提交时任务事实已变化，任务选择没有收下'],
                status: latest.blocked ? 'task_changed' : 'task_missing' };
            }
            if (hasErpWriteState(latest.task) && !currentRecovery?.ok) {
              return { verdict: 'rejected', reasons: ['提交时任务已经动过 ERP，不能收下新的项目选择'],
                status: 'erp_write_in_progress' };
            }
            const currentSnapshot = await observeTask(dir,
              { mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
            if (currentSnapshot.homeCityRequired || currentSnapshot.task?.homeCity !== task.homeCity
              || !currentSnapshot.classifiedDetailComplete) {
              return { verdict: 'rejected', reasons: ['提交时常驻城市或分类明细已变化，请重新打开任务选择页'],
                status: 'classified_detail_changed' };
            }
            if (classifiedDetailDigest(currentSnapshot.classifiedPreview) !== classifiedDigest) {
              return { verdict: 'rejected', reasons: ['提交时材料分类明细已变化，请重新确认后再选择项目'],
                status: 'classified_detail_changed' };
            }
            if ((currentSnapshot.openItems ?? []).some((item) => item.blocking)) {
              return { verdict: 'rejected', reasons: ['提交时分类明细出现新的硬阻塞，请先处理后再选择项目'],
                status: 'classified_detail_blocked' };
            }
            const freshCandidates = selectableProjects(current.identity);
            const previousNow = loadSelection(latest.task);
            return submitSelection(latest.task, latest.built, body, freshCandidates,
              current.identity, previousNow);
          } });
      if (result?.status === 'timeout') {
        out({ command: 'select-task', ...result,
          note: '任务选择页超时，没有收下任何新的项目归属' }, ERR);
      }
      if (result?.verdict !== 'accepted') {
        out({ command: 'select-task', ...result,
          note: '任务选择没有收到一份已核验的提交结果' }, ERR);
      }

      const r = result.verdict ? result : submitSelection(task, built, result,
        candidates, identity, prev);
      if (r.verdict === 'rejected') {
        out({ command: 'select-task', verdict: r.verdict, reasons: r.reasons,
          note: '任务选择没有收下；重新跑 select-task' }, BLOCKED);
      }
      out({ command: 'select-task', verdict: r.verdict,
        homeCity: r.record.homeCity, purpose: r.record.purpose,
        lineCount: Object.keys(r.record.projects).length,
        projectSource: r.record.projectSource,
        projectsFrom: r.record.projectsFrom,
        note: '项目号来自当前本人项目簿；录入项目时已从 ERP 回读名称，任务提交时又核验了当前可选集合' }, OK);
    }

    case 'lines': {
      // 候选明细的最终形态：费用事实来自材料，费用类别来自内核推导，
      // 项目归属和事由来自任务选择页。三样来源在输出里各自标明，不混。
      const dir = arg('dir');
      if (!dir) out({ command: 'lines', error: '缺少 --dir <材料目录>' }, ERR);
      const { task, classification, built, blocked } = await upToEvents(dir,
        { allowRecovery: true, mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
      if (blocked) out({ command: 'lines', ...blocked }, BLOCKED);

      const current = await gateIdentity();
      if (current.status !== 'matched') {
        out({ command: 'lines', ...current,
          note: '身份没核对通过，不沿用项目选择计算明细' }, BLOCKED);
      }
      const applied = applySelection(built, classification, loadSelection(task),
        loadCatalogVerification(task), selectableProjects(current.identity), current.identity, task.homeCity);
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
      const up = await upToClassification(dir, { allowRecovery: true,
        mode: has('legacy-comparison') ? 'legacy' : 'markdown' });
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

    case 'prepare': {
      const dir = arg('dir');
      if (!dir) out({ command: 'prepare', error: '缺少 --dir <材料目录>' }, ERR);
      if (!(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
        out({ command: 'prepare', status: 'blocked',
          error: `材料目录不存在：${dir}`,
          speak: `我找不到这个材料目录：${dir}。准备包没有生成。` }, BLOCKED);
      }

      // Keep the direct CLI entry behind the same environment and task gates
      // as `next`; otherwise a hand-written `prepare` invocation could skip
      // identity, classification confirmation, or project/catalog checks.
      const environment = await observeEnvironment();
      const environmentState = determineState(environment);
      if (environmentState.state !== 'env_ready') {
        out({ command: 'prepare', status: 'blocked', state: environmentState.state,
          blockedBy: environmentState.blockedBy,
          note: '当前身份或 ERP 会话尚未通过环境核对，准备包没有生成。' }, BLOCKED);
      }

      // This command is the sole preparation materialization step.  It uses
      // the same read-only observation as `next`, then writes one immutable
      // digest directory outside the source tree.  A draft is still a
      // successful run because its explicit problems are useful for review.
      const observed = await observeTask(dir);
      const taskIdentity = observed.task?.identity;
      const currentIdentity = environment.probe?.identity;
      if (taskIdentity && currentIdentity
        && (taskIdentity.account !== currentIdentity.account || taskIdentity.tenant !== currentIdentity.tenant)) {
        out({ command: 'prepare', status: 'blocked', state: 'task_identity_mismatch',
          task: observed.task,
          note: '当前登录身份与任务绑定身份不一致，准备包没有生成。' }, BLOCKED);
      }
      const combinedState = determineState({ ...environment, ...observed });
      const allowed = new Set(['preparation_package_pending', 'preparation_blocked',
        'preparation_confirmation', 'erp_write_pending', 'erp_write_complete']);
      if (!allowed.has(combinedState.state)) {
        out({ command: 'prepare', status: 'blocked', state: combinedState.state,
          blockedBy: combinedState.blockedBy,
          task: observed.task ?? null,
          note: '前置步骤尚未完成，先按 next 给出的步骤处理；这里只生成最后一段准备材料。' }, BLOCKED);
      }
      if (!observed.preparation || !observed.taskRecord || !observed.inventory) {
        out({ command: 'prepare', status: 'blocked',
          stage: 'preparation', task: observed.task ?? null,
          problems: observed.openItems ?? [],
          note: '前置材料、分类、事件或项目选择尚未完成；先按 next 给出的步骤处理，当前还不能生成准备包' }, BLOCKED);
      }
      let generated;
      try {
        generated = await generatePreparation({
          task: observed.taskRecord,
          sourceDir: dir,
          inventory: observed.inventory,
          preparation: observed.preparation,
        });
      } catch (error) {
        out({ command: 'prepare', status: 'blocked',
          task: { taskId: observed.taskRecord.taskId, workspace: taskDir(observed.taskRecord) },
          digest: observed.preparation.digest,
          code: error.code ?? 'PREPARATION_GENERATION_FAILED',
          error: error.message,
          note: '准备包没有生成；原材料目录保持不变。' }, BLOCKED);
      }
      out({
        command: 'prepare',
        status: generated.ready ? 'ready_for_preparation' : 'draft',
        ready: generated.ready === true,
        task: { taskId: generated.document.task.taskId, workspace: taskDir(observed.taskRecord) },
        digest: generated.digest,
        problems: generated.problems ?? [],
        directory: generated.directory,
        files: generated.files ?? observed.preparationPackage?.files ?? null,
        manifest: generated.manifest
          ? { manifestHash: generated.manifest.manifestHash, bundleHash: generated.manifest.bundleHash,
              ready: generated.manifest.ready === true, status: generated.manifest.status }
          : null,
        note: generated.ready
          ? '准备包已生成并通过物化；接下来由 next 展示准备确认，确认后停止在手动 QA，不会写入 ERP。'
          : '准备包已生成为 draft；请先处理 detail.md/detail.json 和 manifest 中列出的缺项，再重新观察。',
      });
    }

    case 'next': {
      // 模型唯一会敲的命令。问：`next --dir <材料目录>`；答：`next --after <token> [--result <文件>]`。
      // 这里是一层薄壳：采观测（observe）-> 判状态（state）-> 出 step（next），
      // 判断本身一点浏览器和文件系统都不碰，所以能在没有 Chrome 的机器上测。
      // 问得不对就答不了：这两种都不是状态机里的状态（那两张表里没有它们），
      // 而是「这一问根本没法判」，所以走 error + 1，不冒充成一个 step。
      const dir = arg('dir');
      const homeCitySuggestion = arg('home-city-suggestion');
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
      let env = await observeEnvironment();
      // 数据格式比内核新的时候，**连采集都不做**。判定的顺序把 schema_too_new 排在最前，
      // 但采集跑在判定之前：拿这一版的眼睛去读下一版写的任务文件，可能当场抛异常，
      // 于是「硬停（退出码 2）」就变成了「内核自己出错（退出码 1）」。硬停要真的最先。
      const tooNew = env.schemaVersion > NEXT_SCHEMA_VERSION;
      if (!tooNew && env.probe?.status === 'matched' && !env.binding) {
        env = { ...env, binding: autoBindIdentity(env.probe.identity, env.binding) };
      }
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

      // 先做普通的只读材料观测。恢复 fresh 回读是显式例外：只对已经存在的
      // upload_dispatched 任务调用，普通 `observeTask` 仍然不碰浏览器。
      // Runtime setup is a prerequisite for every material parser. Keep this
      // gate before observeTask so a missing managed runtime cannot trigger a
      // partial inventory/classification pass before its install step.
      const locationProvider = env.probe?.status === 'matched'
        && bindingVerdict(env.binding, env.probe.identity) === 'matched'
        && process.env.BAOX_LOCATION_MODE !== 'off'
        ? lookupNetworkLocation : null;
      const taskObservation = materialsThere && env.runtimeDependencies?.ready === true
        ? await observeTask(sourceDir, { homeCitySuggestion, locationProvider }) : {};
      let recovery = null;
      // A recovery read needs the same Chromium page as ERP writes. Let the
      // state machine issue `chrome-up` first; never enter recovery code with
      // a missing CDP connection and leak its low-level exception.
      const chromiumAutomationReady = env.chromiumAutomation?.required !== true
        || env.chromiumAutomation.ready === true;
      if (materialsThere && hasRecoveryMarker(taskObservation.task) && chromiumAutomationReady) {
        const checked = env.probe?.status === 'matched'
          ? await validateLocalPreparationRecovery(sourceDir)
          : { ok: false, status: 'environment_not_ready',
            reasons: ['当前 ERP 身份没有通过环境核对，暂不能 fresh 回读恢复凭据'] };
        recovery = {
          valid: checked.ok === true,
          status: checked.status ?? 'rejected',
          ...(checked.credentialPath ? { credentialPath: checked.credentialPath } : {}),
          ...(checked.credential?.credentialId
            ? { credentialId: checked.credential.credentialId } : {}),
          ...(checked.reasons?.length ? { reasons: checked.reasons } : {}),
        };
      }
      const observation = {
        ...env,
        // Runtime and browser setup may intentionally skip observeTask, but
        // the caller's directory still belongs to this step token. Preserve
        // it so a later `next --after` can resume material observation.
        ...(sourceDir ? { sourceDir } : {}),
        // 环境那份观测采在表态落盘**之前**（它要先算出 tooNew 才谈得上收表态），
        // 所以刚认下的身份要补回来 —— 不补的话这一次应答仍然报 `env_identity_unbound`，
        // 用户刚认完就又看见同一张表，而绑定其实已经写进去了。
        // 材料那半份观测在下面重采，本来就带着最新的事实，不需要这样补。
        ...(applied?.verdict === 'identity_bound' ? { binding: applied.binding } : {}),
        ...taskObservation,
        ...(applied?.verdict === 'profile_confirmed'
          ? { profileConfirmationRequired: false } : {}),
        ...(recovery ? { recovery } : {}),
      };
      const response = nextResponse({ observation, sourceKey, after,
        hasResult: filed('result'),
        resultPath: filed('result') ? arg('result') : null,
        // 已经收下并处置过的纠正不再报「没处安放」—— 那句话是留给真的没处安放的。
        hasCorrection: filed('correction') && !applied });
      materializeStepArtifacts(response);
      // 收下了什么，明说。用户点了头却看不出内核收没收到，是最难排的一种障。
      out(applied ? { ...response, applied } : response, response.exit);
    }

    default:
      out({ error: `未知命令 ${cmd ?? '(空)'}`, commands: ['next', 'runtime-setup', 'doctor', 'browser-open', 'chrome-up', 'probe', 'confirm-identity', 'intake', 'classify',
        'ocr-request', 'ocr-submit', 'confirm-readings', 'reread-submit', 'markdown-convert', 'markdown-ingest',
        'history', 'events', 'select-task', 'lines', 'projects', 'projects-page', 'scope-materials',
        'resume-local-preparation',
        'prepare',
        'tasks', 'abandon-task', 'reset', 'catalog', 'erp-read', 'erp-reconcile', 'erp-write', 'erp-fill'] }, ERR);
  }
} catch (err) {
  out({ command: cmd, error: err.message, code: err.code ?? null }, ERR);
}
