import {
  stageReached,
  type TaskStage,
  type Inventory,
  type Material,
  type TaskSnapshot,
  type UploadBatch,
  type UploadFileResult,
  type TaskListItem,
  ABANDON_TASK_COPY,
} from '@baox/contract';
import { HOME_CITY, SEED_ASSIGNMENTS, T1_DONE_ASSIGNMENTS, T1_PURPOSE, confirmationDigest, projectAssignmentOpen, projectAssignmentSubmitted, withLineProjects, withProjectUsage } from './projects';
import { T2_ROWS, applyAbortAtHandover, applyErpDone, emptyReadback, emptyReconcile, erpWaitingLogin, idleErp, readbackOf, reconcileVerdict } from './erp';
import { SEED_ANSWERS, applyPendingAnswer, buildLines, inventoryPhases, inventoryResult, openPendingItemCount, withInventoryProjection, withLodgingEvidenceProjection } from './inventory';
import { allowedActionsOf, withAllowedActions } from './allowed-actions';
import { catalogPending, preparationPending, preparationReady } from './preparation';
import type { SeedStage } from '../options';

// 夹具：三个虚构的报销任务。人物与数字沿用原型（林颂宜、上海出差、9 条明细合计 3972.59）。
// 材料盘点结果、费用事件、待确认项与候选明细见 ./inventory.ts；本文件按阶段把它们装进快照。

// 报销系统当前登录的身份（虚构）：姓名、登录账号、账套。EMPLOYEE 是已登记（bound）的样子。

export const T1_ID = 'T1';
export const T2_ID = 'T2';
export const T3_ID = 'T3';

export const T1_GROSS_TOTAL = '3972.59';
export const T1_DRAFT_NO = 'BX20260911-0173';
export const T2_DRAFT_NO = 'BX20260718-0142';
export const T3_DRAFT_NO = 'BX20260702-0088';

// 上传批次 #1 的 11 份材料（原型 FILES）。
const T1_FILES: ReadonlyArray<readonly [string, string, number]> = [
  ['m01', '全季酒店_发票.pdf', 190464],
  ['m02', '全季酒店_结账单.pdf', 94208],
  ['m03', '高德打车_发票.pdf', 134144],
  ['m04', '高德打车_行程单.pdf', 78848],
  ['m05', '曹操出行_发票.pdf', 131072],
  ['m06', '曹操出行_行程单.pdf', 65536],
  ['m07', '铁路电子客票_0809.pdf', 59392],
  ['m08', '铁路电子客票_0822.pdf', 59392],
  ['m09', 'IMG_4871.jpg', 3250585],
  ['m10', 'IMG_4906.jpg', 3040870],
  ['m12', '办公用品_发票.pdf', 145408],
];

