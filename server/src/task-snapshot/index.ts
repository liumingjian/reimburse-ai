import { ABANDON_TASK_COPY, TASK_ACTIONS, projectLodgingEvidence, type Confirmation, type Line, type TaskListItem, type TaskSnapshot, type UploadBatch, type UploadFileResult } from '@baox/contract';
import type { TaskTable, UploadBatchTable, UploadRejectionTable } from '../db/schema';
import type { InventoryView } from '../inventory-view';
import { sheetState } from '../print/facts';
import type { LoadedTask, MaterialRow } from '../task-facts';
import { taskPolicy } from '../task-policy';
import { confirmationView } from './confirmation';
import { catalogView, erpView, legacyErpView, legacyReconcileView, readbackView, reconcileView } from './erp';
import { inventorySection } from './inventory';
import { printView } from './print';

// The snapshot projection: a reimbursement task (报销任务)'s loaded facts (`task-facts.ts`) -> the contract's
// TaskSnapshot and TaskListItem. Pure: no reads, no writes. A snapshot field change touches this directory and
// @baox/contract only: every section is worded here (`erp.ts`, `confirmation.ts`, `print.ts`, `inventory.ts`) from the
// facts and records the other modules derive. The web mock's goldens (@baox/contract/goldens) are recorded from it by
// `snapshot-goldens.test.ts`.

function taskPeriod(lines: readonly Line[]): TaskListItem['period'] {
  const dates = lines.flatMap((line) => [line.date, line.endDate ?? line.date]).filter((date): date is string => !!date).sort();
  const start = dates[0];
  const end = dates.at(-1);
  return start && end ? { start, end } : null;
}

export function projectListItem(task: TaskTable, { facts, legacy, erp, lines, digest, confirmed }: LoadedTask): TaskListItem {
  const savedDraftNo = erp.facts?.phase === 'saved' ? (erp.result?.billNo ?? null) : null;
  const policy = taskPolicy(facts, erp);
  // Voidable in every state (ADR-0030); only a job of this task in flight holds it back, and that clears itself.
  const voidable = policy.allowedActions.has('void_task');
  return {
    taskId: task.task_id,
    name: task.name,
    stage: policy.stage,
    period: taskPeriod(lines),
    grossTotal: facts.confirmation === 'confirmed' ? confirmationView(digest, confirmed, facts.lastReopenRevision, lines).grossTotal : null,
    summaryStatus: lines.length === 0 ? 'unavailable' : facts.confirmation === 'confirmed' ? 'confirmed' : 'pending',
    erpDraftNo: legacy?.bill_no ?? savedDraftNo,
    pendingCount: facts.parse?.openPendingItems ?? 0,
    erpOutcome: legacy?.outcome === 'handed_off' || (task.origin !== 'legacy' && task.lifecycle === 'handed_off') ? 'handed_off' : 'none',
    abandonable: voidable,
    abandonBlockedReason: voidable ? null : ABANDON_TASK_COPY.blockedReason,
    // The confirmation has a sharper wording for a task whose bills are already over in ERP.
    erpTouched: erp.attempted,
    updatedAt: task.updated_at,
  };
}

// Files of a batch in upload order: accepted materials and rejections interleaved by their position in the batch.
function batchFiles(batchId: string, materials: readonly MaterialRow[], rejections: readonly UploadRejectionTable[]): UploadFileResult[] {
  const entries: { order: number; file: UploadFileResult }[] = [];
  for (const row of materials.filter((m) => m.batch_id === batchId)) {
    entries.push({
      // Materials from before 0002_180 have no position; they keep insertion order after any positioned file.
      order: row.batch_seq ?? 1e9 + row.row_no,
      file: { fileId: row.material_id, fileName: row.file_name, relativePath: row.source_path ?? row.file_name, size: row.size, status: 'accepted', contentHash: row.blob_sha256, reasonCode: null, reason: null, materialId: row.material_id },
    });
  }
  for (const row of rejections.filter((r) => r.batch_id === batchId)) {
    entries.push({
      order: row.batch_seq,
      file: { fileId: row.rejection_id, fileName: row.file_name, relativePath: row.source_path ?? row.file_name, size: row.size, status: 'rejected', contentHash: null, reasonCode: row.reason_code, reason: row.reason, materialId: null },
    });
  }
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.file);
}

