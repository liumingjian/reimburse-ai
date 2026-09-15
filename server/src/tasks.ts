import { randomUUID } from 'node:crypto';
import type { Material, TaskList, TaskListItem, TaskSnapshot, UploadBatch } from '@baox/contract';
import type { Db } from './db/database';
import { IMPLICIT_ACCOUNT_ID } from './db/migrations';
import type { MaterialTable, TaskTable, UploadBatchTable } from './db/schema';
import { writeBlob } from './data-dir';

// 报销任务 (reimbursement task) facts and the snapshot projected from them. Slice 01 knows only the upload stage;
// the pure projection `project(facts) → {stage, step, blockers}` of ADR-0014 grows here slice by slice.

export type UploadedFile = { fileName: string; mime: string; bytes: Uint8Array };

// Contract times are ISO 8601 to the second.
const now = () => `${new Date().toISOString().slice(0, 19)}Z`;
const IMAGE_FILE = /\.(jpe?g|png)$/i;

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} does not exist`);
  }
}

export function createTaskService(db: Db, dataDir: string) {
  // Until accounts land (#193) every request acts as the implicit account.
  const accountId = IMPLICIT_ACCOUNT_ID;

  async function taskRow(taskId: string): Promise<TaskTable> {
    const row = await db.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  async function snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await taskRow(taskId);
    const batches = await db.selectFrom('upload_batch').selectAll().where('task_id', '=', taskId).orderBy('no').execute();
    const materials = await db
      .selectFrom('material')
      .innerJoin('blob', 'blob.sha256', 'material.blob_sha256')
      .selectAll('material')
      .select(['blob.size', 'blob.mime'])
      .where('material.task_id', '=', taskId)
      .orderBy('material.created_at')
      .orderBy('material.material_id')
      .execute();
    return projectSnapshot(task, batches, materials);
  }

  return {
    snapshot,

    async list(): Promise<TaskList> {
      const account = await db.selectFrom('account').selectAll().where('account_id', '=', accountId).executeTakeFirstOrThrow();
      const tasks = await db.selectFrom('task').selectAll().where('account_id', '=', accountId).orderBy('updated_at', 'desc').execute();
      return {
        // Identity-era startup fields (#193 removes them): the implicit account counts as logged in and bound.
        erpSession: 'logged_in',
        employee: { displayName: account.display_name, account: account.account_id, tenant: account.account_id, binding: 'bound' },
        homeCity: null,
        tasks: tasks.map(listItem),
      };
    },

    async create(homeCity: string): Promise<TaskSnapshot> {
      const at = now();
      const taskId = randomUUID();
      await db
        .insertInto('task')
        .values({ task_id: taskId, account_id: accountId, name: `${at.slice(0, 10)} 新建报销`, home_city: homeCity, lifecycle: 'open', revision: 1, created_at: at, updated_at: at })
        .execute();
      return snapshot(taskId);
    },

    // One 上传批次 (upload batch). Blobs land on disk before any row refers to them.
    async upload(taskId: string, files: readonly UploadedFile[]): Promise<TaskSnapshot> {
      await taskRow(taskId);
      const stored = files.map((file) => ({ ...file, sha256: writeBlob(dataDir, file.bytes) }));
      const at = now();
      await db.transaction().execute(async (tx) => {
        const last = await tx.selectFrom('upload_batch').select((eb) => eb.fn.max('no').as('no')).where('task_id', '=', taskId).executeTakeFirst();
        const batchId = randomUUID();
        await tx.insertInto('upload_batch').values({ batch_id: batchId, task_id: taskId, account_id: accountId, no: (last?.no ?? 0) + 1, uploaded_at: at }).execute();
        for (const file of stored) {
          await tx
            .insertInto('blob')
            .values({ sha256: file.sha256, size: file.bytes.byteLength, mime: file.mime, created_at: at })
            .onConflict((oc) => oc.column('sha256').doNothing())
            .execute();
          await tx
            .insertInto('material')
            .values({ material_id: randomUUID(), task_id: taskId, account_id: accountId, batch_id: batchId, blob_sha256: file.sha256, file_name: file.fileName, created_at: at })
            .execute();
        }
        await tx.updateTable('task').set((eb) => ({ revision: eb('revision', '+', 1), updated_at: at })).where('task_id', '=', taskId).execute();
      });
      return snapshot(taskId);
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;

type MaterialRow = MaterialTable & { size: number; mime: string };

function listItem(task: TaskTable): TaskListItem {
  return {
    taskId: task.task_id,
    name: task.name,
    stage: 'upload',
    period: null,
    grossTotal: null,
    erpDraftNo: null,
    pendingCount: 0,
    erpOutcome: 'none',
    abandonable: true,
    abandonBlockedReason: null,
    updatedAt: task.updated_at,
  };
}

function material(row: MaterialRow): Material {
  const image = IMAGE_FILE.test(row.file_name) || row.mime.startsWith('image/');
  return {
    materialId: row.material_id,
    batchId: row.batch_id,
    fileName: row.file_name,
    contentHash: row.blob_sha256,
    size: row.size,
    kindLabel: '待盘点',
    categoryLabel: null,
    role: 'uploaded',
    shape: image ? 'photo' : 'portrait',
    mediaType: image ? 'image' : 'pdf',
    status: 'uploaded',
    checkText: '',
    linkedMaterialIds: [],
    pendingItemIds: [],
    originalUrl: null,
    previewUrl: null,
    fields: [],
  };
}

function projectSnapshot(task: TaskTable, batches: readonly UploadBatchTable[], materials: readonly MaterialRow[]): TaskSnapshot {
  const batchViews: UploadBatch[] = batches.map((batch) => ({
    batchId: batch.batch_id,
    no: batch.no,
    uploadedAt: batch.uploaded_at,
    versionId: null,
    files: materials
      .filter((row) => row.batch_id === batch.batch_id)
      .map((row) => ({
        fileId: row.material_id,
        fileName: row.file_name,
        size: row.size,
        status: 'accepted',
        contentHash: row.blob_sha256,
        reasonCode: null,
        reason: null,
        materialId: row.material_id,
      })),
  }));
  return {
    task: { taskId: task.task_id, name: task.name, period: null, homeCity: task.home_city, createdAt: task.created_at, updatedAt: task.updated_at },
    stage: 'upload',
    batches: batchViews,
    materials: materials.map(material),
    inventory: { status: 'not_started', versionId: null, phases: [], finishedAt: null, summary: null, ungroupedMaterialIds: [] },
    events: [],
    pendingItems: [],
    blockers: [],
    lines: [],
    confirmation: { status: 'unconfirmed', confirmedAt: null, digest: null, lineCount: 0, invoiceCount: 0, grossTotal: null, notice: null },
    paymentScreenshots: [],
    printSheet: { status: 'not_generated', fileName: null, url: null, pages: [], notices: [] },
    projectAssignment: { status: 'not_started', purpose: null, homeCity: task.home_city, assignments: [], working: [], usage: [], projects: [], submittedAt: null },
    catalog: { status: 'pending', problems: [] },
    preparation: { status: 'pending', problems: [], packageFiles: [] },
    erp: { status: 'idle', steps: [], draftNo: null, abortReason: null, loginNotice: null },
    readback: { status: 'none', rows: [], summary: null, localTotal: null, erpTotal: null },
    reconcile: { status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null, draftNo: null, rows: [], reasons: [] },
    // stepToken is per task: taskId + the revision bumped on every accepted fact change (ADR-0014).
    step: { kind: 'upload_materials', stepToken: `${task.task_id}.${task.revision}` },
  };
}