// 夹具用的确定性伪哈希：64 位十六进制，形状与 sha256 一致，页面只显示前 8 位。
export function fixtureHash(seed: string): string {
  let out = '';
  for (let round = 0; out.length < 64; round += 1) {
    let h = 0x811c9dc5 ^ round;
    for (const ch of `${seed}\u0000baox`) {
      h ^= ch.codePointAt(0) ?? 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

export function shapeOf(fileName: string): Material['shape'] {
  return /\.(jpe?g|png)$/i.test(fileName) ? 'photo' : 'portrait';
}

export function mediaTypeOf(fileName: string): Material['mediaType'] {
  return /\.(jpe?g|png)$/i.test(fileName) ? 'image' : 'pdf';
}

// 刚接收、还没盘点的材料：角色与类别未定，盘点票（#102）再填字段与校验。
export function uploadedMaterial(input: { materialId: string; batchId: string; fileName: string; relativePath?: string; size: number; contentHash: string }): Material {
  return {
    materialId: input.materialId,
    batchId: input.batchId,
    fileName: input.fileName,
    relativePath: input.relativePath ?? input.fileName,
    contentHash: input.contentHash,
    size: input.size,
    kind: null,
    layout: null,
    kindLabel: '待盘点',
    categoryLabel: null,
    role: 'uploaded',
    shape: shapeOf(input.fileName),
    mediaType: mediaTypeOf(input.fileName),
    status: 'uploaded',
    checkText: '',
    linkedMaterialIds: [],
    pendingItemIds: [],
    originalUrl: null,
    previewUrl: null,
    variants: [],
    fields: [],
  };
}

function t1Batch(): UploadBatch {
  const files: UploadFileResult[] = T1_FILES.map(([id, fileName, size]) => ({
    fileId: `f-${id}`,
    fileName,
    relativePath: fileName,
    size,
    status: 'accepted',
    contentHash: fixtureHash(id),
    reasonCode: null,
    reason: null,
    materialId: id,
  }));
  return { batchId: 'b1', no: 1, uploadedAt: '2026-09-11T14:12:00', versionId: 'v1', files };
}

function t1Materials(batch: UploadBatch): Material[] {
  return batch.files.flatMap((file) =>
    file.materialId && file.contentHash
      ? [uploadedMaterial({ materialId: file.materialId, batchId: batch.batchId, fileName: file.fileName, size: file.size, contentHash: file.contentHash })]
      : [],
  );
}

const STEP_BY_STAGE: Readonly<Record<TaskStage, TaskSnapshot['step']['kind']>> = {
  upload: 'upload_materials',
  inventory: 'start_inventory',
  pending: 'answer_pending',
  project: 'assign_projects',
  catalog: 'none',
  preparation: 'none',
  review: 'confirm_review',
  actions: 'choose_action',
  erp: 'erp_login',
  done: 'none',
  reconcile: 'reconcile',
  voided: 'none',
};

export const T1_INVENTORY_FINISHED_AT = '2026-09-11T14:20:00';

export function inventoryNotStarted(): Inventory {
  return { status: 'not_started', versionId: null, phases: [], finishedAt: null, summary: null, ungroupedMaterialIds: [] };
}

export function inventoryDone(versionId: string, finishedAt: string, materials: readonly Material[] = []): Inventory {
  return { status: 'done', versionId, phases: inventoryPhases(materials, 'done'), finishedAt, summary: null, ungroupedMaterialIds: [] };
}

export function emptySnapshot(task: TaskSnapshot['task'], stage: TaskStage): TaskSnapshot {
  return {
    revision: 1,
    task,
    stage,
    batches: [],
    materials: [],
    inventory: inventoryNotStarted(),
    events: [],
    pendingItems: [],
    blockers: [],
    lines: [],
    lodgingEvidence: [],
    confirmation: { status: 'unconfirmed', confirmedAt: null, digest: null, lineCount: 0, invoiceCount: 0, grossTotal: null, notice: null },
    paymentScreenshots: [],
    printSheet: { status: 'not_generated', fileName: null, url: null, pages: [], notices: [] },
    projectAssignment: { status: 'not_started', purpose: null, homeCity: task.homeCity, assignments: [], working: [], reselect: [], usage: [], grossTotal: '0.00', projects: [], deadlineWarnings: [], submittedAt: null },
    catalog: catalogPending(),
    preparation: preparationPending(),
    erp: idleErp(),
    readback: emptyReadback(),
    reconcile: emptyReconcile(),
    step: { kind: STEP_BY_STAGE[stage], stepToken: `tok-${task.taskId}-${stage}` },
    allowedActions: [],
  };
}

// T1：进行中的任务，`?seed=` 决定它停在哪个阶段；unsupportedFault 对应 `?fault=unsupported-material`（曹操行程单变成不支持的版式），
// allocationRequired 对应 `?allocation=1`（高德合并发票需要逐段分摊；project 起按原件金额答复，明细与默认相同）。
export function t1Snapshot(stage: SeedStage = 'upload', unsupportedFault = false, allocationRequired = false): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T1_ID,
      name: '2026-08 上海出差（产品评审）',
      period: { start: '2026-08-09', end: '2026-08-22' },
      homeCity: HOME_CITY,
      createdAt: '2026-09-11T14:05:00',
      updatedAt: '2026-09-11T14:20:00',
    },
    stage,
  );
  if (stageReached(stage, 'inventory')) {
    const batch = t1Batch();
    snapshot.batches = [batch];
    snapshot.inventory = inventoryDone('v1', T1_INVENTORY_FINISHED_AT, t1Materials(batch));
    const result = inventoryResult(t1Materials(batch), unsupportedFault, allocationRequired);
    if (stageReached(stage, 'project')) {
      // 待确认项都已按原型的既定答复处理，候选明细随之形成（No. 按内核分类排序）。
      for (const item of result.pendingItems) {
        const material = result.materials.find((m) => m.materialId === item.materialId);
        const answer = material ? SEED_ANSWERS[material.materialId] : undefined;
        if (answer) applyPendingAnswer(result, item, answer);
      }
    }
    // As on the server, the candidate lines follow the expense events from the end of the inventory on.
    snapshot.lines = buildLines(result);
    snapshot.materials = result.materials;
    snapshot.events = result.events;
    snapshot.pendingItems = result.pendingItems;
    // 盘点已结束、还有待确认项：当前待答 step 就是答复待确认项。
    if (stage === 'inventory' && result.pendingItems.some((item) => item.status === 'open')) snapshot.step = { kind: 'answer_pending', stepToken: `tok-${T1_ID}-inventory` };
  }
  // Entering project assignment (项目归属), the server hands over the personal project book's allow list; the project
  // seed has two lines preassigned (to show conflict handling). From the review on, all 9 lines are assigned
  // (submitted), and the review digest binds that assignment.
  if (stage === 'project') snapshot.projectAssignment = projectAssignmentOpen(HOME_CITY, SEED_ASSIGNMENTS);
  if (stageReached(stage, 'review')) {
    snapshot.projectAssignment = projectAssignmentSubmitted({ purpose: T1_PURPOSE, homeCity: HOME_CITY, projects: T1_DONE_ASSIGNMENTS, submittedAt: '2026-09-11T14:28:00' });
    snapshot.lines = withLineProjects(snapshot.lines, snapshot.projectAssignment);
  }
  if (stageReached(stage, 'review')) {
    // 整单确认的摘要与它的条数、张数、合计一起出现：服务端在还没有可确认的一份时把它们留空
    // （confirmationView 的 `counted`）。mock 早早填上合计，就掩盖了归属页读错来源的毛病。
    snapshot.confirmation = { ...snapshot.confirmation, lineCount: 9, invoiceCount: 7, grossTotal: T1_GROSS_TOTAL };
    snapshot.confirmation.digest = confirmationDigest(T1_ID, 'v1', snapshot.projectAssignment);
    snapshot.preparation = preparationReady();
  }
  if (stageReached(stage, 'actions')) snapshot.confirmation = { ...snapshot.confirmation, status: 'confirmed', confirmedAt: '2026-09-11T14:32:00' };
  // erp：「去报销」之后浏览器已启动，等待登录（检测到登录即自动写入）。done：回读 9/9 一致、已暂存到报销系统；
  // 交接时单据还没有保存，所以没有单据编号（服务端同此）；只有 T3 那种由员工自己保存过的任务才有编号。
  // reconcile：交接步中止后的对账（同 ?fault=erp-write-aborted 的结果）。
  if (stage === 'erp') snapshot.erp = erpWaitingLogin(snapshot.lines.length);
  if (stage === 'done') applyErpDone(snapshot);
  if (stage === 'reconcile') applyAbortAtHandover(snapshot);
  return withAllowedActions(withLodgingEvidenceProjection(withProjectUsage(withInventoryProjection(snapshot))));
}

