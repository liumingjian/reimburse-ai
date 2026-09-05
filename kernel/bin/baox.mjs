#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { paths, ensureDir } from '../src/paths.mjs';
import * as chrome from '../src/chrome.mjs';
import { probeIdentity, ERP_ORIGIN } from '../src/probe.mjs';
import { serveSelection, serveConfirmation, serveAllocation, serveTaskSelection } from '../src/serve.mjs';
import { buildWorkOrder, ingestReadings, confirmReadings, loadReading,
  READING_VERSION, DOC_TYPES } from '../src/vision.mjs';
import { takeInventory, intakeOpenItems } from '../src/inventory.mjs';
import { classifyInventory, classifyOpenItems, summarize } from '../src/classify.mjs';
import { buildEvents, eventOpenItems, reconcile, submitAllocation } from '../src/events.mjs';
import { maskNumber } from '../src/parse.mjs';
import { loadSelection, submitSelection, applySelection } from '../src/selection.mjs';
import { CATEGORIES } from '../src/categories.mjs';
import { findLiveTaskForSource, createTask, recordInventory, recordClassification,
  recordEvents, recordInvoiceSightings, abandonTask, loadIndex,
  sourceKeyOf, taskDir } from '../src/workspace.mjs';
import { crossTaskDuplicates, historyOpenItems, holdsInvoices } from '../src/history.mjs';

// 退出码是给 Skill 用的确定性信号：
//   0 完成   1 内核出错   2 硬阻塞（内核拒绝继续，任何"确认继续"都不能绕过）
const OK = 0, ERR = 1, BLOCKED = 2;

const out = (obj, code = OK) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); process.exit(code); };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const yuan = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));
const maskOf = (classification, materialId) =>
  maskNumber(classification.results.find((r) => r.materialId === materialId)?.fields?.invoiceNumber);

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

