import { createHash, randomUUID } from 'node:crypto';
import {
  ABANDON_TASK_COPY,
  CREATE_TASK_ERRORS,
  type ActionError,
  type Material,
  type TaskList,
  type TaskListItem,
  type TaskSnapshot,
  type UploadBatch,
  type UploadFileResult,
} from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from './db/database';
import type { MaterialTable, TaskTable, UploadBatchTable, UploadRejectionTable } from './db/schema';
import { writeBlob } from './data-dir';
import { inventoried, isNonTerminal, project, stepToken, type TaskFacts } from './projection';
import { rejectByShape, rejectReason } from './upload-rules';

// 报销任务 (reimbursement task) facts, the actions that append them, and the snapshot projected from them.
// Every accepted change goes through `mutate`: stepToken check, refusal, revision bump, then `onChange` (SSE).

export type UploadedFile = { fileName: string; mime: string; bytes: Uint8Array };

// Contract times are ISO 8601 to the second.
const now = () => `${new Date().toISOString().slice(0, 19)}Z`;
const IMAGE_FILE = /\.(jpe?g|png)$/i;

export const ACTION_COPY = {
  taskClosed: '这个报销任务已作废或已结束，不能再改动。',
  notReadyToStart: '现在还不能开始材料盘点：没有未盘点的材料。',
  notReopenable: '还没有开始材料盘点，不需要重新打开上传。',
  materialNotFound: '这个任务里没有这份材料。',
  alreadyExcluded: '这份材料已经排除。',
  notAbandonable: '这个报销任务已结束，不能作废。',
} as const;

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} does not exist`);
  }
}

// A stale stepToken: the HTTP layer answers 409 with the fresh snapshot.
export class StaleStepError extends Error {
  constructor(readonly snapshot: TaskSnapshot) {
    super('stale stepToken');
  }
}

// The action is not allowed in the task's current facts: 400 `{error, snapshot?}` (or `{error, taskList?}` for
// list-level actions). Never 409, which the web adapter reads as stale_step.
export class ActionRefusedError extends Error {
  constructor(
    readonly error: ActionError,
    readonly snapshot: TaskSnapshot | null = null,
    readonly taskList: TaskList | null = null,
  ) {
    super(error.message);
  }
}

type Refusal = { code: string; message: string };
type Tx = Db;
type Context = { tx: Tx; task: TaskTable; facts: TaskFacts; at: string; revision: number };

type MaterialRow = MaterialTable & { size: number; mime: string; row_no: number; excluded: number };

export type TaskServiceOptions = { onChange?: (snapshot: TaskSnapshot) => void };

// Scoped to one account: every read and write sees only that account's tasks (ADR-0018). Another account's task is
// indistinguishable from a missing one.
export function createTaskService(db: Db, dataDir: string, accountId: string, { onChange = () => {} }: TaskServiceOptions = {}) {
  async function taskRow(tx: Tx, taskId: string): Promise<TaskTable> {
    const row = await tx.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  async function materialRows(tx: Tx, taskId: string): Promise<MaterialRow[]> {
    return tx
      .selectFrom('material')
      .innerJoin('blob', 'blob.sha256', 'material.blob_sha256')
      .leftJoin('material_exclusion', 'material_exclusion.material_id', 'material.material_id')
      .selectAll('material')
      .select(['blob.size', 'blob.mime', sql<number>`material.rowid`.as('row_no'), sql<number>`material_exclusion.exclusion_id IS NOT NULL`.as('excluded')])
      .where('material.task_id', '=', taskId)
      .orderBy(sql`material.rowid`)
      .execute();
  }

  async function loadFacts(tx: Tx, task: TaskTable, materials?: readonly MaterialRow[]): Promise<TaskFacts> {
    const rows = materials ?? (await materialRows(tx, task.task_id));
    const run = await tx.selectFrom('inventory_run').select(['version_no', 'revision']).where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
    const reopen = await tx.selectFrom('upload_reopen').select('revision').where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
    return {
      taskId: task.task_id,
      revision: task.revision,
      lifecycle: task.lifecycle,
      versionNo: new Set(rows.map((row) => row.batch_id)).size,
      includedMaterialCount: rows.filter((row) => !row.excluded).length,
      lastRun: run ? { versionNo: run.version_no, revision: run.revision } : null,
      lastReopenRevision: reopen?.revision ?? null,
    };
  }

  async function snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await taskRow(db, taskId);
    const batches = await db.selectFrom('upload_batch').selectAll().where('task_id', '=', taskId).orderBy('no').execute();
    const rejections = await db.selectFrom('upload_rejection').selectAll().where('task_id', '=', taskId).execute();
    const materials = await materialRows(db, taskId);
    return projectSnapshot(task, await loadFacts(db, task, materials), batches, rejections, materials);
  }

  // One accepted change: check the stepToken (when the action carries one), let `apply` refuse or append facts,
  // bump the revision, then publish the fresh snapshot. A refusal or stale token writes nothing.
  async function mutate(taskId: string, token: string | null, apply: (ctx: Context) => Promise<Refusal | void>): Promise<TaskSnapshot> {
    const outcome = await db.transaction().execute(async (tx): Promise<{ kind: 'ok' } | { kind: 'stale' } | ({ kind: 'refused' } & Refusal)> => {
      const task = await taskRow(tx, taskId);
      if (token !== null && token !== stepToken(task.task_id, task.revision)) return { kind: 'stale' };
      if (task.lifecycle !== 'open') return { kind: 'refused', code: 'task_closed', message: ACTION_COPY.taskClosed };
      const at = now();
      const revision = task.revision + 1;
      const refusal = await apply({ tx, task, facts: await loadFacts(tx, task), at, revision });
      if (refusal) return { kind: 'refused', ...refusal };
      await tx.updateTable('task').set({ revision, updated_at: at }).where('task_id', '=', taskId).execute();
      return { kind: 'ok' };
    });
    const fresh = await snapshot(taskId);
    if (outcome.kind === 'stale') throw new StaleStepError(fresh);
    if (outcome.kind === 'refused') throw new ActionRefusedError({ code: outcome.code, message: outcome.message }, fresh);
    onChange(fresh);
    return fresh;
  }

  async function list(): Promise<TaskList> {
    // 任务作废 (void task) removes the task from the list; its facts stay on disk.
    const tasks = await db.selectFrom('task').selectAll().where('account_id', '=', accountId).where('lifecycle', '!=', 'voided').orderBy('updated_at', 'desc').execute();
    const items: TaskListItem[] = [];
    for (const task of tasks) items.push(listItem(task, await loadFacts(db, task)));
    return { homeCity: null, tasks: items };
  }

  return {
    snapshot,
    list,

    // 完全重置 (reset) of this account: its open tasks are voided (facts stay, ADR-0015) and leave the list.
    // The personal book and home city join this when they land (#188).
    async resetAll(): Promise<TaskList> {
      const open = await db.selectFrom('task').select('task_id').where('account_id', '=', accountId).where('lifecycle', '=', 'open').execute();
      await db
        .updateTable('task')
        .set((eb) => ({ lifecycle: 'voided', revision: eb('revision', '+', 1), updated_at: now() }))
        .where('account_id', '=', accountId)
        .where('lifecycle', '=', 'open')
        .execute();
      for (const { task_id } of open) onChange(await snapshot(task_id));
      return list();
    },

    // At most one non-terminal task per account.
    async create(homeCity: string): Promise<TaskSnapshot> {
      const at = now();
      const taskId = randomUUID();
      const created = await db.transaction().execute(async (tx) => {
        const open = await tx.selectFrom('task').select(['lifecycle']).where('account_id', '=', accountId).execute();
        if (open.some((task) => isNonTerminal(task.lifecycle))) return false;
        await tx
          .insertInto('task')
          .values({ task_id: taskId, account_id: accountId, name: `${at.slice(0, 10)} 新建报销`, home_city: homeCity, lifecycle: 'open', revision: 1, created_at: at, updated_at: at })
          .execute();
        return true;
      });
      if (!created) throw new ActionRefusedError({ code: 'active_task_exists', message: CREATE_TASK_ERRORS.activeTaskExists });
      return snapshot(taskId);
    },

    // One 上传批次 (upload batch). Each file is accepted or rejected with a reason code; accepted bytes land on disk
    // (content-addressed) before any row refers to them. A batch that adds a material forms a new inventory version.
    async upload(taskId: string, files: readonly UploadedFile[]): Promise<TaskSnapshot> {
      const judged = files.map((file) => ({ ...file, shape: rejectByShape(file.fileName, file.mime, file.bytes.byteLength), sha256: createHash('sha256').update(file.bytes).digest('hex') }));
      for (const file of judged) if (file.shape === null) writeBlob(dataDir, file.bytes);
      return mutate(taskId, null, async ({ tx, at }) => {
        const known = new Map<string, string>();
        for (const row of await tx.selectFrom('material').select(['blob_sha256', 'file_name']).where('task_id', '=', taskId).orderBy(sql`rowid`).execute()) {
          if (!known.has(row.blob_sha256)) known.set(row.blob_sha256, row.file_name);
        }
        const last = await tx.selectFrom('upload_batch').select((eb) => eb.fn.max('no').as('no')).where('task_id', '=', taskId).executeTakeFirst();
        const batchId = randomUUID();
        await tx.insertInto('upload_batch').values({ batch_id: batchId, task_id: taskId, account_id: accountId, no: (last?.no ?? 0) + 1, uploaded_at: at }).execute();
        for (const [seq, file] of judged.entries()) {
          const duplicateOf = file.shape === null ? known.get(file.sha256) : undefined;
          const code = file.shape ?? (duplicateOf !== undefined ? 'duplicate_content' : null);
          if (code) {
            await tx
              .insertInto('upload_rejection')
              .values({ rejection_id: randomUUID(), task_id: taskId, account_id: accountId, batch_id: batchId, batch_seq: seq, file_name: file.fileName, size: file.bytes.byteLength, reason_code: code, reason: rejectReason(code, duplicateOf), created_at: at })
              .execute();
            continue;
          }
          known.set(file.sha256, file.fileName);
          await tx.insertInto('blob').values({ sha256: file.sha256, size: file.bytes.byteLength, mime: file.mime, created_at: at }).onConflict((oc) => oc.column('sha256').doNothing()).execute();
          await tx
            .insertInto('material')
            .values({ material_id: randomUUID(), task_id: taskId, account_id: accountId, batch_id: batchId, blob_sha256: file.sha256, file_name: file.fileName, created_at: at, batch_seq: seq })
            .execute();
        }
      });
    },

    // Explicit start of 材料盘点 on the current version (ADR-0014: inventory never starts by itself).
    async startInventory(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, at, revision }) => {
        if (project(facts).step.kind !== 'start_inventory') return { code: 'not_ready', message: ACTION_COPY.notReadyToStart };
        await tx.insertInto('inventory_run').values({ run_id: randomUUID(), task_id: taskId, account_id: accountId, version_no: facts.versionNo, revision, started_at: at }).execute();
      });
    },

    // Back to upload after inventory. Uploading or re-starting inventory then forms the next result.
    async reopenUpload(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, at, revision }) => {
        if (!inventoried(facts)) return { code: 'not_ready', message: ACTION_COPY.notReopenable };
        await tx.insertInto('upload_reopen').values({ reopen_id: randomUUID(), task_id: taskId, account_id: accountId, revision, reopened_at: at }).execute();
      });
    },

    // 人工纠正 (manual correction) inside the current version: excluding forms no new version.
    async excludeMaterial(taskId: string, materialId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, at, revision }) => {
        const material = await tx
          .selectFrom('material')
          .leftJoin('material_exclusion', 'material_exclusion.material_id', 'material.material_id')
          .select(['material.material_id', 'material_exclusion.exclusion_id'])
          .where('material.task_id', '=', taskId)
          .where('material.material_id', '=', materialId)
          .executeTakeFirst();
        if (!material) return { code: 'material_not_found', message: ACTION_COPY.materialNotFound };
        if (material.exclusion_id) return { code: 'already_excluded', message: ACTION_COPY.alreadyExcluded };
        await tx.insertInto('material_exclusion').values({ exclusion_id: randomUUID(), task_id: taskId, account_id: accountId, material_id: materialId, revision, created_at: at }).execute();
      });
    },

    // 任务作废 (void task): a lifecycle change, not a deletion. Returns the task list without the task.
    // TODO(#181/#192): refuse once an ERP action attempt exists (ADR-0007 occupancy); none exist before the ERP job.
    async voidTask(taskId: string): Promise<TaskList> {
      const task = await db.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
      if (!task || task.lifecycle === 'voided') throw new ActionRefusedError({ code: 'task_not_found', message: ABANDON_TASK_COPY.notFound }, null, await list());
      if (task.lifecycle !== 'open') throw new ActionRefusedError({ code: 'not_abandonable', message: ACTION_COPY.notAbandonable }, null, await list());
      const at = now();
      await db.updateTable('task').set({ lifecycle: 'voided', revision: task.revision + 1, updated_at: at }).where('task_id', '=', taskId).execute();
      onChange(await snapshot(taskId));
      return list();
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;

function listItem(task: TaskTable, facts: TaskFacts): TaskListItem {
  return {
    taskId: task.task_id,
    name: task.name,
    stage: project(facts).stage,
    period: null,
    grossTotal: null,
    erpDraftNo: null,
    pendingCount: 0,
    erpOutcome: 'none',
    abandonable: task.lifecycle === 'open',
    abandonBlockedReason: task.lifecycle === 'open' ? null : ACTION_COPY.notAbandonable,
    updatedAt: task.updated_at,
  };
}

function material(row: MaterialRow): Material {
  const image = IMAGE_FILE.test(row.file_name) || row.mime.startsWith('image/');
  const excluded = Boolean(row.excluded);
  return {
    materialId: row.material_id,
    batchId: row.batch_id,
    fileName: row.file_name,
    contentHash: row.blob_sha256,
    size: row.size,
    kindLabel: '待盘点',
    categoryLabel: null,
    role: excluded ? 'excluded' : 'uploaded',
    shape: image ? 'photo' : 'portrait',
    mediaType: image ? 'image' : 'pdf',
    status: excluded ? 'excluded' : 'uploaded',
    checkText: excluded ? '已排除：不参与盘点，也不进入材料包' : '',
    linkedMaterialIds: [],
    pendingItemIds: [],
    originalUrl: null,
    previewUrl: null,
    fields: [],
  };
}

// Files of a batch in upload order: accepted materials and rejections interleaved by their position in the batch.
function batchFiles(batchId: string, materials: readonly MaterialRow[], rejections: readonly UploadRejectionTable[]): UploadFileResult[] {
  const entries: { order: number; file: UploadFileResult }[] = [];
  for (const row of materials.filter((m) => m.batch_id === batchId)) {
    entries.push({
      // Materials from before 0002_180 have no position; they keep insertion order after any positioned file.
      order: row.batch_seq ?? 1e9 + row.row_no,
      file: { fileId: row.material_id, fileName: row.file_name, size: row.size, status: 'accepted', contentHash: row.blob_sha256, reasonCode: null, reason: null, materialId: row.material_id },
    });
  }
  for (const row of rejections.filter((r) => r.batch_id === batchId)) {
    entries.push({
      order: row.batch_seq,
      file: { fileId: row.rejection_id, fileName: row.file_name, size: row.size, status: 'rejected', contentHash: null, reasonCode: row.reason_code, reason: row.reason, materialId: null },
    });
  }
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.file);
}

function projectSnapshot(task: TaskTable, facts: TaskFacts, batches: readonly UploadBatchTable[], rejections: readonly UploadRejectionTable[], materials: readonly MaterialRow[]): TaskSnapshot {
  const { stage, step, blockers } = project(facts);
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
  const excludedIds = materials.filter((m) => m.excluded).map((m) => m.material_id);
  const done = stage === 'inventory';
  return {
    task: { taskId: task.task_id, name: task.name, period: null, homeCity: task.home_city, createdAt: task.created_at, updatedAt: task.updated_at },
    stage,
    batches: batchViews,
    materials: materials.map(material),
    // Until parsing lands (#183) an inventory run finishes at once with every included material still unclassified.
    inventory: done
      ? {
          status: 'done',
          versionId: `v${facts.versionNo}`,
          phases: [],
          finishedAt: task.updated_at,
          summary: { materialCount: facts.includedMaterialCount, okCount: 0, pendingMaterialCount: 0, voucherCount: 0, referenceCount: 0, openPendingItemCount: 0 },
          ungroupedMaterialIds: excludedIds,
        }
      : { status: 'not_started', versionId: facts.versionNo > 0 ? `v${facts.versionNo}` : null, phases: [], finishedAt: null, summary: null, ungroupedMaterialIds: [] },
    events: [],
    pendingItems: [],
    blockers,
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
    step,
  };
}