// T2：对账中（ERP 写入结果不确定后的停顿状态，不是失败）。
export function t2Snapshot(): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T2_ID,
      name: '2026-07 深圳客户拜访',
      period: { start: '2026-07-14', end: '2026-07-16' },
      homeCity: HOME_CITY,
      createdAt: '2026-07-18T09:40:00',
      updatedAt: '2026-09-08T10:05:00',
    },
    'reconcile',
  );
  snapshot.inventory = inventoryDone('v1', '2026-07-18T09:52:00');
  snapshot.confirmation = {
    status: 'confirmed',
    confirmedAt: '2026-07-18T10:02:00',
    digest: 'digest-t2-v1',
    lineCount: 5,
    invoiceCount: 5,
    grossTotal: '1264.00',
    notice: null,
  };
  snapshot.preparation = preparationReady();
  snapshot.erp = {
    status: 'aborted',
    steps: [],
    currentStage: 'handover',
    progress: null,
    externalWait: 'none',
    outcome: 'none',
    allowedActions: ['refresh'],
    draftNo: T2_DRAFT_NO,
    abortReason: '严格回读时没有读到报销系统的结果，写入结果不确定。',
    loginNotice: null,
    rerunNotice: null,
    erpAccount: null,
    review: null,
  };
  snapshot.readback = readbackOf(T2_ROWS);
  // 已保存但严格逐行不一致 ⇒ 转人工（human_review），只允许转人工。
  snapshot.reconcile = {
    status: 'pending',
    ...reconcileVerdict('已保存', false),
    banner: `报销系统中存在草稿 ${T2_DRAFT_NO}，5 行明细中 4 行一致，1 行不一致。`,
    draftNo: T2_DRAFT_NO,
    rows: [...T2_ROWS],
    reasons: [],
    capture: null,
  };
  return withAllowedActions(withLodgingEvidenceProjection(withProjectUsage(withInventoryProjection(snapshot))));
}