export function projectSnapshot(task: TaskTable, { facts, view, homeCity, assignment, legacy, lines, digest, confirmed, erp, print }: LoadedTask, batches: readonly UploadBatchTable[], rejections: readonly UploadRejectionTable[], materials: readonly MaterialRow[]): TaskSnapshot {
  const { stage, step, blockers, allowedActions } = taskPolicy(facts, erp);
  // A batch that added a material formed the next inventory version.
  const versionOf = new Map<string, string>();
  for (const batch of batches) if (materials.some((m) => m.batch_id === batch.batch_id)) versionOf.set(batch.batch_id, `v${versionOf.size + 1}`);
  const batchViews: UploadBatch[] = batches.map((batch) => ({
    batchId: batch.batch_id,
    no: batch.no,
    uploadedAt: batch.uploaded_at,
    versionId: versionOf.get(batch.batch_id) ?? null,
    files: batchFiles(batch.batch_id, materials, rejections),
  }));
  const snapshotMaterials = view.materials.map((material) => materialWithSourceUrls(task.task_id, material));
  return {
    revision: task.revision,
    task: { taskId: task.task_id, name: task.name, period: taskPeriod(lines), homeCity, createdAt: task.created_at, updatedAt: task.updated_at },
    stage,
    batches: batchViews,
    materials: snapshotMaterials,
    inventory: inventorySection(view, facts.versionNo),
    events: view.events,
    pendingItems: view.pendingItems,
    blockers,
    lines,
    lodgingEvidence: projectLodgingEvidence({ materials: snapshotMaterials, lines }),
    confirmation: confirmationView(digest, confirmed, facts.lastReopenRevision, lines) satisfies Confirmation,
    ...printView(task.task_id, task.name, print, sheetState(print, facts.confirmation, confirmed?.revision ?? null), view.trios),
    projectAssignment: assignment?.view ?? { status: 'not_started', purpose: null, homeCity, assignments: [], working: [], reselect: [], usage: [], grossTotal: '0.00', projects: [], deadlineWarnings: [], submittedAt: null },
    // The catalog check lives in the ERP job (ADR-0014); a mismatch it found shows here until the next submission.
    catalog: catalogView(erp) ?? { status: 'pending', problems: [] },
    // Nothing is prepared before the confirmation any more.
    preparation: { status: digest ? 'ready' : 'pending', problems: [], packageFiles: [] },
    // An imported legacy task shows only its stored ERP facts: the saved draft's number, or the 转人工 bucket.
    erp: legacy ? legacyErpView(legacy) : erpView(erp),
    readback: readbackView(erp, lines),
    reconcile:
      (legacy ? legacyReconcileView(legacy) : null) ??
      reconcileView(erp, task.task_id, task.lifecycle, lines) ?? { status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null, draftNo: null, rows: [], reasons: [], capture: null },
    step,
    // In contract order, so equal policies give equal snapshots.
    allowedActions: TASK_ACTIONS.filter((action) => allowedActions.has(action)),
  };
}

function materialWithSourceUrls(taskId: string, material: InventoryView['materials'][number]): InventoryView['materials'][number] {
  const sourceUrl = (contentHash: string) => `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(contentHash)}`;
  return {
    ...material,
    originalUrl: sourceUrl(material.contentHash),
    previewUrl: sourceUrl(material.contentHash),
    variants: material.variants.map((variant) => ({ ...variant, originalUrl: sourceUrl(variant.contentHash), previewUrl: sourceUrl(variant.contentHash) })),
  };
}
