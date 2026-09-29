import { EXCLUDE_MATERIAL_ERRORS, REOPEN_UPLOAD_ERRORS, type AppAdapter, REVIEW_INVALIDATED_NOTICE, type Material, type TaskSnapshot } from '@baox/contract';
import type { MockBus } from '../bus';
import { duplicateBlockers, inventoryResult } from '../fixtures/inventory';
import { catalogPending, preparationPending } from '../fixtures/preparation';
import { T3_ID, inventoryNotStarted, uploadedMaterial } from '../fixtures/tasks';
import { duplicateReason, judgeFile } from '../upload';
import { settlePending } from './pending';

// 上传批次、材料盘点（定时推进）与确认后追加材料（mock 服务端的角色）。

const DEFAULT_PHASE_MS = 450;

export type InventoryFlow = Pick<AppAdapter, 'uploadBatch' | 'startInventory' | 'reopenUpload'> & {
  // 跨任务重复发票的处置（exclude-material）：把命中的那份移出本次材料，接着划分费用事件。
  excludeDuplicate: AppAdapter['excludeMaterial'];
};

function relativePathOf(file: File): string {
  const selected = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return selected || file.name;
}

// 移出本次材料的材料：不参与盘点、不关联明细，也不进入材料包。
function removedMaterial(material: Material): Material {
  return {
    ...material,
    role: 'excluded',
    status: 'excluded',
    checkText: '已移出本次材料：不参与盘点，也不进入材料包',
    linkedMaterialIds: [],
    pendingItemIds: [],
  };
}

// 服务端给任务命名（盘点结束时，每轮盘点都重算）。规则：
// - 费用期间 = 所有费用事件的最早日期至最晚日期（有 endDate 的取 endDate，如住宿离店日）；没有费用事件就不动名称与期间。
// - 名称只改服务端生成的占位名称（rename = true，经 createTask 新建的任务）：
//   `<期间开始的年月 YYYY-MM> <城市>出差`，城市取费用事件里出现次数最多的城市（相同次数取先出现的）；
//   没有任何事件带城市时为 `<YYYY-MM> 报销`。T1 的示例材料得到 `2026-08 上海出差`、期间 2026-08-09 至 2026-08-22。
export function nameFromEvents(snapshot: TaskSnapshot, rename: boolean): void {
  const events = snapshot.events;
  if (events.length === 0) return;
  const starts = events.map((event) => event.date).sort();
  const ends = events.map((event) => event.endDate ?? event.date).sort();
  const start = starts[0] ?? '';
  const end = ends[ends.length - 1] ?? start;
  snapshot.task.period = { start, end };
  if (!rename) return;
  const counts = new Map<string, number>();
  for (const event of events) if (event.city) counts.set(event.city, (counts.get(event.city) ?? 0) + 1);
  let city: string | null = null;
  for (const [candidate, count] of counts) if (city === null || count > (counts.get(city) ?? 0)) city = candidate;
  snapshot.task.name = city ? `${start.slice(0, 7)} ${city}出差` : `${start.slice(0, 7)} 报销`;
}