// T3：已完成，而且员工自己保存过，单据编号是这么来的。演示里唯一一条真的有编号的已完成任务：
// 刚交接、还没保存的任务（T1 的 done）没有编号。
export function t3Snapshot(): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T3_ID,
      name: '2026-06 北京培训',
      period: { start: '2026-06-02', end: '2026-06-05' },
      homeCity: HOME_CITY,
      createdAt: '2026-06-30T15:10:00',
      updatedAt: '2026-07-02T16:40:00',
    },
    'done',
  );
  snapshot.inventory = inventoryDone('v1', '2026-06-30T15:20:00');
  snapshot.confirmation = {
    status: 'confirmed',
    confirmedAt: '2026-07-02T16:20:00',
    digest: 'digest-t3-v1',
    lineCount: 4,
    invoiceCount: 4,
    grossTotal: '2318.50',
    notice: null,
  };
  snapshot.preparation = preparationReady();
  snapshot.erp = {
    status: 'done',
    steps: [],
    currentStage: 'handover',
    progress: null,
    externalWait: 'none',
    outcome: 'saved',
    allowedActions: ['refresh'],
    draftNo: T3_DRAFT_NO,
    abortReason: null,
    loginNotice: null,
    rerunNotice: null,
    erpAccount: null,
    review: null,
  };
  snapshot.readback = { status: 'matched', rows: [], summary: '明细 4/4 一致', localTotal: '2318.50', erpTotal: '2318.50' };
  return withAllowedActions(withLodgingEvidenceProjection(withProjectUsage(withInventoryProjection(snapshot))));
}

// 任务列表层面的 ERP 结局：已转人工优先。严格回读不一致的草稿现在停在对账（不是完成），列表按「对账中」显示它，
// 和服务端一致：服务端的列表也只给 handed_off 或 none。
function erpOutcomeOf(snapshot: TaskSnapshot): TaskListItem['erpOutcome'] {
  if (snapshot.reconcile.status === 'handed_off') return 'handed_off';
  if (snapshot.stage === 'done' && snapshot.readback.status === 'mismatched') return 'readback_mismatch';
  return 'none';
}

// 能否作废（内核 abandonTask）：任何状态都可以作废（ADR-0030），只有这个任务的写入/对账正在跑时不行。
function abandonOf(snapshot: TaskSnapshot): Pick<TaskListItem, 'abandonable' | 'abandonBlockedReason' | 'erpTouched'> {
  const erpTouched = snapshot.erp.status !== 'idle' || stageReached(snapshot.stage, 'erp');
  const abandonable = allowedActionsOf(snapshot).includes('void_task');
  return { abandonable, abandonBlockedReason: abandonable ? null : ABANDON_TASK_COPY.blockedReason, erpTouched };
}

// 任务列表的一行由快照投影而来：mock 服务端负责，页面不做这件事。
export function toListItem(snapshot: TaskSnapshot): TaskListItem {
  const draftNo = snapshot.erp.draftNo ?? snapshot.reconcile.draftNo;
  const summaryStatus = snapshot.lines.length === 0 ? 'unavailable' : snapshot.confirmation.status === 'confirmed' ? 'confirmed' : 'pending';
  return {
    taskId: snapshot.task.taskId,
    name: snapshot.task.name,
    stage: snapshot.stage,
    period: summaryStatus === 'unavailable' ? null : snapshot.task.period,
    grossTotal: snapshot.confirmation.status === 'confirmed' ? snapshot.confirmation.grossTotal : null,
    summaryStatus,
    erpDraftNo: draftNo,
    pendingCount: openPendingItemCount(snapshot.pendingItems),
    erpOutcome: erpOutcomeOf(snapshot),
    ...abandonOf(snapshot),
    updatedAt: snapshot.task.updatedAt,
  };
}
