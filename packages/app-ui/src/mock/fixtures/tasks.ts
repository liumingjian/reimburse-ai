import { stageReached, type TaskStage } from '../../contract/stage';
import type { Material, TaskSnapshot, UploadBatch, UploadFileResult } from '../../contract/snapshot';
import type { Employee, TaskListItem } from '../../contract/task-list';

// 夹具：三个虚构的报销任务。人物与数字沿用原型（林颂宜、上海出差、9 条明细合计 3972.59）。
// 本票只填任务列表需要的字段与快照外壳；材料、明细等分节由后续票加深。

export const EMPLOYEE: Employee = { name: '林颂宜', department: '产品研发部' };

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
  ['m11', '餐饮_发票.pdf', 145408],
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

// 刚接收、还没盘点的材料：角色与类别未定，盘点票（#102）再填字段与校验。
export function uploadedMaterial(input: { materialId: string; batchId: string; fileName: string; size: number; contentHash: string }): Material {
  return {
    materialId: input.materialId,
    batchId: input.batchId,
    fileName: input.fileName,
    contentHash: input.contentHash,
    size: input.size,
    kindLabel: '待盘点',
    categoryLabel: null,
    role: 'uploaded',
    shape: shapeOf(input.fileName),
    status: 'uploaded',
    checkText: '',
    linkedMaterialIds: [],
    pendingItemIds: [],
    originalUrl: null,
    previewUrl: null,
    fields: [],
  };
}

function t1Batch(): UploadBatch {
  const files: UploadFileResult[] = T1_FILES.map(([id, fileName, size]) => ({
    fileId: `f-${id}`,
    fileName,
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
  review: 'confirm_review',
  actions: 'choose_action',
  project: 'assign_projects',
  erp: 'erp_login',
  done: 'none',
  reconcile: 'reconcile',
};

export function emptySnapshot(task: TaskSnapshot['task'], stage: TaskStage): TaskSnapshot {
  return {
    task,
    stage,
    batches: [],
    materials: [],
    events: [],
    pendingItems: [],
    lines: [],
    confirmation: { status: 'unconfirmed', confirmedAt: null, digest: null, lineCount: 0, invoiceCount: 0, grossTotal: null, notice: null },
    paymentScreenshots: [],
    printSheet: { status: 'not_generated', fileName: null, url: null, pages: [], notices: [] },
    projectAssignment: { status: 'not_started', purpose: null, homeCity: null, assignments: [], projects: [] },
    erp: { status: 'idle', steps: [], draftNo: null, abortReason: null, loginNotice: null },
    readback: { status: 'none', rows: [], summary: null },
    reconcile: { status: 'none', bucket: null, action: null, banner: null, draftNo: null, rows: [], reasons: [] },
    step: { kind: STEP_BY_STAGE[stage], stepToken: `tok-${task.taskId}-${stage}` },
  };
}

// T1：进行中的任务，`?seed=` 决定它停在哪个阶段。
export function t1Snapshot(stage: TaskStage = 'upload'): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T1_ID,
      name: '2026-08 上海出差（产品评审）',
      period: { start: '2026-08-09', end: '2026-08-22' },
      createdAt: '2026-09-11T14:05:00',
      updatedAt: '2026-09-11T14:20:00',
    },
    stage,
  );
  if (stageReached(stage, 'inventory')) {
    const batch = t1Batch();
    snapshot.batches = [batch];
    snapshot.materials = t1Materials(batch);
  }
  if (stageReached(stage, 'actions')) {
    snapshot.confirmation = {
      status: 'confirmed',
      confirmedAt: '2026-09-11T14:32:00',
      digest: 'digest-t1-v1',
      lineCount: 9,
      invoiceCount: 7,
      grossTotal: T1_GROSS_TOTAL,
      notice: null,
    };
  }
  if (stage === 'done') {
    snapshot.erp = { status: 'done', steps: [], draftNo: T1_DRAFT_NO, abortReason: null, loginNotice: null };
    snapshot.readback = { status: 'matched', rows: [], summary: '明细 9/9 一致' };
  }
  return snapshot;
}

// T2：对账中（ERP 写入结果不确定后的停顿状态，不是失败）。
export function t2Snapshot(): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T2_ID,
      name: '2026-07 深圳客户拜访',
      period: { start: '2026-07-14', end: '2026-07-16' },
      createdAt: '2026-07-18T09:40:00',
      updatedAt: '2026-09-08T10:05:00',
    },
    'reconcile',
  );
  snapshot.confirmation = {
    status: 'confirmed',
    confirmedAt: '2026-07-18T10:02:00',
    digest: 'digest-t2-v1',
    lineCount: 5,
    invoiceCount: 5,
    grossTotal: '1264.00',
    notice: null,
  };
  snapshot.erp = { status: 'aborted', steps: [], draftNo: T2_DRAFT_NO, abortReason: '保存草稿后回读超时，写入结果不确定。', loginNotice: null };
  snapshot.reconcile = {
    status: 'pending',
    bucket: '已保存',
    action: '转人工',
    banner: `ERP 中存在草稿 ${T2_DRAFT_NO}，5 行明细中 4 行一致，1 行金额不一致。`,
    draftNo: T2_DRAFT_NO,
    rows: [],
    reasons: [],
  };
  return snapshot;
}

// T3：已完成。
export function t3Snapshot(): TaskSnapshot {
  const snapshot = emptySnapshot(
    {
      taskId: T3_ID,
      name: '2026-06 北京培训',
      period: { start: '2026-06-02', end: '2026-06-05' },
      createdAt: '2026-06-30T15:10:00',
      updatedAt: '2026-07-02T16:40:00',
    },
    'done',
  );
  snapshot.confirmation = {
    status: 'confirmed',
    confirmedAt: '2026-07-02T16:20:00',
    digest: 'digest-t3-v1',
    lineCount: 4,
    invoiceCount: 4,
    grossTotal: '2318.50',
    notice: null,
  };
  snapshot.erp = { status: 'done', steps: [], draftNo: T3_DRAFT_NO, abortReason: null, loginNotice: null };
  snapshot.readback = { status: 'matched', rows: [], summary: '明细 4/4 一致' };
  return snapshot;
}

// 任务列表的一行由快照投影而来：mock 服务端负责，页面不做这件事。
export function toListItem(snapshot: TaskSnapshot): TaskListItem {
  const draftNo = snapshot.erp.draftNo ?? snapshot.reconcile.draftNo;
  return {
    taskId: snapshot.task.taskId,
    name: snapshot.task.name,
    stage: snapshot.stage,
    period: snapshot.task.period,
    grossTotal: snapshot.confirmation.status === 'confirmed' ? snapshot.confirmation.grossTotal : null,
    erpDraftNo: draftNo,
    pendingCount: snapshot.pendingItems.filter((item) => item.status === 'open').length,
    updatedAt: snapshot.task.updatedAt,
  };
}
