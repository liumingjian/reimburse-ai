import { REOPEN_UPLOAD_ERRORS } from '../../contract/actions';
import type { AppAdapter } from '../../contract/adapter';
import { REVIEW_INVALIDATED_NOTICE, type TaskSnapshot } from '../../contract/snapshot';
import type { MockBus } from '../bus';
import { inventoryResult } from '../fixtures/inventory';
import { inventoryNotStarted, uploadedMaterial } from '../fixtures/tasks';
import { duplicateReason, judgeFile } from '../upload';
import { settlePending } from './pending';

// 上传批次、材料盘点（定时推进）与确认后追加材料（mock 服务端的角色）。

const DEFAULT_PHASE_MS = 450;

export type InventoryFlow = Pick<AppAdapter, 'uploadBatch' | 'startInventory' | 'reopenUpload'>;

export function createInventoryFlow(bus: MockBus): InventoryFlow {
  const { options } = bus;
  const phaseMs = options.inventoryPhaseMs ?? DEFAULT_PHASE_MS;
  let nextFileNo = 1;
  let reopenCount = 0;

  // 盘点结束：材料分类、费用事件与待确认项落进快照；有待确认项则进入 pending 阶段，否则直接形成候选明细进入 review。
  const finishInventory = (snapshot: TaskSnapshot) => {
    const result = inventoryResult(snapshot.materials, options.fault === 'unsupported-material');
    snapshot.materials = result.materials;
    snapshot.events = result.events;
    snapshot.pendingItems = result.pendingItems;
    snapshot.inventory.status = 'done';
    snapshot.inventory.finishedAt = bus.now();
    snapshot.task.updatedAt = snapshot.inventory.finishedAt;
    settlePending(snapshot);
  };

  // 材料变更（追加批次）：整单明细确认失效、打印稿作废，任务回到上传阶段等待新批次与新一轮盘点。
  const invalidateForMaterialChange = (snapshot: TaskSnapshot) => {
    if (snapshot.confirmation.status === 'confirmed') {
      snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: REVIEW_INVALIDATED_NOTICE };
    }
    if (snapshot.printSheet.status === 'generated') snapshot.printSheet.status = 'stale';
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
          batch.files.push({ fileId, fileName: file.name, size: file.size, status: 'rejected', contentHash: null, reasonCode: verdict.reasonCode, reason: verdict.reason, materialId: null });
          continue;
        }
        const materialId = `m-${fileId}`;
        known.set(verdict.contentHash, file.name);
        snapshot.materials.push(uploadedMaterial({ materialId, batchId, fileName: file.name, size: file.size, contentHash: verdict.contentHash }));
        batch.files.push({ fileId, fileName: file.name, size: file.size, status: 'accepted', contentHash: verdict.contentHash, reasonCode: null, reason: null, materialId });
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
  };
}
