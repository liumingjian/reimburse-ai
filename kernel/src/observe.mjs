/**
 * 采集观测。这里是**唯一**碰文件系统、ego task space 和时钟的地方，判定在 state.mjs 里。
 *
 * 这样分开，是为了让状态判定的测试能在一台没有 ego-browser 的机器上跑完 ——
 * 采集这一侧本来就只能在真机上验，把判断混进来就等于把判断也搬上真机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, SCHEMA_FILE } from './paths.mjs';
import { SCHEMA_VERSION } from './state.mjs';
import { probeIdentity } from './probe.mjs';
import { isEgoControlError } from './ego.mjs';
import { browserMode, EGO_BROWSER, SYSTEM_BROWSER } from './browser-open.mjs';
import { chromiumCdpTransport } from './browser-read.mjs';
import { CDP_PORT, version as chromiumVersion } from './chrome.mjs';
import { readBinding } from './binding.mjs';
import { readHomeCity, validHomeCity } from './home-city.mjs';
import { takeInventoryForTask, intakeOpenItems } from './inventory.mjs';
import { classifyInventory, classifyOpenItems } from './classify.mjs';
import { buildWorkOrder, pendingConfirmations } from './vision.mjs';
import { openDisputes } from './dispute.mjs';
import { findLiveTaskForSource, sourceKeyOf, taskDir, classificationRecorded,
  loadEventsLedger, loadCatalogVerification, hasErpWriteState, loadIndex } from './workspace.mjs';
import { crossTaskDuplicates, historyOpenItems } from './history.mjs';
import { buildEvents, eventOpenItems, ALLOCATION_KINDS } from './events.mjs';
import { allocationRound, givenUpOpenItems } from './allocate.mjs';
import { loadSelection, applySelection, linesDigest, sameBasis, isBookSelection } from './selection.mjs';
import { loadWriteApproval, approvalCovers } from './erpwrite.mjs';
import { readBook, selectableProjects, sameIdentity } from './projects.mjs';
import { classifiedDetailComplete, classifiedDetailConfirmed, classifiedCorrectionOptions } from './classified-detail.mjs';
import { buildPreparation, inspectPreparation } from './preparation.mjs';
import { inspectRuntimeDependencies } from './runtime-dependencies.mjs';

// Catalog records written before the preparation handoff did not retain the
// expense-item read-only projection.  They remain useful history, but cannot
// prove that the current preparation has a canonical ERP expense-item name.
const CATALOG_SCHEMA_VERSION = 2;
const COMPLETE_PROJECT_VERDICTS = new Set([
  'confirmed', 'missing', 'not_found', 'ambiguous', 'unusable', 'name_mismatch',
]);

const catalogExpenseItems = (catalog) => Array.isArray(catalog?.expenseItems)
  ? catalog.expenseItems
  : (Array.isArray(catalog?.expenseItems?.checked)
    ? catalog.expenseItems.checked
    : (Array.isArray(catalog?.expenseItemCatalog) ? catalog.expenseItemCatalog : null));

const catalogExpenseProblems = (catalog) => [
  ...(Array.isArray(catalog?.problems) ? catalog.problems : []),
  ...(Array.isArray(catalogExpenseItems(catalog))
    ? catalogExpenseItems(catalog).filter((item) => item?.verdict !== 'confirmed')
    : []),
];

const catalogHasExpenseProjection = (catalog, lines) => {
  if (catalog?.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION) return false;
  const checked = catalogExpenseItems(catalog);
  if (!Array.isArray(checked)) return false;
  const byCode = new Map(checked.map((item) => [item?.code, item]));
  return (lines ?? []).filter((line) => line?.expenseItemCode).every((line) => {
    const item = byCode.get(line.expenseItemCode);
    // Keep a complete read (including a negative verdict) fresh enough for
    // catalog_mismatch to show the recorded reason.  The expected canonical
    // name is the static expense-item mapping; a name_mismatch record carries
    // the ERP name separately as erpName and remains a visible problem.
    return !!item && (item.name ?? null) === (line.expenseItemName ?? null);
  });
};

const catalogProjectRecords = (catalog) => {
  if (Array.isArray(catalog?.projects)) {
    return new Map(catalog.projects
      .map((record) => [record?.number, record])
      .filter(([number]) => typeof number === 'string' && number.length > 0));
  }
  if (catalog?.projects && typeof catalog.projects === 'object') {
    return new Map(Object.entries(catalog.projects));
  }
  return new Map();
};

const selectionSnapshotOf = (selection, candidates) => {
  const projects = selection?.projects && typeof selection.projects === 'object'
    ? Object.fromEntries(Object.entries(selection.projects).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  if (!projects) return null;
  const selected = [...new Set(Object.values(projects))]
    .filter((number) => typeof number === 'string' && number.trim())
    .sort();
  const byNumber = new Map((candidates ?? [])
    .map((candidate) => [candidate?.number, candidate])
    .filter(([number]) => typeof number === 'string' && number.length > 0));
  return {
    projects,
    projectBook: selected.map((number) => ({
      number,
      name: typeof byNumber.get(number)?.name === 'string' ? byNumber.get(number).name : null,
    })),
  };
};

const catalogSelectionFresh = (catalog, selection, candidates) => {
  const expected = selectionSnapshotOf(selection, candidates);
  const actual = catalog?.selectionSnapshot;
  if (!expected || !actual || typeof actual !== 'object'
    || JSON.stringify(actual.projects) !== JSON.stringify(expected.projects)) return false;
  const actualBook = Array.isArray(actual.projectBook) ? actual.projectBook : null;
  if (!actualBook || actualBook.length !== expected.projectBook.length) return false;
  const actualByNumber = new Map(actualBook.map((record) => [record?.number, record]));
  return expected.projectBook.every((record) => {
    const checked = actualByNumber.get(record.number);
    return !!checked && checked.name === record.name;
  });
};

/**
 * A catalog read is scoped to the owner and the exact selected project facts.
 * The line/version basis alone is insufficient: a copied catalog from another
 * account, or one whose project-book selection changed after the query, must
 * trigger a fresh read-only query.
 */