try {
  switch (cmd) {
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
      out({ command: 'doctor', platform: process.platform, checks,
        ready: checks.node.ok && checks.chrome.ok }, checks.node.ok && checks.chrome.ok ? OK : ERR);
    }

    case 'install-runtime': {
      // 内核零依赖，所以"安装"就是把这份源码整份拷进 baox 数据目录。
      // 三个 Skill 都调用数据目录里的这一份，避免各自夹带一份导致版本漂移。
      const self = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
      const dest = path.join(paths.root, 'runtime');
      const version = fs.readFileSync(path.join(self, 'VERSION'), 'utf8').trim();
      const installed = fs.existsSync(path.join(dest, 'VERSION'))
        ? fs.readFileSync(path.join(dest, 'VERSION'), 'utf8').trim() : null;
      ensureDir(paths.root);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(self, dest, { recursive: true });
      out({ command: 'install-runtime', from: self, to: dest, version, replaced: installed,
        entry: path.join(dest, 'bin', 'baox.mjs') });
    }

    case 'chrome-up': {
      const info = await chrome.launch({ openUrl: arg('url', `${ERP_ORIGIN}/k3cloud/html5/index.aspx`) });
      out({ command: 'chrome-up', ...info, profile: paths.chromeProfile,
        note: '这是 baox 专用的 Chrome 实例和独立 profile，和你日常那个 Chrome 互不影响；请在这个窗口里用你本人的账号登录 ERP' });
    }

    case 'probe': {
      const r = await probeIdentity({ expected: arg('expect') });
      out({ command: 'probe', ...r }, r.status === 'matched' ? OK : BLOCKED);
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
        note: '通过结构校验的读数已存为字段候选；跑 confirm-readings 让用户对着原图确认',
      }, rejected.length ? BLOCKED : OK);
    }

    case 'confirm-readings': {
      const dir = arg('dir');
      if (!dir) out({ command: 'confirm-readings', error: '缺少 --dir <材料目录>' }, ERR);
      const inventory = await takeInventory(dir);
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      if (!task) out({ command: 'confirm-readings', error: '这个目录还没有进行中的报销任务，先跑 intake' }, ERR);

      const pending = [];
      for (const m of inventory.materials) {
        const r = loadReading(task, m.materialId);
        if (!r || r.contentHash !== m.contentHash || r.confirmedAt) continue;
        pending.push({
          materialId: m.materialId,
          fileName: m.fileName,
          docTypeLabel: DOC_TYPES[r.docType]?.label ?? r.docType,
          fields: Object.entries(r.fields),
          unreadable: r.unreadable ?? [],
        });
      }
      if (!pending.length) out({ command: 'confirm-readings', pending: 0, note: '没有待确认的看图读数' }, OK);

      const result = await serveConfirmation({ items: pending }, {
        timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
        onReady: (u) => process.stderr.write(`打开这个地址核对看图读数：${u}\n`),
      });
      if (result.status !== 'submitted') out({ command: 'confirm-readings', ...result }, ERR);

      const done = confirmReadings(task, result.confirmed);
      const skipped = pending.filter((p) => !done.materialIds.includes(p.materialId)).map((p) => p.fileName);
      out({
        command: 'confirm-readings',
        confirmed: done.materialIds.length,
        confirmedAt: done.confirmedAt,
        skipped,
        note: skipped.length
          ? '没有勾选的材料仍停在待确认项里；用户不勾就是不认，不要替他确认'
          : '全部读数已确认，可以重新跑 classify',
      }, skipped.length ? BLOCKED : OK);
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

    case 'allocate': {
      // 合并交通发票的逐段金额。**只有这个页面上的提交动作能把金额定下来**；
      // 行程单金额只作预填候选，用户在对话里报的数字同样不算数。
      const dir = arg('dir');
      if (!dir) out({ command: 'allocate', error: '缺少 --dir <材料目录>' }, ERR);
      const { task, classification, blocked } = await upToClassification(dir);
      if (blocked) out({ command: 'allocate', ...blocked }, BLOCKED);

      const built = buildEvents(classification, task);
      const pending = built.notes.filter((n) => n.kind === 'allocation_required' || n.kind === 'allocation_stale');
      if (!pending.length) out({ command: 'allocate', pending: 0, note: '没有需要逐段分摊的发票' }, OK);

      const items = pending.map((n) => {
        // 逐段行来自与这张发票关联上的行程单，由 buildEvents 一并带出来。
        const rows = n.candidateSegments;
        return {
          materialId: n.materialId,
          fileName: n.fileName,
          maskedNumber: maskOf(classification, n.materialId),
          totalAmount: n.totalAmount,
          candidateFrom: rows ? '行程单逐段明细' : null,
          segments: rows ?? Array.from({ length: n.segmentCount }, () => ({ date: null, city: null, route: null, amount: '' })),
        };
      });

      const result = await serveAllocation({ items }, {
        timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
        onReady: (u) => process.stderr.write(`打开这个地址填写逐段金额：${u}\n`),
      });
      if (result.status !== 'submitted') out({ command: 'allocate', ...result }, ERR);

      const verdicts = [];
      for (const it of items) {
        const v = classification.results.find((r) => r.materialId === it.materialId);
        const r = submitAllocation(task, v, result.allocations[it.materialId], it.segments.length);
        verdicts.push({ materialId: it.materialId, fileName: it.fileName, verdict: r.verdict, reasons: r.reasons });
      }
      const rejected = verdicts.filter((v) => v.verdict === 'rejected');
      out({ command: 'allocate', verdicts, accepted: verdicts.length - rejected.length, rejected: rejected.length,
        note: rejected.length ? '有分摊没有收下；重新跑 allocate' : '逐段金额已记下，可以重新跑 events' },
        rejected.length ? BLOCKED : OK);
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
          onReady: (u) => process.stderr.write(`打开这个地址做任务选择：${u}\n`) });
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

      const applied = applySelection(built, classification, loadSelection(task));
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

    case 'select': {
      const specPath = arg('spec');
      if (!specPath) out({ command: 'select', error: '缺少 --spec <file.json>' }, ERR);
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const r = await serveSelection(spec, {
        timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
        onReady: (url) => process.stderr.write(`打开这个地址做选择：${url}\n`),
      });
      out({ command: 'select', ...r }, r.status === 'submitted' ? OK : ERR);
    }

    default:
      out({ error: `未知命令 ${cmd ?? '(空)'}`, commands: ['doctor', 'install-runtime', 'chrome-up', 'probe', 'intake', 'classify',
        'ocr-request', 'ocr-submit', 'confirm-readings', 'history', 'events', 'allocate', 'select-task', 'lines',
        'tasks', 'abandon-task', 'select'] }, ERR);
  }
} catch (err) {
  out({ command: cmd, error: err.message, code: err.code ?? null }, ERR);
}