export function createInventoryFlow(bus: MockBus): InventoryFlow {
  const { options } = bus;
  const phaseMs = options.inventoryPhaseMs ?? DEFAULT_PHASE_MS;
  let nextFileNo = 1;
  let reopenCount = 0;

  // 盘点结果落进快照：材料分类、费用事件与待确认项；有待确认项则进入 pending 阶段，否则直接形成候选明细。
  // 用户移出过的材料（bus.removedMaterials）不参与盘点，保持「已移出」。
  // `?duplicate=1`：跨任务查重命中已完成的 T3，整批停（内核 duplicate_blocked）：不划分费用事件、不形成待确认项，阶段停在 inventory。
  const settleInventory = (snapshot: TaskSnapshot) => {
    const removed = bus.removedMaterials(snapshot.task.taskId);
    const result = inventoryResult(
      snapshot.materials.filter((material) => !removed.has(material.materialId)),
      options.fault === 'unsupported-material',
      options.allocationRequired === true,
      new Set(snapshot.paymentScreenshots.map((shot) => shot.voucherMaterialId)),
    );
    const fresh = new Map(result.materials.map((material) => [material.materialId, material]));
    snapshot.materials = snapshot.materials.map((material) => fresh.get(material.materialId) ?? removedMaterial(material));
    const hit = options.duplicateHit ? bus.draft(T3_ID).task : null;
    snapshot.blockers = hit ? duplicateBlockers(result.materials, { taskId: hit.taskId, name: hit.name }) : [];
    if (snapshot.blockers.length > 0) {
      snapshot.events = [];
      snapshot.pendingItems = [];
      snapshot.lines = [];
      for (const material of snapshot.materials) material.pendingItemIds = [];
      snapshot.step = { kind: 'none', stepToken: `tok-${snapshot.task.taskId}-duplicate-${snapshot.inventory.versionId ?? 'v0'}` };
      return;
    }
    snapshot.events = result.events;
    snapshot.pendingItems = result.pendingItems;
    nameFromEvents(snapshot, bus.autoNamed.has(snapshot.task.taskId));
    settlePending(snapshot, bus.projectAllowList(snapshot.task.taskId));
  };

  const finishInventory = (snapshot: TaskSnapshot) => {
    snapshot.inventory.status = 'done';
    snapshot.inventory.finishedAt = bus.now();
    snapshot.task.updatedAt = snapshot.inventory.finishedAt;
    settleInventory(snapshot);
  };

  // 材料变更（追加批次）：整单明细确认失效、打印稿作废，任务回到上传阶段等待新批次与新一轮盘点。
  const invalidateForMaterialChange = (snapshot: TaskSnapshot) => {
    if (snapshot.confirmation.status === 'confirmed') {
      snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: REVIEW_INVALIDATED_NOTICE };
    }
    if (snapshot.printSheet.status === 'generated') snapshot.printSheet.status = 'stale';
    // 旧材料包作废；报销信息核对与材料准备在重新盘点、再次提交项目归属后重来。
    snapshot.catalog = catalogPending();
    snapshot.preparation = preparationPending();
    snapshot.blockers = [];
    snapshot.stage = 'upload';
    reopenCount += 1;
    snapshot.step = { kind: 'start_inventory', stepToken: `tok-${snapshot.task.taskId}-upload-reopen-${reopenCount}` };
  };

  // 盘点分阶段按定时器推进并推送快照；版本变了或盘点已不在进行中就停。
  const advance = (taskId: string, versionId: string, index: number) => {
    const current = bus.draft(taskId);
    if (current.inventory.versionId !== versionId || current.inventory.status !== 'running') return;
    const phases = current.inventory.phases;
    const done = phases[index];
    if (done) done.status = 'done';
    const next = phases[index + 1];
    if (next) {
      next.status = 'running';
      bus.push(current);
      setTimeout(() => advance(taskId, versionId, index + 1), phaseMs);
    } else {
      finishInventory(current);
      bus.push(current);
    }
  };

  return {
    // 上传批次：逐文件判定（类型、20MB、HEIC、内容重复），结果记进新批次；接收的文件成为待盘点材料。
    // `?fault=duplicate-upload`：第二批起，第一份本可接收的文件按内容重复拒绝。
    async uploadBatch(taskId, files) {
      const snapshot = bus.draft(taskId);
      const known = new Map<string, string>();
      for (const material of snapshot.materials) known.set(material.contentHash, material.fileName);
      const batchId = `b${snapshot.batches.length + 1}`;
      const batch: TaskSnapshot['batches'][number] = { batchId, no: snapshot.batches.length + 1, uploadedAt: bus.now(), versionId: null, files: [] };
      let faultPending = options.fault === 'duplicate-upload' && batch.no >= 2;
      for (const file of files) {
        const fileId = `f${String(nextFileNo).padStart(3, '0')}`;
        nextFileNo += 1;
        let verdict = await judgeFile(file, known);
        if (verdict.status === 'accepted' && faultPending) {
          faultPending = false;
          const existing = snapshot.materials[0]?.fileName ?? file.name;
          verdict = { status: 'rejected', reasonCode: 'duplicate_content', reason: duplicateReason(existing) };
        }
        if (verdict.status === 'rejected') {
          batch.files.push({ fileId, fileName: file.name, relativePath: relativePathOf(file), size: file.size, status: 'rejected', contentHash: null, reasonCode: verdict.reasonCode, reason: verdict.reason, materialId: null });
          continue;
        }
        const materialId = `m-${fileId}`;
        known.set(verdict.contentHash, file.name);
        snapshot.materials.push(uploadedMaterial({ materialId, batchId, fileName: file.name, relativePath: relativePathOf(file), size: file.size, contentHash: verdict.contentHash }));
        batch.files.push({ fileId, fileName: file.name, relativePath: relativePathOf(file), size: file.size, status: 'accepted', contentHash: verdict.contentHash, reasonCode: null, reason: null, materialId });
      }
      snapshot.batches.push(batch);
      snapshot.task.updatedAt = batch.uploadedAt;
      // 盘点之后再追加批次：材料变了，旧确认失效，任务回到上传阶段（服务端兜底，即使页面没有先走 reopenUpload）。
      if (snapshot.stage !== 'upload') invalidateForMaterialChange(snapshot);
      // 有材料后，当前待答 step 变成「开始材料盘点」；状态变了，凭据也换。
      if (snapshot.materials.length > 0) snapshot.step = { kind: 'start_inventory', stepToken: `tok-${taskId}-upload-${batchId}` };
      return bus.commit(snapshot);
    },
    // 开始材料盘点：阶段推到 inventory，盘点分阶段按定时器推进并推送快照；结束后形成结果。
    startInventory: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.materials.length === 0) return { error: { code: 'no_materials', message: '还没有被接收的材料。' } };
        const versionId = `v${snapshot.batches.length}`;
        for (const batch of snapshot.batches) batch.versionId = versionId;
        snapshot.stage = 'inventory';
        snapshot.task.updatedAt = bus.now();
        snapshot.inventory = { ...inventoryNotStarted(), status: 'running', versionId };
        snapshot.blockers = [];
        const first = snapshot.inventory.phases[0];
        if (first) first.status = 'running';
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-inventory-${versionId}` };
        setTimeout(() => advance(taskId, versionId, 0), phaseMs);
        return snapshot;
      }),
    // 确认后追加材料：整单明细确认失效、打印稿作废，回到上传阶段。ERP 已开始写入的任务不能再动材料。
    reopenUpload: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.erp.status !== 'idle') return { error: { code: 'erp_started', message: REOPEN_UPLOAD_ERRORS.erpStarted } };
        invalidateForMaterialChange(snapshot);
        snapshot.task.updatedAt = bus.now();
        return snapshot;
      }),
    // 重复发票：只接受阻塞项上的那份材料。移出后重新结算这一版盘点（没有别的重复就进入待确认项或项目归属）。
    excludeDuplicate: async (taskId, materialId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.stage !== 'inventory' || !snapshot.blockers.some((blocker) => blocker.materialId === materialId)) {
          return { error: { code: 'not_ready', message: EXCLUDE_MATERIAL_ERRORS.notReady } };
        }
        bus.removedMaterials(taskId).add(materialId);
        snapshot.task.updatedAt = bus.now();
        settleInventory(snapshot);
        return snapshot;
      }),
  };
}