export function catalogFreshFor({ catalog, built, selection, candidates, identity, lines } = {}) {
  if (!sameBasis(catalog, built) || catalog?.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION
    || !sameIdentity(catalog?.identity, identity) || !isBookSelection(selection)
    || !catalogHasExpenseProjection(catalog, lines)
    || !catalogSelectionFresh(catalog, selection, candidates)) return false;

  const selected = new Set(Object.values(selection.projects ?? {})
    .filter((number) => typeof number === 'string' && number.trim()));
  const lineProjects = new Set((lines ?? [])
    .map((line) => line?.project)
    .filter((number) => typeof number === 'string' && number.trim()));
  if (selected.size === 0 || selected.size !== lineProjects.size
    || [...selected].some((number) => !lineProjects.has(number))) return false;

  const catalogProjects = catalogProjectRecords(catalog);
  return [...selected].every((number) => {
    const checked = catalogProjects.get(number);
    if (!checked || !COMPLETE_PROJECT_VERDICTS.has(checked.verdict)) return false;
    // Negative ERP results are still fresh observations; catalogProblems will
    // keep them in catalog_mismatch.  The project-book name is checked against
    // the query-time snapshot above, never against the ERP name: an ERP rename
    // is a business mismatch, while a later book edit is a stale query.
    // A verdict such as `not_found` is a business result, not evidence that
    // the query is stale; catalogProblems keeps it visible to the user.
    return true;
  });
}

const preparationConfirmationPath = (task) =>
  path.join(taskDir(task), 'preparation-confirmation.json');

const preparationPackageInfo = (inspection) => {
  if (!inspection?.directory) return null;
  const directory = inspection.directory;
  const files = inspection.manifest?.files ?? {};
  const pathsFor = (records) => (records ?? [])
    .map((record) => typeof record?.targetPath === 'string'
      ? path.join(directory, record.targetPath) : null)
    .filter(Boolean);
  return {
    status: inspection.status ?? (inspection.ok ? 'valid' : 'invalid'),
    current: inspection.ok === true,
    directory,
    digest: inspection.digest ?? inspection.manifest?.digest ?? null,
    manifestHash: inspection.manifest?.manifestHash ?? null,
    bundleHash: inspection.manifest?.bundleHash ?? null,
    files: {
      detailJson: path.join(directory, 'detail.json'),
      detailMarkdown: path.join(directory, 'detail.md'),
      manifest: path.join(directory, 'manifest.json'),
      invoices: pathsFor(files.invoices),
      evidence: pathsFor(files.evidence),
    },
  };
};

