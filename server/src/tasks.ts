import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ABANDON_TASK_COPY,
  CONFIRM_REVIEW_ERRORS,
  CREATE_TASK_ERRORS,
  HOME_CITY_ERRORS,
  PENDING_ANSWER_ERRORS,
  PENDING_CHOICE_KEY,
  PROJECT_ASSIGNMENT_ERRORS,
  HUMAN_REVIEW_NOTICE,
  REOPEN_UPLOAD_ERRORS,
  fieldAnswer,
  type ActionError,
  type ReconcileBucket,
  type AssignProjectLinesInput,
  type Confirmation,
  type Corners,
  type Line,
  type PlacementSlot,
  type PendingAnswer,
  type ProjectAssignmentInput,
  type TaskList,
  type TaskListItem,
  type TaskSnapshot,
  type UploadBatch,
  type UploadFileResult,
} from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from './db/database';
import type { LegacyTaskTable, MaterialTable, TaskTable, UploadBatchTable, UploadRejectionTable } from './db/schema';
import { legacyHoldings } from './legacy/import';
import { blobPath, writeBlob } from './data-dir';
import { inventoryView, type InventoryView, type ViewMaterial } from './inventory-view';
import { occupancyBlockers, type Holding } from './occupancy-ledger';
import type { ParseOutcome } from './parse/dispatch';
import type { ParseInput } from './parse/material';
import { EXCLUDE_CHOICE, judgeAnswer, type Verdict } from './pending/answers';
import { EDIT_COPY, EDIT_PREFIX, judgeEdit } from './pending/edits';
import { inventoried, isNonTerminal, parseRunning, project, stepToken, type TaskFacts } from './projection';
import { rejectByShape, rejectReason } from './upload-rules';
import { assignmentOf, checkAssign, checkSubmit, linesDigest, type Assignment, type AssignmentFact, type PinnedProject } from './assignment';
import { bookOptions, createBookService, type BookOption } from './books';
import { unavailableCatalog } from './catalog/project-catalog';
import { COMPANY_RULES, pinnedCompanyRules, putRuleSet, validHomeCity, type CompanyRules } from './rules/company-rules';
import { rememberedHomeCity, rememberHomeCity } from './settings';
import { confirmationDigest, confirmationStatus, confirmationView, type ConfirmationDigest, type ConfirmationFact } from './confirmation';
import { loadPrintFacts, printFileShas, printView, sheetState, type PrintFacts } from './print/facts';
import * as printActions from './print/service';
import { PrintRefusal, type PrintCommit, type PrintState } from './print/service';

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
  notAnswering: '现在没有可以答复的待确认项。',
  itemNotFound: '这次盘点没有这个待确认项。',
} as const;

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} does not exist`);
  }
}

// A stale stepToken, or any mutation while a job runs: the HTTP layer answers 409 with the fresh snapshot.
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
type Context = { tx: Tx; task: TaskTable; facts: TaskFacts; loaded: Loaded; view: InventoryView; at: string; revision: number };

type MaterialRow = MaterialTable & { size: number; mime: string; row_no: number; excluded: number };

type Loaded = {
  facts: TaskFacts;
  view: InventoryView;
  runId: string | null;
  parsed: ReadonlySet<string>;
  // The task's current 常驻城市 snapshot and pinned company rules (#188).
  homeCity: string;
  rules: CompanyRules;
  // 项目归属 once the inventory is clean; null before.
  assignment: Assignment | null;
  // The ERP facts of an imported legacy task (#195); null for every task created in the app.
  legacy: LegacyTaskTable | null;
  // The lines as listed (with project and expense item), the digest a confirmation would be made over (null while
  // there is nothing to confirm), and the latest stored confirmation (#189).
  lines: Line[];
  digest: ConfirmationDigest | null;
  confirmed: ConfirmationFact | null;
  // 打印稿 (#190): settings, payment screenshots and the latest composed sheet.
  print: PrintFacts;
};

// Steps under which the assignment draft and the submission may change: before confirmation and after it (a change
// invalidates the confirmation), until the first ERP action attempt (#191 adds the ERP-attempt freeze).
const ASSIGN_STEPS: ReadonlySet<string> = new Set(['assign_projects', 'confirm_review', 'choose_action']);

// The next material the parser job should parse. `preset` is an outcome decided without parsing (original missing).
export type ParseWork = { runId: string; input: ParseInput; preset: ParseOutcome | null };

// A refusal the parser job expects when the run moved on under it; never shown to anyone.
const STALE_JOB = { code: 'stale_job', message: 'the inventory run changed under the parser job' } as const;

export type TaskServiceOptions = { onChange?: (snapshot: TaskSnapshot) => void };

const mediaTypeOf = (row: MaterialRow): 'pdf' | 'image' => (IMAGE_FILE.test(row.file_name) || row.mime.startsWith('image/') ? 'image' : 'pdf');

const viewMaterial = (row: MaterialRow): ViewMaterial => ({
  materialId: row.material_id,
  batchId: row.batch_id,
  fileName: row.file_name,
  contentHash: row.blob_sha256,
  size: row.size,
  mediaType: mediaTypeOf(row),
  excluded: Boolean(row.excluded),
  uploadedAt: row.created_at,
  uploadSeq: row.row_no,
});

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

// Facts plus the inventory view of the current run (materials, pending items, events, lines), with the stored answers
// applied, and the 项目归属 (#188) of a clean inventory. Without occupancy, so the occupancy ledger can read any task
// through it; the task's own account scopes its project books.
async function loadTask(tx: Tx, task: TaskTable, materials?: readonly MaterialRow[]): Promise<Loaded> {
  const rows = materials ?? (await materialRows(tx, task.task_id));
  const run = await tx.selectFrom('inventory_run').select(['run_id', 'version_no', 'revision', 'started_at']).where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  const reopen = await tx.selectFrom('upload_reopen').select('revision').where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  const legacy = task.origin === 'legacy' ? ((await tx.selectFrom('legacy_task').selectAll().where('task_id', '=', task.task_id).executeTakeFirst()) ?? null) : null;
  const facts: TaskFacts = {
    ...(legacy ? { legacyOutcome: legacy.outcome } : {}),
    taskId: task.task_id,
    revision: task.revision,
    lifecycle: task.lifecycle,
    versionNo: new Set(rows.map((row) => row.batch_id)).size,
    includedMaterialCount: rows.filter((row) => !row.excluded).length,
    lastRun: run ? { versionNo: run.version_no, revision: run.revision } : null,
    lastReopenRevision: reopen?.revision ?? null,
    parse: null,
    project: null,
    confirmation: 'unconfirmed',
  };
  const homeCity = await currentHomeCity(tx, task);
  const rules = await pinnedCompanyRules(tx, task.task_id);
  const current = run && inventoried(facts) ? run : null;
  const results = current ? await tx.selectFrom('parse_result').select(['material_id', 'detail', 'created_at']).where('run_id', '=', current.run_id).orderBy('revision').execute() : [];
  // Answers outlive runs: a re-derived item with the same id meets its latest answer.
  const answers = new Map<string, PendingAnswer>();
  if (current) {
    for (const row of await tx.selectFrom('pending_answer').select(['item_id', 'answer']).where('task_id', '=', task.task_id).orderBy('revision').execute()) {
      answers.set(row.item_id, JSON.parse(row.answer) as PendingAnswer);
    }
  }
  const view = inventoryView(
    rows.map(viewMaterial),
    current
      ? {
          outcomes: new Map(results.map((result) => [result.material_id, JSON.parse(result.detail) as ParseOutcome])),
          startedAt: current.started_at,
          finishedAt: results.at(-1)?.created_at ?? null,
        }
      : null,
    { homeCity, rules },
    answers,
  );
  if (current) facts.parse = { waiting: view.waiting, openPendingItems: view.openPendingItems, blockers: [] };
  let assignment: Assignment | null = null;
  let options: BookOption[] = [];
  if (current && view.waiting === 0 && view.openPendingItems === 0) {
    options = await bookOptions(tx, task.account_id, new Date());
    assignment = assignmentOf(view.lines, await assignmentFacts(tx, task.task_id), options, homeCity, true);
    facts.project = { lineCount: view.lines.length, selectableCount: options.length, workingCount: assignment.view.working.length, submitted: assignment.submitted !== null };
  }
  const lines = enrichLines(view.lines, rules, assignment);
  const submitted = assignment?.submitted ?? null;
  const digest = submitted ? confirmationDigest({ lines, purpose: submitted.purpose, selection: submitted.selection, selectable: new Set(options.map((option) => `${option.source}:${option.number}`)), rules, catalogHash: submitted.catalogHash, homeCity }) : null;
  const confirmed = await latestConfirmation(tx, task.task_id);
  facts.confirmation = confirmationStatus(digest, confirmed, facts.lastReopenRevision);
  const print = await loadPrintFacts(tx, task.task_id);
  return { facts, view, runId: current?.run_id ?? null, parsed: new Set(results.map((result) => result.material_id)), homeCity, rules, assignment, legacy, lines, digest, confirmed, print };
}

async function latestConfirmation(tx: Tx, taskId: string): Promise<ConfirmationFact | null> {
  const row = await tx.selectFrom('review_confirmation').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  return row ? { digest: row.digest, detail: row.detail_digest, project: row.project_digest, confirmedAt: row.confirmed_at, revision: row.revision } : null;
}

// Every other task that still holds invoices (open, or handed off after touching ERP), in any account.
async function holdings(tx: Tx, exceptTaskId: string): Promise<Holding[]> {
  const others = await tx.selectFrom('task').selectAll().where('task_id', '!=', exceptTaskId).where('lifecycle', 'in', ['open', 'handed_off']).where('origin', '=', 'app').execute();
  const found: Holding[] = [];
  for (const task of others) {
    const { view } = await loadTask(tx, task);
    if (view.claims.length > 0) found.push({ accountId: task.account_id, taskId: task.task_id, taskName: task.name, handedOff: task.lifecycle === 'handed_off', claims: view.claims });
  }
  // Imported legacy tasks hold only their stored invoice keys (#195).
  return [...found, ...(await legacyHoldings(tx))];
}

async function excludeOnce(tx: Tx, taskId: string, accountId: string, materialId: string, revision: number, at: string): Promise<void> {
  const existing = await tx.selectFrom('material_exclusion').select('exclusion_id').where('material_id', '=', materialId).executeTakeFirst();
  if (!existing) await tx.insertInto('material_exclusion').values({ exclusion_id: randomUUID(), task_id: taskId, account_id: accountId, material_id: materialId, revision, created_at: at }).execute();
}

// Scoped to one account: every read and write sees only that account's tasks (ADR-0018). Another account's task is
// indistinguishable from a missing one.
export function createTaskService(db: Db, dataDir: string, accountId: string, { onChange = () => {} }: TaskServiceOptions = {}) {
  async function taskRow(tx: Tx, taskId: string): Promise<TaskTable> {
    const row = await tx.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  // The task's own facts and view, plus the cross-task 发票占用 blockers. A blocked batch forms no events and no
  // pending items until the held invoices are excluded.
  async function load(tx: Tx, task: TaskTable, materials?: readonly MaterialRow[]): Promise<Loaded> {
    const loaded = await loadTask(tx, task, materials);
    const { facts, view } = loaded;
    if (!facts.parse || view.waiting > 0 || view.claims.length === 0 || task.lifecycle !== 'open') return loaded;
    const blockers = await occupancyBlockers(await holdings(tx, task.task_id), accountId, view.claims);
    if (blockers.length === 0) return loaded;
    facts.parse = { ...facts.parse, openPendingItems: 0, blockers };
    facts.project = null;
    facts.confirmation = confirmationStatus(null, loaded.confirmed, facts.lastReopenRevision);
    const summary = view.inventory.summary ? { ...view.inventory.summary, openPendingItemCount: 0 } : null;
    return { ...loaded, facts, assignment: null, lines: [], digest: null, view: { ...view, pendingItems: [], events: [], lines: [], openPendingItems: 0, inventory: { ...view.inventory, summary } } };
  }

  async function snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await taskRow(db, taskId);
    const batches = await db.selectFrom('upload_batch').selectAll().where('task_id', '=', taskId).orderBy('no').execute();
    const rejections = await db.selectFrom('upload_rejection').selectAll().where('task_id', '=', taskId).execute();
    const materials = await materialRows(db, taskId);
    return projectSnapshot(task, await load(db, task, materials), batches, rejections, materials);
  }

  // One accepted change: check the stepToken (when the action carries one), let `apply` refuse or append facts,
  // bump the revision, then publish the fresh snapshot. A refusal or stale token writes nothing. While the parser job
  // runs, only the job itself (`job: true`) may write; everyone else gets the 409 of a stale step (ADR-0014).
  async function mutate(taskId: string, token: string | null, apply: (ctx: Context) => Promise<Refusal | void>, { job = false } = {}): Promise<TaskSnapshot> {
    const outcome = await db.transaction().execute(async (tx): Promise<{ kind: 'ok' } | { kind: 'stale' } | ({ kind: 'refused' } & Refusal)> => {
      const task = await taskRow(tx, taskId);
      if (token !== null && token !== stepToken(task.task_id, task.revision)) return { kind: 'stale' };
      if (task.lifecycle !== 'open') return { kind: 'refused', code: 'task_closed', message: ACTION_COPY.taskClosed };
      const loaded = await load(tx, task);
      const { facts, view } = loaded;
      if (!job && parseRunning(facts)) return { kind: 'stale' };
      const at = now();
      const revision = task.revision + 1;
      const refusal = await apply({ tx, task, facts, loaded, view, at, revision });
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

  // A 去打印 action. Print actions carry no stepToken from the page (contract); the server composes on the revision it
  // read, outside any transaction, and commits through `mutate` with that revision's token: anything accepted in
  // between turns the commit into a 409 stale_step with the fresh snapshot.
  async function printChange(taskId: string, prepare: (state: PrintState) => Promise<PrintCommit | null>): Promise<TaskSnapshot> {
    const task = await taskRow(db, taskId);
    if (task.lifecycle !== 'open') throw new ActionRefusedError({ code: 'task_closed', message: ACTION_COPY.taskClosed }, await snapshot(taskId));
    const rows = await materialRows(db, taskId);
    const loaded = await load(db, task, rows);
    const state: PrintState = {
      taskId,
      accountId,
      dataDir,
      confirmation: loaded.facts.confirmation,
      confirmedRevision: loaded.confirmed?.revision ?? null,
      lines: loaded.lines,
      materials: loaded.view.materials,
      sources: new Map(rows.filter((row) => !row.excluded).map((row) => [row.material_id, { sha256: row.blob_sha256, mediaType: mediaTypeOf(row), fileName: row.file_name }] as const)),
      facts: loaded.print,
    };
    let commit: PrintCommit | null;
    try {
      commit = await prepare(state);
    } catch (error) {
      if (error instanceof PrintRefusal) throw new ActionRefusedError({ code: error.code, message: error.message }, await snapshot(taskId));
      throw error;
    }
    if (!commit) return snapshot(taskId);
    const run = commit;
    return mutate(taskId, stepToken(task.task_id, task.revision), async ({ tx, at, revision }) => {
      await run(tx, at, revision);
    });
  }

  async function list(): Promise<TaskList> {
    // 任务作废 (void task) removes the task from the list; its facts stay on disk.
    const tasks = await db.selectFrom('task').selectAll().where('account_id', '=', accountId).where('lifecycle', '!=', 'voided').orderBy('updated_at', 'desc').execute();
    const items: TaskListItem[] = [];
    for (const task of tasks) items.push(listItem(task, await load(db, task)));
    const remembered = await rememberedHomeCity(db, accountId);
    return { homeCity: remembered ? { value: remembered, source: 'remembered' } : null, tasks: items };
  }

  return {
    snapshot,
    list,

    // 完全重置 (reset) of this account: its open tasks are voided (facts stay, ADR-0015) and leave the list; its
    // personal book is emptied and its remembered home city forgotten (both as appended facts).
    async resetAll(): Promise<TaskList> {
      await createBookService(db, { scope: 'personal', ownerAccountId: accountId }, accountId, unavailableCatalog()).clear();
      if ((await rememberedHomeCity(db, accountId)) !== null) await rememberHomeCity(db, accountId, null, 'reset', now());
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
    // The home city becomes the task's snapshot and this account's remembered default; the bundled company rules are
    // pinned by content hash (ADR-0015).
    async create(requestedHomeCity: string): Promise<TaskSnapshot> {
      const homeCity = validHomeCity(requestedHomeCity);
      if (!homeCity) throw new ActionRefusedError({ code: 'invalid_home_city', message: HOME_CITY_ERRORS.invalid });
      const at = now();
      const taskId = randomUUID();
      const created = await db.transaction().execute(async (tx) => {
        const open = await tx.selectFrom('task').select(['lifecycle']).where('account_id', '=', accountId).execute();
        if (open.some((task) => isNonTerminal(task.lifecycle))) return false;
        await tx
          .insertInto('task')
          .values({ task_id: taskId, account_id: accountId, name: `${at.slice(0, 10)} 新建报销`, home_city: homeCity, lifecycle: 'open', revision: 1, created_at: at, updated_at: at })
          .execute();
        const hash = await putRuleSet(tx, 'company_rules', COMPANY_RULES, at);
        await tx.insertInto('task_rule_pin').values({ task_id: taskId, account_id: accountId, kind: 'company_rules', hash, created_at: at }).execute();
        await rememberHomeCity(tx, accountId, homeCity, 'task_create', at);
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

    // Explicit start of 材料盘点 on the current version (ADR-0014: inventory never starts by itself). The run's
    // materials then wait for the background parser job (`parse/jobs.ts`).
    async startInventory(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, at, revision }) => {
        if (project(facts).step.kind !== 'start_inventory') return { code: 'not_ready', message: ACTION_COPY.notReadyToStart };
        await tx.insertInto('inventory_run').values({ run_id: randomUUID(), task_id: taskId, account_id: accountId, version_no: facts.versionNo, revision, started_at: at }).execute();
      });
    },

    // Back to upload after inventory. Uploading or re-starting inventory then forms the next result.
    // After a confirmation this voids it for good (`confirmationStatus`); refused once ERP was touched.
    async reopenUpload(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, at, revision }) => {
        if (!inventoried(facts)) return { code: 'not_ready', message: ACTION_COPY.notReopenable };
        const attempt = await tx.selectFrom('erp_attempt').select('attempt_id').where('task_id', '=', taskId).executeTakeFirst();
        if (attempt) return { code: 'erp_started', message: REOPEN_UPLOAD_ERRORS.erpStarted };
        await tx.insertInto('upload_reopen').values({ reopen_id: randomUUID(), task_id: taskId, account_id: accountId, revision, reopened_at: at }).execute();
      });
    },

    // 整单明细确认: stores `{digest, confirmedAt}` for exactly the digest the user saw; any other digest is refused.
    async confirmReview(taskId: string, digest: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, loaded, at, revision }) => {
        if (project(facts).step.kind !== 'confirm_review' || !loaded.digest) return { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady };
        if (loaded.lines.length === 0) return { code: 'no_lines', message: CONFIRM_REVIEW_ERRORS.noLines };
        if (digest !== loaded.digest.digest) return { code: 'digest_mismatch', message: CONFIRM_REVIEW_ERRORS.digestMismatch };
        const { digest: current, detail, project: projectDigest } = loaded.digest;
        await tx
          .insertInto('review_confirmation')
          .values({ confirmation_id: randomUUID(), task_id: taskId, account_id: accountId, digest: current, detail_digest: detail, project_digest: projectDigest, revision, confirmed_at: at })
          .execute();
      });
    },

    // 人工纠正 (manual correction) inside the current version: excluding forms no new version.
    async excludeMaterial(taskId: string, materialId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, view, at, revision }) => {
        const material = await tx
          .selectFrom('material')
          .leftJoin('material_exclusion', 'material_exclusion.material_id', 'material.material_id')
          .select(['material.material_id', 'material_exclusion.exclusion_id'])
          .where('material.task_id', '=', taskId)
          .where('material.material_id', '=', materialId)
          .executeTakeFirst();
        if (!material) return { code: 'material_not_found', message: ACTION_COPY.materialNotFound };
        if (material.exclusion_id) return { code: 'already_excluded', message: ACTION_COPY.alreadyExcluded };
        await excludeOnce(tx, taskId, accountId, materialId, revision, at);
        // A given-up allocation (这张票我认不出) goes with its linked materials (the itinerary).
        if (view.pendingItems.some((item) => item.kind === 'given_up' && item.status === 'open' && item.materialId === materialId)) {
          for (const linked of view.materials.find((m) => m.materialId === materialId)?.linkedMaterialIds ?? []) await excludeOnce(tx, taskId, accountId, linked, revision, at);
        }
      });
    },

    // Answers one 待确认项, or edits one field (`edit.<materialId>.<field>`), per the item kind or the field's edit
    // class. An accepted answer is stored under its item id and carried into every later derivation; the choice
    // `exclude` also excludes the material.
    async answerPending(taskId: string, itemId: string, answer: PendingAnswer, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, view, at, revision }) => {
        if (!facts.parse || facts.parse.blockers.length > 0) return { code: 'not_ready', message: ACTION_COPY.notAnswering };
        let verdict: Verdict;
        let materialId: string;
        const edit = itemId.startsWith(EDIT_PREFIX);
        if (edit) {
          const target = view.editables.get(itemId);
          if (!target) return { code: 'field_not_found', message: EDIT_COPY.notFound };
          verdict = judgeEdit(target, answer);
          materialId = target.materialId;
        } else {
          const found = view.answerables.get(itemId);
          if (!found) return { code: 'item_not_found', message: ACTION_COPY.itemNotFound };
          if (found.item.status !== 'open') return { code: 'item_not_open', message: PENDING_ANSWER_ERRORS.notOpen };
          verdict = judgeAnswer(found.item, answer, found.check);
          materialId = found.item.materialId;
        }
        if (!verdict.ok) return { code: verdict.code, message: verdict.message };
        await tx
          .insertInto('pending_answer')
          .values({ answer_id: randomUUID(), task_id: taskId, account_id: accountId, item_id: itemId, material_id: materialId, answer: JSON.stringify(verdict.answer), revision, created_at: at })
          .execute();
        if (!edit && fieldAnswer(verdict.answer)[PENDING_CHOICE_KEY] === EXCLUDE_CHOICE) await excludeOnce(tx, taskId, accountId, materialId, revision, at);
      });
    },

    // 修改常驻城市: the task's snapshot changes (categories re-derive, so a confirmation digest over the lines is
    // invalidated) and becomes the account's default for new tasks. Refused once an ERP action attempt exists.
    async setHomeCity(taskId: string, requested: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, at, revision }) => {
        const homeCity = validHomeCity(requested);
        if (!homeCity) return { code: 'invalid_home_city', message: HOME_CITY_ERRORS.invalid };
        const attempt = await tx.selectFrom('erp_attempt').select('attempt_id').where('task_id', '=', taskId).executeTakeFirst();
        if (attempt) return { code: 'home_city_locked', message: HOME_CITY_ERRORS.locked };
        await tx.insertInto('task_home_city').values({ change_id: randomUUID(), task_id: taskId, account_id: accountId, home_city: homeCity, revision, created_at: at }).execute();
        await rememberHomeCity(tx, accountId, homeCity, 'task_edit', at);
      });
    },

    // 归入: edits the working draft only; new lines may only go to a currently selectable project.
    async assignProjectLines(taskId: string, input: AssignProjectLinesInput, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, loaded, at, revision }) => {
        if (!loaded.assignment || !ASSIGN_STEPS.has(project(facts).step.kind)) return { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady };
        const pinned = checkAssign(loaded.view.lines, input.lineIds, input.projectNumber.trim(), await bookOptions(tx, accountId, new Date()));
        if ('code' in pinned) return pinned;
        await tx
          .insertInto('project_assign')
          .values({ assign_id: randomUUID(), task_id: taskId, account_id: accountId, revision, line_ids: JSON.stringify(input.lineIds), project_number: pinned.number, project_name: pinned.name, project_source: pinned.source, only_unassigned: input.onlyUnassigned ? 1 : 0, created_at: at })
          .execute();
      });
    },

    // 提交项目归属: every line assigned and the purpose filled, or refused. The selection pins code + name + source per
    // line, and the projects it used are pinned as this task's project catalog by content hash.
    async submitProjectAssignment(taskId: string, input: ProjectAssignmentInput, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, async ({ tx, facts, loaded, at, revision }) => {
        if (!loaded.assignment || !ASSIGN_STEPS.has(project(facts).step.kind)) return { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady };
        const lines = loaded.view.lines;
        const checked = checkSubmit(lines, input.projects, await bookOptions(tx, accountId, new Date()), loaded.assignment.submitted);
        if ('code' in checked) return checked;
        const used = new Map(Object.values(checked.selection).map((p) => [`${p.source}:${p.number}`, p] as const));
        const catalog = [...used.values()].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
        const catalogHash = await putRuleSet(tx, 'project_catalog', { projects: catalog }, at);
        await tx
          .insertInto('project_submission')
          .values({ submission_id: randomUUID(), task_id: taskId, account_id: accountId, revision, purpose: input.purpose.trim(), selection: JSON.stringify(checked.selection), lines_digest: linesDigest(lines), catalog_hash: catalogHash, created_at: at })
          .execute();
      });
    },

    // ---- 去打印 (#190): only on a confirmed task; none of these touch the confirmation ----
    generatePrintSheet: (taskId: string) => printChange(taskId, (state) => printActions.generate(state)),
    rotatePlacement: (taskId: string, pageId: string, slot: PlacementSlot, rotate: boolean) => printChange(taskId, (state) => printActions.rotate(state, pageId, slot, rotate)),
    cropPlacement: (taskId: string, pageId: string, slot: PlacementSlot, corners: Corners) => printChange(taskId, (state) => printActions.crop(state, pageId, slot, corners)),
    addPaymentScreenshot: (taskId: string, voucherMaterialId: string, file: UploadedFile) => printChange(taskId, (state) => printActions.addScreenshot(state, voucherMaterialId, file)),
    removePaymentScreenshot: (taskId: string, screenshotId: string) => printChange(taskId, (state) => printActions.removeScreenshot(state, screenshotId)),

    // A content-addressed file of this task (an original, a payment screenshot, a composed sheet or page image).
    async file(taskId: string, sha256: string): Promise<{ path: string; mime: string } | null> {
      await taskRow(db, taskId);
      const material = await db.selectFrom('material').select('material_id').where('task_id', '=', taskId).where('blob_sha256', '=', sha256).executeTakeFirst();
      if (!material && !(await printFileShas(db, taskId)).has(sha256)) return null;
      const blob = await db.selectFrom('blob').select('mime').where('sha256', '=', sha256).executeTakeFirst();
      return blob ? { path: blobPath(dataDir, sha256), mime: blob.mime } : null;
    },

    // The personal book changed: its open tasks get a new revision (their allow-list is part of the snapshot, so
    // the old stepToken is void) and push the fresh snapshot.
    async bookChanged(): Promise<void> {
      const open = await db.selectFrom('task').select('task_id').where('account_id', '=', accountId).where('lifecycle', '=', 'open').execute();
      for (const { task_id } of open) {
        try {
          await mutate(task_id, null, async () => undefined, { job: true });
        } catch (error) {
          if (!(error instanceof ActionRefusedError || error instanceof StaleStepError)) throw error;
        }
      }
    },

    // 任务作废 (void task): a lifecycle change, not a deletion. Returns the task list without the task.
    // TODO(#181/#192): refuse once an ERP action attempt exists (ADR-0007 occupancy); none exist before the ERP job.
    async voidTask(taskId: string): Promise<TaskList> {
      const task = await db.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
      if (!task || task.lifecycle === 'voided') throw new ActionRefusedError({ code: 'task_not_found', message: ABANDON_TASK_COPY.notFound }, null, await list());
      if (task.lifecycle !== 'open') throw new ActionRefusedError({ code: 'not_abandonable', message: ACTION_COPY.notAbandonable }, null, await list());
      if (parseRunning((await load(db, task)).facts)) throw new StaleStepError(await snapshot(taskId));
      const at = now();
      await db.updateTable('task').set({ lifecycle: 'voided', revision: task.revision + 1, updated_at: at }).where('task_id', '=', taskId).execute();
      onChange(await snapshot(taskId));
      return list();
    },

    // ---- The parser job's side (parse/jobs.ts) ----

    // The next material of the running inventory run: PDFs first, then images, each in upload order.
    async nextToParse(taskId: string): Promise<ParseWork | null> {
      const task = await taskRow(db, taskId);
      if (task.lifecycle !== 'open') return null;
      const rows = await materialRows(db, taskId);
      const { facts, runId, parsed } = await load(db, task, rows);
      if (!runId || !parseRunning(facts)) return null;
      const todo = rows.filter((row) => !row.excluded && !parsed.has(row.material_id));
      const next = todo.find((row) => mediaTypeOf(row) === 'pdf') ?? todo[0];
      if (!next) return null;
      const input = { materialId: next.material_id, fileName: next.file_name, mediaType: mediaTypeOf(next), bytes: new Uint8Array() };
      try {
        return { runId, input: { ...input, bytes: new Uint8Array(readFileSync(blobPath(dataDir, next.blob_sha256))) }, preset: null };
      } catch {
        return { runId, input, preset: { outcome: 'failed', retryable: false, reason: 'original file missing from the data directory' } };
      }
    },

    // Appends one parser outcome as a fact of the run (bumping the revision and publishing). False when the run moved
    // on or the task closed meanwhile; the job then stops.
    async recordParse(taskId: string, runId: string, materialId: string, outcome: ParseOutcome): Promise<boolean> {
      try {
        await mutate(
          taskId,
          null,
          async ({ tx, facts, at, revision }) => {
            const latest = await tx.selectFrom('inventory_run').select('run_id').where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
            if (latest?.run_id !== runId || !parseRunning(facts)) return STALE_JOB;
            const existing = await tx.selectFrom('parse_result').select('result_id').where('run_id', '=', runId).where('material_id', '=', materialId).executeTakeFirst();
            if (existing) return STALE_JOB;
            const recognised = outcome.outcome === 'recognised' ? outcome : null;
            await tx
              .insertInto('parse_result')
              .values({
                result_id: randomUUID(),
                task_id: taskId,
                account_id: accountId,
                run_id: runId,
                material_id: materialId,
                outcome: outcome.outcome,
                kind: recognised?.kind ?? null,
                layout: recognised?.layout ?? null,
                parser_version: recognised?.parserVersion ?? null,
                detail: JSON.stringify(outcome),
                revision,
                created_at: at,
              })
              .execute();
          },
          { job: true },
        );
        return true;
      } catch (error) {
        if (error instanceof ActionRefusedError) return false;
        throw error;
      }
    },

    // This account's tasks whose current run still waits for outcomes (see `parseBacklogOfAllAccounts`).
    async parseBacklog(): Promise<string[]> {
      const open = await db.selectFrom('task').selectAll().where('account_id', '=', accountId).where('lifecycle', '=', 'open').execute();
      const ids: string[] = [];
      for (const task of open) if (parseRunning((await load(db, task)).facts)) ids.push(task.task_id);
      return ids;
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;

export type ParseBacklogEntry = { accountId: string; taskId: string };

// Every account's tasks whose current run still waits for parser outcomes: a restart resumes all their parser jobs,
// not only the signed-in account's.
export async function parseBacklogOfAllAccounts(db: Db, dataDir: string): Promise<ParseBacklogEntry[]> {
  const owners = await db.selectFrom('task').select('account_id').distinct().where('lifecycle', '=', 'open').execute();
  const entries: ParseBacklogEntry[] = [];
  for (const { account_id: accountId } of owners) {
    for (const taskId of await createTaskService(db, dataDir, accountId).parseBacklog()) entries.push({ accountId, taskId });
  }
  return entries;
}

function listItem(task: TaskTable, { facts, legacy }: Loaded): TaskListItem {
  return {
    taskId: task.task_id,
    name: task.name,
    stage: project(facts).stage,
    period: null,
    grossTotal: null,
    erpDraftNo: legacy?.bill_no ?? null,
    pendingCount: facts.parse?.openPendingItems ?? 0,
    erpOutcome: legacy?.outcome === 'handed_off' ? 'handed_off' : 'none',
    abandonable: task.lifecycle === 'open',
    abandonBlockedReason: task.lifecycle === 'open' ? null : ACTION_COPY.notAbandonable,
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

// The task's 常驻城市: the latest edit, else the snapshot taken at creation.
async function currentHomeCity(tx: Tx, task: TaskTable): Promise<string> {
  const edit = await tx.selectFrom('task_home_city').select('home_city').where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  return edit?.home_city ?? task.home_city;
}

async function assignmentFacts(tx: Tx, taskId: string): Promise<AssignmentFact[]> {
  const assigns = await tx.selectFrom('project_assign').selectAll().where('task_id', '=', taskId).execute();
  const submissions = await tx.selectFrom('project_submission').selectAll().where('task_id', '=', taskId).execute();
  return [
    ...assigns.map((row): AssignmentFact => ({
      kind: 'assign',
      revision: row.revision,
      lineIds: JSON.parse(row.line_ids) as string[],
      project: { number: row.project_number, name: row.project_name, source: row.project_source },
      onlyUnassigned: row.only_unassigned === 1,
    })),
    ...submissions.map((row): AssignmentFact => ({
      kind: 'submit',
      revision: row.revision,
      purpose: row.purpose,
      selection: JSON.parse(row.selection) as Record<string, PinnedProject>,
      linesDigest: row.lines_digest,
      catalogHash: row.catalog_hash,
      submittedAt: row.created_at,
    })),
  ];
}

// Lines with what the pinned rules and the standing submission add: the ERP expense item of the derived category,
// and the pinned project.
function enrichLines(lines: readonly Line[], rules: CompanyRules, assignment: Assignment | null): Line[] {
  return lines.map((line) => {
    const rule = rules.categories[line.category.code];
    const pinned = assignment?.submitted?.selection[line.lineId] ?? null;
    return { ...line, expenseItemCode: rule?.expenseItemCode ?? null, expenseItemName: rule?.expenseItemName ?? null, projectCode: pinned?.number ?? null, projectName: pinned?.name ?? null };
  });
}

function projectSnapshot(task: TaskTable, { facts, view, homeCity, assignment, legacy, lines, digest, confirmed, print }: Loaded, batches: readonly UploadBatchTable[], rejections: readonly UploadRejectionTable[], materials: readonly MaterialRow[]): TaskSnapshot {
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
  return {
    task: { taskId: task.task_id, name: task.name, period: null, homeCity, createdAt: task.created_at, updatedAt: task.updated_at },
    stage,
    batches: batchViews,
    materials: view.materials,
    inventory: { ...view.inventory, versionId: facts.versionNo > 0 ? `v${facts.versionNo}` : null },
    events: view.events,
    pendingItems: view.pendingItems,
    blockers,
    lines,
    confirmation: confirmationView(digest, confirmed, facts.lastReopenRevision, lines) satisfies Confirmation,
    ...printView(task.task_id, task.name, print, sheetState(print, facts.confirmation, confirmed?.revision ?? null)),
    projectAssignment: assignment?.view ?? { status: 'not_started', purpose: null, homeCity, assignments: [], working: [], reselect: [], usage: [], projects: [], submittedAt: null },
    catalog: { status: 'pending', problems: [] },
    // The catalog check moved into the ERP job (ADR-0014); nothing is prepared before the confirmation any more.
    preparation: { status: digest ? 'ready' : 'pending', problems: [], packageFiles: [] },
    // An imported legacy task shows only its stored ERP facts: the saved draft's number, or the 转人工 bucket.
    erp: { status: legacy?.outcome === 'draft_handed_over' ? 'done' : 'idle', steps: [], draftNo: legacy?.bill_no ?? null, abortReason: null, loginNotice: null },
    readback: { status: 'none', rows: [], summary: null, localTotal: null, erpTotal: null },
    reconcile:
      legacy?.outcome === 'handed_off'
        ? { status: 'handed_off', bucket: legacy.reconcile_bucket as ReconcileBucket | null, action: '转人工', actionCode: null, allowedActions: [], humanReview: true, banner: HUMAN_REVIEW_NOTICE, draftNo: legacy.bill_no, rows: [], reasons: [] }
        : { status: 'none', bucket: null, action: null, actionCode: null, allowedActions: [], humanReview: false, banner: null, draftNo: null, rows: [], reasons: [] },
    step,
  };
}