const preparationConfirmed = (task, digest, inspection) => {
  if (!task?.taskId || !digest || !inspection?.ok) return false;
  try {
    const record = JSON.parse(fs.readFileSync(preparationConfirmationPath(task), 'utf8'));
    return record.taskId === task.taskId
      && record.digest === digest
      && record.versionId === task.currentVersionId
      && record.manifestHash === inspection.manifest?.manifestHash
      && record.bundleHash === inspection.manifest?.bundleHash
      && (!task.identity || (record.identity?.account === task.identity.account
        && record.identity?.tenant === task.identity.tenant));
  } catch {
    return false;
  }
};

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
 * 只读探测由当前浏览器适配负责。正式模式使用系统默认浏览器；只有显式
 * `BAOX_BROWSER=ego` 才允许 ego task space 作为 QA transport。system transport
 * 的权限或能力失败必须原样留在观测里，不能把它伪造成「已登录」或旧的 Chrome down。
 */
export async function observeEnvironment({ versionFn = chromiumVersion } = {}) {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  const mode = browserMode();
  // Every browser transport uses the same managed runtime gate. The browser
  // mode only selects the page transport; it cannot make parsing dependencies
  // appear ready.
  const runtimeDependencies = inspectRuntimeDependencies();
  let cdpVersion = null;
  if (mode === SYSTEM_BROWSER) {
    try { cdpVersion = await versionFn(CDP_PORT); } catch { cdpVersion = null; }
  }
  const chromiumAutomation = mode === SYSTEM_BROWSER
    ? { required: true, ready: !!cdpVersion, port: CDP_PORT,
        browser: cdpVersion?.Browser ?? null }
    : { required: false, ready: true, port: null, browser: null };
  let probe = null;
  let browserReadError = null;
  try {
    probe = await probeIdentity(chromiumAutomation.ready && mode === SYSTEM_BROWSER
      ? { transport: chromiumCdpTransport() } : {});
  } catch (error) {
    // An explicit ego QA transport keeps its existing hard failure semantics.
    // In system mode a missing AppleEvents/browser capability is a user-visible
    // read problem, never a reason to claim an identity or silently skip gating.
    if (mode === EGO_BROWSER && isEgoControlError(error)) throw error;
    // A default browser that is not running is an empty-page condition.  Keep
    // it distinct from a denied read capability so `next` can issue the one
    // executable browser-open step instead of stopping on a permission error.
    if (mode === SYSTEM_BROWSER && error.code === 'DEFAULT_BROWSER_NOT_RUNNING') {
      probe = {
        status: 'no_tab',
        transport: 'default',
        code: error.code,
        hint: '系统默认浏览器当前没有运行；下一步会用系统默认 URL 打开 ERP',
      };
      browserReadError = null;
    } else {
      const message = mode === SYSTEM_BROWSER && error.code === 'EGO_TASK_SPACE_REQUIRED'
        ? '系统默认浏览器只读适配当前不可用；请确认浏览器自动化权限或能力支持后重试'
        : error.message;
      browserReadError = { code: error.code ?? 'BROWSER_READ_UNAVAILABLE', message };
      probe = { status: 'browser_read_unavailable', ...browserReadError,
        hint: message };
    }
  }
  const egoUp = mode === EGO_BROWSER && !browserReadError;
  const cdpUp = mode === SYSTEM_BROWSER ? true : egoUp;
  return {
    schemaVersion: readSchemaVersion(),
    nodeVersion: process.versions.node,
    nodeMajor,
    browserMode: mode,
    // cdpUp is retained for state-machine input compatibility. It only gates
    // the explicit ego QA transport; system browser reads do not use CDP.
    cdpUp,
    egoUp,
    egoError: mode === EGO_BROWSER ? browserReadError : null,
    browserReadError,
    chromiumAutomation,
    probe,
    binding: readBinding(),
    runtimeDependencies,
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
export async function observeTask(sourceDir, {
  mode = 'markdown', receiptFacts = null, homeCitySuggestion = null, locationProvider = null,
} = {}) {
  const dir = path.resolve(sourceDir);
  const task = findLiveTaskForSource(sourceKeyOf(dir));
  const employeeHomeCity = readHomeCity(readBinding())?.homeCity ?? null;
  const explicitHomeCitySuggestion = validHomeCity(homeCitySuggestion)
    ? homeCitySuggestion.trim() : null;
  let detectedLocation = null;
  if (!explicitHomeCitySuggestion && !task && !employeeHomeCity
    && typeof locationProvider === 'function') {
    try { detectedLocation = await locationProvider(); } catch { detectedLocation = null; }
  }
  const detectedHomeCitySuggestion = validHomeCity(detectedLocation?.city)
    ? detectedLocation.city.trim() : null;
  const trustedHomeCitySuggestion = explicitHomeCitySuggestion ?? detectedHomeCitySuggestion;
  const homeCitySuggestionSource = explicitHomeCitySuggestion
    ? 'provided' : detectedHomeCitySuggestion ? (detectedLocation.source ?? 'location') : null;
  const inventory = await takeInventoryForTask(dir, task);

  // 没有任务时 currentVersionId 无从比起 —— 那是 task_none，不是盘点过期。
  const inventoryStale = !!task && task.currentVersionId !== inventory.versionId;
  const classification = classifyInventory(dir, inventory, task, { mode });
  // 跨任务查重：拿发票身份去比对本机上别的任务还占着的票。只读别的任务落盘的摘要，
  // 一个字都不往回写。没有任务时无从比起（本任务自己都还没有身份摘要）。
  const history = task ? crossTaskDuplicates(task, classification) : null;

  const obs = {
    taskObserved: true,
    sourceDir: dir,
    // A marker still blocks the ordinary path in state.mjs, but a separately
    // validated local-preparation recovery may resolve this gate. Keep the
    // fact visible here so recovery does not silently skip a missing snapshot.
    homeCityRequired: task ? !task.homeCity : !employeeHomeCity,
    homeCityAnswerPath: path.join(paths.root, 'home-city-answer.json'),
    employeeHomeCity,
    ...(trustedHomeCitySuggestion ? { homeCitySuggestion: trustedHomeCitySuggestion } : {}),
    ...(homeCitySuggestionSource ? { homeCitySuggestionSource } : {}),
    profileConfirmationRequired: !task && !!employeeHomeCity && loadIndex().tasks.length > 0,
    homeCity: task?.homeCity ?? employeeHomeCity,
    task: task ? {
      taskId: task.taskId,
      sourceLabel: task.sourceLabel,
      identity: task.identity ?? null,
      workspace: taskDir(task),
      currentVersionId: task.currentVersionId,
      erpWriteState: task.erpWriteState ?? null,
      homeCity: task.homeCity ?? null,
    } : null,
    inventoryVersionId: inventory.versionId,
    materialCount: inventory.materials.length,
    excludedMaterials: inventory.excluded,
    scopeMismatches: inventory.scopeMismatches,
    inventoryStale,
    classificationRecorded: task && !inventoryStale
      ? classificationRecorded(task, inventory.versionId, classification.candidateDigest)
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
    // 读过、还没被用户在整单明细表确认的读数。它是最终表格的候选来源之一。
    pendingReadings: task ? pendingConfirmations(task, inventory) : [],
    // 用户指了错、还没收场的那几份。证据链、重读结果、守恒缺口都在里面 ——
    // 摆给用户看的每一句话都从这里取，模型不补一个字。
    pendingDisputes: task ? openDisputes(task, inventory, dir) : [],
  };

  // ERP 这半段（划事件、分摊、项目、核对、写入前确认）只在材料那一段全清之后才采。
  //
  // 不是省事，是**不抢答**：还有图没读或争议没收场时，此刻的分流结果里
  // 那几张票根本还没有稳定候选，硬去划事件只会得出假的死路。
  // 未确认读数不在这里拦路：它已经有结构化候选，用户会在最终整单明细表中确认。
  const settled = !!task && !inventoryStale && obs.classificationRecorded
    && !obs.openItems.some((i) => i.blocking)
    && !obs.pendingImages.length && !obs.pendingDisputes.length;
  if (!settled) return obs;

  return { ...obs, ...observeErpHalf(task, classification, obs.openItems, inventory, receiptFacts) };
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
function observeErpHalf(task, classification, materialItems, inventory, receiptFacts = null) {
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
  const candidates = selectableProjects(task.identity);
  const applied = applySelection(built, classification, selection, catalog, candidates, task.identity,
    task.homeCity);
  const expenseItems = catalogExpenseItems(catalog) ?? [];
  const expenseByCode = new Map(expenseItems.map((item) => [item?.code, item]));
  // Keep the line projection tied to the canonical read-only catalog record.
  // The static category table supplies a candidate code; only the catalog can
  // supply the ERP name that the preparation document may cite as verified.
  const lines = applied.lines.map((line) => {
    const item = expenseByCode.get(line.expenseItemCode);
    return item?.verdict === 'confirmed'
      ? { ...line, expenseItemName: item.erpName ?? item.name ?? line.expenseItemName,
          expenseItemSource: 'erp_catalog_confirmed' }
      : line;
  });
  // 「还没做选择」和「选择过期了」不是待办，它们就是 project_unassigned 本身；
  // 费用类别推不出来那几条才是要人处置的待办。
  const OWN = new Set(['task_selection_required', 'task_selection_stale',
    'project_selection_reconfirmation_required', 'project_selection_identity_mismatch',
    'project_book_empty']);

  const preview = { lines, homeCity: applied.homeCity,
    purpose: selection?.purpose ?? null, versionId: built.versionId };
  const classifiedPreview = {
    ...preview,
    evidence: classification.results.map((result) => ({
      materialId: result.materialId,
      fileName: result.fileName,
      contentHash: result.contentHash,
      role: result.role,
      kind: result.kind,
      kindLabel: result.kindLabel ?? null,
      parseStatus: result.parseStatus ?? null,
      documentType: result.documentType ?? null,
      source: result.source ?? null,
      markdownHash: result.markdownHash ?? result.source?.markdownHash ?? null,
      pageCount: result.pageCount ?? null,
      paths: result.paths ?? null,
      sourcePages: result.sourcePages ?? [],
      fields: result.fields,
      evidence: result.evidence ?? null,
      candidates: result.candidates,
      segments: result.segments,
      fieldEvidence: result.fieldEvidence ?? null,
      fieldStatus: result.fieldStatus ?? null,
      candidateSources: result.candidateSources ?? null,
      unreadable: result.unreadable ?? [],
      issues: result.issues ?? [],
    })),
  };

  const preparation = buildPreparation({
    task,
    inventory,
    classification,
    built,
    lines,
    selection,
    catalog,
    // 分类结果进入后续项目和目录核验时只要求事实完整；用户的唯一整单
    // 确认发生在准备包完成之后，避免在中间阶段重复打断。
    classifiedConfirmed: classifiedDetailComplete(classifiedPreview),
    projectCandidates: candidates,
    receiptFacts,
  });
  // Inspection is deliberately read-only.  The package is created only by the
  // explicit `prepare` run step; this tells the state machine whether that
  // step has produced a current, byte-verified bundle for this digest.
  const preparationInspection = inspectPreparation({ task, preparation });
  const preparationPackage = preparationPackageInfo(preparationInspection);
  const preparationPackageCurrent = preparationInspection.ok === true
    && preparationInspection.digest === preparation.digest
    && preparationInspection.ready === preparation.ready;

  return {
    // Internal read-only inputs used by the CLI to materialize the already-built
    // preparation result after observation.  nextResponse does not serialize
    // these implementation objects.
    taskRecord: task,
    inventory,
    classification,
    built,
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
    lines,
    classifiedPreview,
    classifiedCorrectionOptions: classifiedCorrectionOptions(task, classifiedPreview),
    classifiedDetailComplete: classifiedDetailComplete(classifiedPreview),
    classifiedDetailConfirmed: classifiedDetailConfirmed(task, classifiedPreview),
    homeCity: applied.homeCity,
    purpose: selection?.purpose ?? null,
    projectBook: {
      projectCount: readBook(task.identity).projects.length,
      selectableCount: candidates.length,
      empty: candidates.length === 0,
    },
    // 核对记录也钉在这批明细上。过期的记录等于没核对过 —— 不是"上次是好的"。
    catalogFresh: catalogFreshFor({ catalog, built, selection, candidates,
      identity: task.identity, lines }),
    catalogProblems: sameBasis(catalog, built) ? catalogExpenseProblems(catalog) : [],
    catalogCheckedAt: sameBasis(catalog, built) ? (catalog.verifiedAt ?? null) : null,
    writePreview: preview,
    writeApproved: approvalCovers(loadWriteApproval(task), preview),
    // Preparation is a review artifact, not an ERP write preview.  It is
    // intentionally built even when it reports problems so the user can inspect
    // the exact missing evidence and fields before making corrections.
    preparation,
    preparationInspection,
    preparationPackage,
    preparationPackageCurrent,
    preparationConfirmed: preparationConfirmed(task, preparation.digest, preparationInspection),
  };
}

/**
 * 收下用户在终端上说的话时，要重算的那一份后半段观测。
 *
 * 和 `observeTask` 用的是**同一个** `observeErpHalf`，不是另抄一份：
 * 问出去的那份内容和收回来时核对的那份内容，必须由同一段代码算出来 ——
 * 各算各的，两边迟早会错开，而错开的样子是"用户点的头落在另一份内容上"。
 */
export async function erpSnapshot(sourceDir, task, { mode = 'markdown', receiptFacts = null } = {}) {
  const dir = path.resolve(sourceDir);
  const inventory = await takeInventoryForTask(dir, task);
  const classification = classifyInventory(dir, inventory, task, { mode });
  return { inventory, classification, ...observeErpHalf(task, classification, [], inventory, receiptFacts) };
}
