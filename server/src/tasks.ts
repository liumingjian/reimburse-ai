import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ABANDON_TASK_COPY,
  DINING_INVOICE_FIELD,
  DINING_INVOICE_KEY,
  CONFIRM_REVIEW_ERRORS,
  CREATE_TASK_ERRORS,
  ERP_ACTION_ERRORS,
  HOME_CITY_ERRORS,
  PENDING_ANSWER_ERRORS,
  PAYMENT_SCREENSHOT_ERRORS,
  PAYMENT_STAY_FIELD,
  PENDING_CHOICE_KEY,
  STAY_TRIO_COPY,
  PROJECT_ASSIGNMENT_ERRORS,
  fieldAnswer,
  type ActionError,
  type AssignProjectLinesInput,
  type Corners,
  type PlacementSlot,
  type PendingAnswer,
  type ProjectAssignmentInput,
  type TaskList,
  type TaskListItem,
  type TaskSnapshot,
  type UploadRejectCode,
  EXECUTOR_OFFLINE_CODE,
} from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from './db/database';
import type { TaskTable } from './db/schema';
import { blobPath, writeBlob } from './data-dir';
import type { InventoryView } from './inventory-view';
import type { ParseOutcome } from './parse/dispatch';
import type { ParseInput } from './parse/material';
import { mediumOf } from './parse/media';
import { EXCLUDE_CHOICE, judgeAnswer, type Verdict } from './pending/answers';
import { EDIT_COPY, EDIT_PREFIX, editAddress, judgeEdit } from './pending/edits';
import { ACTION_COPY, ERP_IN_USE, NO_RERUN, STALE_JOB, isNonTerminal, parseRunning, stepToken, taskPolicy, type ActionName, type Refusal, type TaskFacts } from './task-policy';
import { loadFacts, materialRows, uploadHistory, type LoadedTask } from './task-facts';
import { projectListItem, projectSnapshot } from './task-snapshot';
import { relativeSourcePath, rejectByShape, rejectReason, sourceFileName, storedMime } from './upload-rules';
import { checkAssign, checkSubmit, linesDigest } from './assignment';
import { bookOptions, createBookService } from './books';
import { COMPANY_RULES, putRuleSet, validHomeCity } from './rules/company-rules';
import { rememberedHomeCity, rememberHomeCity } from './settings';
import type { ErpLease } from './erp-lease';
import type { MaintenanceLease } from './maintenance';
import type { ErpConfig } from './erp/config';
import { buildFillJob, draftMarkOf, planOfJob, type FrozenJob } from './erp/fill-plan';
import { JOB_DEADLINE_CODE, newJobId, NO_RESULT_CODE, type FillRun, type FillTrigger } from './erp/fill-jobs';
import { RECONNECT_EXPIRED_CODE, REOBSERVATION_MISMATCH_CODE } from './erp/remote-executor';
import { EXECUTOR_CONNECTION_LOST_CODE } from './channel/channel';
import { filledRows, INVOICE_NO, markedPurpose, PROTOCOL_VERSION, type ReadbackEvent, type ReconcilePlan } from '@baox/erp-executor/protocol';
import type { ReconcileRun } from './erp/reconcile-jobs';
import { loadErp, type ErpRecord } from './erp/fill-state';
import { failureOf, rerunStopReason } from './erp/rerun-policy';
import { printFileShas } from './print/facts';
import * as printActions from './print/service';
import { PrintRefusal, type PrintCommit, type PrintState } from './print/service';

// Reimbursement task (报销任务) actions that append facts. The facts are read by `task-facts.ts` and projected into
// the contract snapshot by `task-snapshot/`. Every accepted change goes through `mutate`: stepToken check, refusal,
// revision bump, then `onChange` (SSE).

export type UploadedFile = { fileName: string; mime: string; bytes: Uint8Array; relativePath?: string | null };

// An uploaded file as a batch records it: its name and source path as stored, a shape rejection if any, its content
// hash.
type JudgedFile = UploadedFile & { relativePath: string; shape: UploadRejectCode | null; sha256: string };

// Contract times are ISO 8601 to the second.
const now = () => `${new Date().toISOString().slice(0, 19)}Z`;

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

type Tx = Db;
type Context = { tx: Tx; facts: TaskFacts; loaded: LoadedTask; view: InventoryView; at: string; revision: number };

// The task policy admitted the action, so what its admission rests on is loaded: a miss here is a bug, never a refusal
// (the refusals are the policy's, `task-policy.ts`).
function admitted<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`admitted without ${what}`);
  return value;
}

// The next material the parser job should parse. `preset` is an outcome decided without parsing (original missing).
export type ParseWork = { runId: string; input: ParseInput; preset: ParseOutcome | null };

// What the 去报销 actions need from the app: the account's ERP lease, the ERP to write to, and the background job runners
// (the fill job, and the read-only reconcile job of #192). `executorPaired` answers the task policy's fact of that name
// (ADR-0037: no 本地执行器 paired, no 去报销). `executorReady` is asked inside the accepted change, before the lease and
// before any job exists: a refusal means the paired 本地执行器 could not be reached or has no 凭据 to sign in with
// (story 13), so the employee is told which and where to fix it instead of watching a job abort. Both are absent when
// jobs run in an executor of the server's own (development, e2e, tests).
export type ErpServiceOptions = {
  lease: ErpLease; config: ErpConfig; run: (job: FillRun) => void; reconcile: (job: ReconcileRun) => void;
  executorPaired?: (tx: Db, accountId: string) => Promise<boolean>;
  executorReady?: (tx: Db, accountId: string) => Promise<Refusal | null>;
  // Acquired beside the durable job row, before the runner can start. This closes the admission race with a new job.
  acquireErp?: () => MaintenanceLease | null;
  acquireBackground?: () => MaintenanceLease | null;
  // The account's jobs run unattended, with authorised ERP 凭据 (ADR-0033): only then does 自动重新去报销 start (ADR-0034).
  unattended?: (accountId: string) => Promise<boolean>;
};

// 对账 after 暂存 (line 2 item 5): look the draft up by the 暂存 job's marker, make sure none of the task's other jobs
// left one, and compare it with what the strict hand-over read-back saw before 暂存, as the fill compared its own.
async function draftLookupOf(tx: Db, taskId: string, fillJobId: string, mark: string, erp: Pick<ErpRecord, 'events' | 'preview'>): Promise<ReconcilePlan['draft']> {
  const others = await tx.selectFrom('erp_job').select('job_id').where('task_id', '=', taskId).where('kind', '=', 'fill').where('job_id', '!=', fillJobId).orderBy('revision').execute();
  const verified = [...erp.events].reverse().find((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'before_hand_over');
  const expected = verified && erp.preview
    ? { causa: markedPurpose(erp.preview.purpose, mark), receipts: filledRows(verified.readings.receiptsGrid), details: filledRows(verified.readings.detailGrid) }
    : null;
  return { mark, earlier: others.map((row) => draftMarkOf(row.job_id)), expected };
}

// 自动重新去报销 (ADR-0034): at most this many in a row, then the task waits for the employee as before.
export const AUTO_RERUN_LIMIT = 2;
// Results the server, not the executor, gave the job: the run may still hold the page, so nothing starts over on it.
const EXECUTOR_MAY_STILL_RUN = new Set([JOB_DEADLINE_CODE, NO_RESULT_CODE, RECONNECT_EXPIRED_CODE, REOBSERVATION_MISMATCH_CODE, EXECUTOR_OFFLINE_CODE, EXECUTOR_CONNECTION_LOST_CODE]);

export type TaskServiceOptions = { onChange?: (snapshot: TaskSnapshot) => void; erp?: ErpServiceOptions };

async function excludeOnce(tx: Tx, taskId: string, accountId: string, materialId: string, revision: number, at: string): Promise<void> {
  const existing = await tx.selectFrom('material_exclusion').select('exclusion_id').where('material_id', '=', materialId).executeTakeFirst();
  if (!existing) await tx.insertInto('material_exclusion').values({ exclusion_id: randomUUID(), task_id: taskId, account_id: accountId, material_id: materialId, revision, created_at: at }).execute();
}

// Scoped to one account: every read and write sees only that account's tasks (ADR-0018). Another account's task is
// indistinguishable from a missing one.
export function createTaskService(db: Db, dataDir: string, accountId: string, { onChange = () => {}, erp }: TaskServiceOptions = {}) {
  async function taskRow(tx: Tx, taskId: string): Promise<TaskTable> {
    const row = await tx.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
    if (!row) throw new TaskNotFoundError(taskId);
    return row;
  }

  // Who holds this account's ERP lease, as a fact for the task policy (`TaskFacts.erpLease`).
  function leaseOf(taskId: string): 'own' | 'other' | null {
    const holder = erp?.lease.holder(accountId);
    return holder ? (holder.taskId === taskId ? 'own' : 'other') : null;
  }

  async function snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await taskRow(db, taskId);
    const { batches, rejections } = await uploadHistory(db, taskId);
    const materials = await materialRows(db, taskId);
    return projectSnapshot(task, await loadFacts(db, task, materials), batches, rejections, materials);
  }

  // One accepted change: load the task's facts, ask `taskPolicy` whether `action` is admitted (stepToken, closed task,
  // a job running, the ERP freeze, the action's own step), let `apply` refuse or append facts, bump the revision, then
  // publish the fresh snapshot. A refusal or stale token writes nothing. The rules themselves live in task-policy.ts.
  // `request`: the refusal of the request's input that the policy ranks ahead of the action's own precondition.
  // Accepted bytes land on disk (content-addressed) before any row can refer to them.
  function judgeFiles(files: readonly UploadedFile[]): JudgedFile[] {
    const judged = files.map((file) => {
      const fileName = sourceFileName(file.fileName);
      return { ...file, fileName, relativePath: relativeSourcePath(fileName, file.relativePath), shape: rejectByShape(fileName, file.mime, file.bytes.byteLength), sha256: createHash('sha256').update(file.bytes).digest('hex') };
    });
    for (const file of judged) if (file.shape === null) writeBlob(dataDir, file.bytes);
    return judged;
  }

  // The task's contents so far, by sha256: a file already among them is rejected as a duplicate.
  async function knownContent(tx: Db, taskId: string): Promise<Map<string, string>> {
    const known = new Map<string, string>();
    for (const row of await tx.selectFrom('material').select(['blob_sha256', 'file_name', 'source_path']).where('task_id', '=', taskId).orderBy(sql`rowid`).execute()) {
      if (!known.has(row.blob_sha256)) known.set(row.blob_sha256, row.source_path ?? row.file_name);
    }
    return known;
  }

  // Writes one upload batch of judged files: a rejection row for each refused file, a material for each accepted one.
  // The accepted materials' ids, in batch order.
  async function writeBatch(tx: Db, taskId: string, judged: readonly JudgedFile[], at: string): Promise<string[]> {
    const known = await knownContent(tx, taskId);
    const last = await tx.selectFrom('upload_batch').select((eb) => eb.fn.max('no').as('no')).where('task_id', '=', taskId).executeTakeFirst();
    const batchId = randomUUID();
    await tx.insertInto('upload_batch').values({ batch_id: batchId, task_id: taskId, account_id: accountId, no: (last?.no ?? 0) + 1, uploaded_at: at }).execute();
    const accepted: string[] = [];
    for (const [seq, file] of judged.entries()) {
      const duplicateOf = file.shape === null ? known.get(file.sha256) : undefined;
      const code = file.shape ?? (duplicateOf !== undefined ? 'duplicate_content' : null);
      if (code) {
        await tx
          .insertInto('upload_rejection')
          .values({ rejection_id: randomUUID(), task_id: taskId, account_id: accountId, batch_id: batchId, batch_seq: seq, file_name: file.fileName, source_path: file.relativePath, size: file.bytes.byteLength, reason_code: code, reason: rejectReason(code, duplicateOf), created_at: at })
          .execute();
        continue;
      }
      known.set(file.sha256, file.relativePath);
      const mime = storedMime(file.fileName, file.mime);
      // The medium is recognition's to sniff (#312); the material list, print and the parse order read it back.
      await tx.insertInto('blob').values({ sha256: file.sha256, size: file.bytes.byteLength, mime, medium: mediumOf({ fileName: file.fileName, mime, bytes: file.bytes }), created_at: at }).onConflict((oc) => oc.column('sha256').doNothing()).execute();
      const materialId = randomUUID();
      await tx
        .insertInto('material')
        .values({ material_id: materialId, task_id: taskId, account_id: accountId, batch_id: batchId, blob_sha256: file.sha256, file_name: file.fileName, source_path: file.relativePath, created_at: at, batch_seq: seq })
        .execute();
      accepted.push(materialId);
    }
    return accepted;
  }

  async function mutate(taskId: string, token: string | null, action: ActionName, apply: (ctx: Context) => Promise<Refusal | void>, request: Refusal | null = null): Promise<TaskSnapshot> {
    const outcome = await db.transaction().execute(async (tx): Promise<{ kind: 'ok' } | { kind: 'stale' } | ({ kind: 'refused' } & Refusal)> => {
      const task = await taskRow(tx, taskId);
      const loaded = await loadFacts(tx, task);
      const { facts, view } = loaded;
      const executorPaired = erp?.executorPaired ? await erp.executorPaired(tx, accountId) : true;
      const policy = taskPolicy({ ...facts, erpLease: leaseOf(taskId), erpConfigured: !!erp, executorPaired }, loaded.erp);
      const admission = policy.admit(action, token, request);
      if (admission === 'stale') return { kind: 'stale' };
      if (admission !== 'ok') return { kind: 'refused', ...admission };
      const at = now();
      const revision = task.revision + 1;
      const refusal = await apply({ tx, facts, loaded, view, at, revision });
      if (refusal) return { kind: 'refused', ...refusal };
      await tx.updateTable('task').set({ revision, updated_at: at }).where('task_id', '=', taskId).execute();
      return { kind: 'ok' };
    });
    const fresh = await snapshot(taskId);
    if (outcome.kind === 'stale') throw new StaleStepError(fresh);
    if (outcome.kind === 'refused') throw new ActionRefusedError({ code: outcome.code, message: outcome.message, ...(outcome.link ? { link: outcome.link } : {}) }, fresh);
    onChange(fresh);
    return fresh;
  }

  // 去报销 and 重新去报销: both start one run of the fill job. The lease is taken inside the accepted
  // change, so a task never runs without it; the job itself releases it on its result.
  //
  // Where each trigger may be taken from (choose_action; the 对账 verdict offering 重新去报销, ADR-0027)
  // is the task policy's to say, like any other admission: by the time `apply` runs, the trigger was admitted.
  async function startFillJob(taskId: string, token: string, trigger: Exclude<FillTrigger, 'rerun'>): Promise<TaskSnapshot> {
    const recovery = trigger === 'refill';
    const started: { run: FillRun | null } = { run: null };
    try {
      const action = trigger === 'start' ? 'start_erp_write' : trigger;
      const snapshot = await mutate(
        taskId,
        token,
        action,
        async ({ tx, facts, loaded, at, revision }) => {
          const erpService = admitted(erp, 'an ERP configured');
          // The plan is built from the confirmed materials, lines, projects and 事由; 重新去报销 rebuilds it from the
          // same confirmation 去报销 used.
          const confirmed = admitted(loaded.confirmed, 'a confirmation');
          const rows = await materialRows(tx, taskId);
          const kinds = new Map(loaded.view.materials.map((material) => [material.materialId, material.kind]));
          const built = buildFillJob({
            taskId,
            jobId: 'unassigned',
            versionId: `v${facts.versionNo}`,
            homeCity: loaded.homeCity,
            purpose: loaded.assignment?.submitted?.purpose ?? null,
            lines: loaded.lines,
            materials: rows.map((row) => ({ materialId: row.material_id, kind: kinds.get(row.material_id) ?? null, fileName: row.file_name, sha256: row.blob_sha256, mime: row.mime })),
            claims: loaded.view.claims,
            config: erpService.config,
          });
          if (!built.ok) return { code: 'erp_preflight', message: ERP_ACTION_ERRORS.preflight(built.problems) };
          const frozen = built.job;
          const digest = confirmed.digest;
          const unreachable = await erpService.executorReady?.(tx, accountId);
          if (unreachable) return unreachable;
          const jobId = newJobId();
          // The recovery replaces the unsaved bill it was offered over; ERP keeps that bill's tab open, and reusing it
          // would put the re-import on a form that already holds its 收票行 (live 2026-09-21).
          const job: FrozenJob = { ...frozen, plan: { ...planOfJob(frozen.plan, jobId), ...(recovery ? { replaceAbandonedForm: true } : {}) } };
          const maintenance = erpService.acquireErp ? erpService.acquireErp() : { release: () => undefined };
          if (!maintenance) return { code: 'maintenance_in_progress', message: '系统正在维护，暂时不能开始报销系统操作。' };
          // Taken for this job, not for the task: the run that ends gives back only its own lease. The policy saw it
          // free; another job can still take it before this change commits.
          if (!erpService.lease.acquire({ accountId, taskId, jobId })) {
            maintenance.release();
            return ERP_IN_USE;
          }
          started.run = { jobId, accountId, taskId, trigger, frozen: job, maintenance };
          await tx.insertInto('erp_job').values({ job_id: jobId, task_id: taskId, account_id: accountId, kind: 'fill', trigger, confirmation_digest: digest, plan: JSON.stringify(job), revision, started_at: at }).execute();
        },
      );
      if (started.run) erp?.run(started.run);
      return snapshot;
    } catch (error) {
      // The change was not stored after the lease was taken: give back this job's lease (never a later job's).
      if (started.run) {
        erp?.lease.release(started.run.jobId);
        started.run.maintenance?.release();
      }
      throw error;
    }
  }

  // A 去打印 action. Print actions carry no stepToken from the page (contract); the server composes on the revision it
  // read, outside any transaction, and commits through `mutate` with that revision's token: anything accepted in
  // between turns the commit into a 409 stale_step with the fresh snapshot.
  async function printChange(taskId: string, prepare: (state: PrintState) => Promise<PrintCommit | null>): Promise<TaskSnapshot> {
    const task = await taskRow(db, taskId);
    const rows = await materialRows(db, taskId);
    const loaded = await loadFacts(db, task, rows);
    // Asked before composing anything, so a closed task (voided, legacy) is refused without work. A job in flight is
    // left to the commit below, which asks again on whatever revision it lands (a no-op adjustment never commits).
    const admission = taskPolicy(loaded.facts, loaded.erp).admit('print', null);
    if (admission !== 'ok' && admission !== 'stale') throw new ActionRefusedError({ code: admission.code, message: admission.message }, await snapshot(taskId));
    const state: PrintState = {
      taskId,
      accountId,
      dataDir,
      confirmation: loaded.facts.confirmation,
      confirmedRevision: loaded.confirmed?.revision ?? null,
      lines: loaded.lines,
      materials: loaded.view.materials,
      sources: new Map(rows.filter((row) => !row.excluded).map((row) => [row.material_id, { sha256: row.blob_sha256, mediaType: row.medium, fileName: row.file_name }] as const)),
      facts: loaded.print,
      trios: loaded.view.trios,
      erpAttempted: loaded.erp.attempted,
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
    return mutate(taskId, stepToken(task.task_id, task.revision), 'print', async ({ tx, at, revision }) => {
      await run(tx, at, revision);
    });
  }

  async function list(): Promise<TaskList> {
    // 任务作废 (void task) removes the task from the list; its facts stay on disk.
    const tasks = await db.selectFrom('task').selectAll().where('account_id', '=', accountId).where('lifecycle', '!=', 'voided').orderBy('updated_at', 'desc').execute();
    const items: TaskListItem[] = [];
    for (const task of tasks) items.push(projectListItem(task, await loadFacts(db, task)));
    const remembered = await rememberedHomeCity(db, accountId);
    return { homeCity: remembered ? { value: remembered, source: 'remembered' } : null, tasks: items };
  }

  // The one path 任务作废 takes, for the action and for 完全重置 alike. Any lifecycle and any ERP phase can be voided
  // (ADR-0030): a task that touched ERP, one already handed off, one whose 对账 came out 不自洽 — all of them leave the
  // list on request, because a task nobody can retire is a task that blocks the app forever. What voiding does not do
  // is reach into ERP: bills already there stay there, and the employee deals with them by hand.
  //
  // The one refusal left is a job of this very task in flight; the task policy decides it (`void_task`), with the ERP
  // lease as one more fact. Check and void inside one transaction: a concurrent 去报销 writes its `erp_job` row in its
  // own transaction, so whichever commits second sees the other and a task that took the ERP lease in between is
  // refused rather than voided out from under a running browser.
  async function voidOne(taskId: string): Promise<void> {
    const erpLease = leaseOf(taskId);
    const outcome = await db.transaction().execute(async (tx): Promise<'ok' | 'not_found' | 'running'> => {
      const task = await tx.selectFrom('task').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).executeTakeFirst();
      if (!task) return 'not_found';
      const loaded = await loadFacts(tx, task);
      const admission = taskPolicy({ ...loaded.facts, erpLease }, loaded.erp).admit('void_task', null);
      // Refused only when voided already: to the list, that task is gone.
      if (admission === 'stale') return 'running';
      if (admission !== 'ok') return 'not_found';
      await tx.updateTable('task').set({ lifecycle: 'voided', revision: task.revision + 1, updated_at: now() }).where('task_id', '=', taskId).execute();
      return 'ok';
    });
    if (outcome === 'not_found') throw new ActionRefusedError({ code: 'task_not_found', message: ABANDON_TASK_COPY.notFound }, null, await list());
    if (outcome === 'running') throw new StaleStepError(await snapshot(taskId));
    onChange(await snapshot(taskId));
  }

  return {
    snapshot,
    list,

    // 完全重置 (reset) of this account: its personal book is emptied and its remembered home city forgotten (both as
    // appended facts), its browser preference returns to headless, and every task 任务作废 would accept is voided (facts stay, ADR-0015) and leaves the list.
    // Reset is a bulk abandon, so it clears whatever the abandon action clears — since ADR-0030 that is every
    // lifecycle, ERP-touched ones included. Only a task with a job in flight is left exactly as it is.
    async resetAll(): Promise<TaskList> {
      await db.deleteFrom('erp_browser_setting').where('account_id', '=', accountId).execute();
      await createBookService(db, { scope: 'personal', ownerAccountId: accountId }, accountId).clear();
      if ((await rememberedHomeCity(db, accountId)) !== null) await rememberHomeCity(db, accountId, null, 'reset', now());
      const open = await db.selectFrom('task').select('task_id').where('account_id', '=', accountId).where('lifecycle', '!=', 'voided').execute();
      for (const { task_id } of open) {
        try {
          await voidOne(task_id);
        } catch (error) {
          // Kept, with its invoices: the task list still shows it.
          if (!(error instanceof ActionRefusedError || error instanceof StaleStepError)) throw error;
        }
      }
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
        const open = await tx.selectFrom('task').select(['task_id', 'lifecycle']).where('account_id', '=', accountId).where('lifecycle', '=', 'open').execute();
        for (const task of open) if (isNonTerminal(task.lifecycle, (await loadErp(tx, task.task_id)).facts?.phase ?? null)) return false;
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

    // One 上传批次 (upload batch). Each file is accepted or rejected with a reason code. A batch that adds a material
    // forms a new inventory version.
    async upload(taskId: string, files: readonly UploadedFile[]): Promise<TaskSnapshot> {
      const judged = judgeFiles(files);
      return mutate(taskId, null, 'upload', async ({ tx, at }) => {
        await writeBatch(tx, taskId, judged, at);
      });
    },

    async supplementDiningEvidence(taskId: string, pendingItemId: string, files: readonly UploadedFile[], token: string): Promise<TaskSnapshot> {
      const judged = judgeFiles(files);
      return mutate(taskId, token, 'change_dining_evidence', async ({ tx, facts, view, at, revision }) => {
        const item = view.answerables.get(pendingItemId)?.item;
        if (!item || item.status !== 'open' || !item.dining?.supplement) return { code: 'dining_evidence_not_applicable', message: '这个待确认项当前不需要补传餐饮材料。' };
        const accepted = await writeBatch(tx, taskId, judged, at);
        if (accepted.length > 0) await tx.insertInto('inventory_run').values({ run_id: randomUUID(), task_id: taskId, account_id: accountId, version_no: facts.versionNo + 1, revision, started_at: at }).execute();
      });
    },

    // 支付截图 added from a 住宿 invoice's 待确认项 (ADR-0032): a new upload batch whose screenshots are placed with that
    // invoice (stored as the filer's 改归属) and a new inventory run over it, in one change, so the screenshots are
    // read and checked by sum like any other. Admitted where reopening upload is; refused, like any change to a stay's
    // screenshots, once the list is confirmed.
    async addPaymentScreenshots(taskId: string, invoiceId: string, files: readonly UploadedFile[], token: string): Promise<TaskSnapshot> {
      const judged = judgeFiles(files);
      const images = await Promise.all(judged.map((file) => printActions.isScreenshotImage(file)));
      return mutate(taskId, token, 'reopen_upload', async ({ tx, facts, view, at, revision }) => {
        if (!view.trios.some((trio) => trio.invoiceId === invoiceId && trio.screenshot)) return { code: 'screenshot_not_applicable', message: PAYMENT_SCREENSHOT_ERRORS.notApplicable };
        if (facts.confirmation === 'confirmed') return { code: 'screenshot_locked', message: STAY_TRIO_COPY.changeLocked };
        if (images.some((image) => !image)) return { code: 'not_image', message: PAYMENT_SCREENSHOT_ERRORS.notImage };
        const known = await knownContent(tx, taskId);
        if (judged.every((file) => file.shape !== null || known.has(file.sha256))) return { code: 'duplicate_content', message: PAYMENT_SCREENSHOT_ERRORS.alreadyUploaded };
        for (const materialId of await writeBatch(tx, taskId, judged, at)) {
          const answer: PendingAnswer = { value: invoiceId };
          await tx
            .insertInto('pending_answer')
            .values({ answer_id: randomUUID(), task_id: taskId, account_id: accountId, item_id: editAddress(materialId, PAYMENT_STAY_FIELD), material_id: materialId, answer: JSON.stringify(answer), revision, created_at: at })
            .execute();
        }
        await tx.insertInto('inventory_run').values({ run_id: randomUUID(), task_id: taskId, account_id: accountId, version_no: facts.versionNo + 1, revision, started_at: at }).execute();
      });
    },

    // Explicit start of 材料盘点 on the current version (ADR-0014: inventory never starts by itself). The run's
    // materials then wait for the background parser job (`parse/jobs.ts`).
    async startInventory(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, 'start_inventory', async ({ tx, facts, at, revision }) => {
        await tx.insertInto('inventory_run').values({ run_id: randomUUID(), task_id: taskId, account_id: accountId, version_no: facts.versionNo, revision, started_at: at }).execute();
      });
    },

    // Back to upload after inventory. Uploading or re-starting inventory then forms the next result.
    // After a confirmation this voids it for good (`confirmationStatus`); refused once ERP was touched.
    async reopenUpload(taskId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, 'reopen_upload', async ({ tx, at, revision }) => {
        await tx.insertInto('upload_reopen').values({ reopen_id: randomUUID(), task_id: taskId, account_id: accountId, revision, reopened_at: at }).execute();
      });
    },

    // 整单明细确认: stores `{digest, confirmedAt}` for exactly the digest the user saw; any other digest is refused.
    async confirmReview(taskId: string, digest: string, token: string, acceptDeadlineWarnings = false): Promise<TaskSnapshot> {
      return mutate(taskId, token, 'confirm_review', async ({ tx, loaded, at, revision }) => {
        if (!loaded.digest) return { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady };
        if (loaded.lines.length === 0) return { code: 'no_lines', message: CONFIRM_REVIEW_ERRORS.noLines };
        if (digest !== loaded.digest.digest) return { code: 'digest_mismatch', message: CONFIRM_REVIEW_ERRORS.digestMismatch };
        const standing = loaded.assignment?.submitted;
        if (!standing) return { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady };
        const checked = checkSubmit(
          loaded.lines,
          Object.fromEntries(Object.entries(standing.selection).map(([lineId, selected]) => [lineId, selected.number])),
          await bookOptions(tx, accountId, new Date()),
          standing,
        );
        if ('code' in checked) return checked;
        if (checked.deadlineWarnings.length > 0 && !acceptDeadlineWarnings) {
          return { code: 'deadline_confirmation_required', message: CONFIRM_REVIEW_ERRORS.deadlineConfirmationRequired };
        }
        const { digest: current, detail, project: projectDigest } = loaded.digest;
        await tx
          .insertInto('review_confirmation')
          .values({ confirmation_id: randomUUID(), task_id: taskId, account_id: accountId, digest: current, detail_digest: detail, project_digest: projectDigest, revision, confirmed_at: at })
          .execute();
      });
    },

    // 人工纠正 (manual correction) inside the current version: excluding forms no new version.
    async excludeMaterial(taskId: string, materialId: string, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, 'exclude_material', async ({ tx, view, at, revision }) => {
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
      return mutate(taskId, token, 'answer_pending', async ({ tx, facts, loaded, view, at, revision }) => {
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
        const selectedInvoiceId = fieldAnswer(verdict.answer)[DINING_INVOICE_KEY];
        if (selectedInvoiceId || itemId === editAddress(materialId, DINING_INVOICE_FIELD)) {
          const admission = taskPolicy(facts, loaded.erp).admit('change_dining_evidence', token);
          if (admission === 'stale') throw new StaleStepError(await snapshot(taskId));
          if (admission !== 'ok') return admission;
        }
        const { [DINING_INVOICE_KEY]: _selection, ...fields } = fieldAnswer(verdict.answer);
        const storedAnswer = DINING_INVOICE_KEY in fieldAnswer(verdict.answer) ? fields : verdict.answer;
        if (selectedInvoiceId) await tx.insertInto('pending_answer').values({ answer_id: randomUUID(), task_id: taskId, account_id: accountId, item_id: editAddress(materialId, DINING_INVOICE_FIELD), material_id: materialId, answer: JSON.stringify({ value: selectedInvoiceId }), revision, created_at: at }).execute();
        await tx
          .insertInto('pending_answer')
          .values({ answer_id: randomUUID(), task_id: taskId, account_id: accountId, item_id: itemId, material_id: materialId, answer: JSON.stringify(storedAnswer), revision, created_at: at })
          .execute();
        if (!edit && fieldAnswer(verdict.answer)[PENDING_CHOICE_KEY] === EXCLUDE_CHOICE) await excludeOnce(tx, taskId, accountId, materialId, revision, at);
      });
    },

    // 修改常驻城市: the task's snapshot changes (categories re-derive, so a confirmation digest over the lines is
    // invalidated) and becomes the account's default for new tasks. Refused once an ERP action attempt exists.
    async setHomeCity(taskId: string, requested: string, token: string): Promise<TaskSnapshot> {
      const homeCity = validHomeCity(requested);
      // An invalid city is named before a locked one (the policy ranks this refusal ahead of `home_city_locked`).
      const invalid = homeCity ? null : { code: 'invalid_home_city', message: HOME_CITY_ERRORS.invalid };
      return mutate(taskId, token, 'set_home_city', async ({ tx, at, revision }) => {
        const city = admitted(homeCity, 'a valid home city');
        await tx.insertInto('task_home_city').values({ change_id: randomUUID(), task_id: taskId, account_id: accountId, home_city: city, revision, created_at: at }).execute();
        await rememberHomeCity(tx, accountId, city, 'task_edit', at);
      }, invalid);
    },

    // 归入: edits the working draft only; new lines may only go to a currently selectable project.
    async assignProjectLines(taskId: string, input: AssignProjectLinesInput, token: string): Promise<TaskSnapshot> {
      return mutate(taskId, token, 'assign_project_lines', async ({ tx, loaded, at, revision }) => {
        if (!loaded.assignment) return { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady };
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
      return mutate(taskId, token, 'submit_project_assignment', async ({ tx, loaded, at, revision }) => {
        if (!loaded.assignment) return { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady };
        const lines = loaded.view.lines;
        const checked = checkSubmit(lines, input.projects, await bookOptions(tx, accountId, new Date()), loaded.assignment.submitted);
        if ('code' in checked) return checked;
        if (checked.deadlineWarnings.length > 0 && !input.acceptDeadlineWarnings) {
          return { code: 'deadline_confirmation_required', message: PROJECT_ASSIGNMENT_ERRORS.deadlineConfirmationRequired };
        }
        const used = new Map(Object.values(checked.selection).map((p) => [`${p.source}:${p.number}`, p] as const));
        const catalog = [...used.values()].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
        const catalogHash = await putRuleSet(tx, 'project_catalog', { projects: catalog }, at);
        await tx
          .insertInto('project_submission')
          .values({ submission_id: randomUUID(), task_id: taskId, account_id: accountId, revision, purpose: input.purpose.trim(), selection: JSON.stringify(checked.selection), lines_digest: linesDigest(lines), catalog_hash: catalogHash, created_at: at })
          .execute();
      });
    },

    // 去报销: starts the fill job on the confirmed lines (stage erp). Refused before any job when a line could never be
    // written (`erp_preflight`); 409 `erp_in_use` while another task of the same 应用账号 holds the ERP lease.
    startErpWrite(taskId: string, token: string): Promise<TaskSnapshot> {
      return startFillJob(taskId, token, 'start');
    },

    // 重新去报销 (ADR-0027): the exit out of 未保存·已导入未写明细 while the ERP shows no 单据编号. A new fill job on the
    // same 报销任务, on a fresh 新增单 — never the old page instance (V-45) — which takes the account's ERP lease and
    // opens its own attempts. The 对账 job row keeps pointing at the fill job it read, and the new job row carries
    // trigger `refill`, so the audit trail tells the recovery from the original 去报销 without reading row order.
    refill(taskId: string, token: string): Promise<TaskSnapshot> {
      return startFillJob(taskId, token, 'refill');
    },

    // 自动重新去报销 (ADR-0034), asked by the fill job runner when a job settles. It starts a fresh run of the same
    // frozen plan on a fresh 新增单 when, and only when, the ended job is still the task's latest, its write result is
    // unknown, its last attempt was the import or the fill (never 暂存), the executor itself said so, the job went to a
    // 本地执行器, and fewer than AUTO_RERUN_LIMIT re-runs came before it in a row. The new plan asks ERP first whether
    // the bill already landed (`rerun`); the executor stops before uploading if it did. Anything else: nothing, and
    // the task stays in 对账 as before. Never throws.
    async autoRerun(taskId: string, endedJobId: string, { serverEnded }: { serverEnded: boolean }): Promise<boolean> {
      const erpService = erp;
      if (!erpService?.unattended || serverEnded || !(await erpService.unattended(accountId))) return false;
      const started: { run: FillRun | null } = { run: null };
      try {
        await mutate(taskId, null, 'auto_rerun', async ({ tx, loaded, at, revision }) => {
          const ended = loaded.erp.job;
          if (!ended || ended.job_id !== endedJobId || ended.kind !== 'fill') return NO_RERUN;
          const code = loaded.erp.result?.code ?? null;
          if (code !== null && EXECUTOR_MAY_STILL_RUN.has(code)) return NO_RERUN;
          if (rerunStopReason(loaded.erp.result, loaded.erp.frozen?.rerunOf?.failure)) return NO_RERUN;
          const last = await tx.selectFrom('erp_attempt').select('action').where('job_id', '=', endedJobId).orderBy(sql`rowid`, 'desc').executeTakeFirst();
          if (last?.action !== 'import' && last?.action !== 'fill') return NO_RERUN;
          const jobs = await tx.selectFrom('erp_job').select(['job_id', 'trigger']).where('task_id', '=', taskId).orderBy('revision', 'desc').execute();
          const inRow = jobs.findIndex((job) => job.trigger !== 'rerun');
          const before = inRow === -1 ? jobs.length : inRow;
          if (before >= AUTO_RERUN_LIMIT) return NO_RERUN;
          const frozen = loaded.erp.frozen ?? JSON.parse(ended.plan) as FrozenJob;
          const failure = failureOf(loaded.erp.result);
          const invoiceNos = [...new Set(frozen.judge.invoices.flatMap((invoice) => (invoice.identity?.number ? [invoice.identity.number] : [])))];
          // Without a number to ask about, ERP cannot be asked, and the re-run's precondition cannot be met.
          if (!invoiceNos.length || invoiceNos.length !== frozen.judge.invoices.length || !invoiceNos.every((no) => INVOICE_NO.test(no))) return NO_RERUN;
          const unreachable = await erpService.executorReady?.(tx, accountId);
          if (unreachable) return unreachable;
          const jobId = newJobId();
          const job: FrozenJob = {
            plan: { ...planOfJob(frozen.plan, jobId), replaceAbandonedForm: true, rerun: { invoiceNos, marks: jobs.map((row) => draftMarkOf(row.job_id)) } },
            judge: frozen.judge,
            rerunOf: { jobId: endedJobId, code, no: before + 1, ...(failure ? { failure } : {}) },
          };
          const maintenance = erpService.acquireErp ? erpService.acquireErp() : { release: () => undefined };
          if (!maintenance) return { code: 'maintenance_in_progress', message: '系统正在维护。' };
          if (!erpService.lease.acquire({ accountId, taskId, jobId })) {
            maintenance.release();
            return ERP_IN_USE;
          }
          started.run = { jobId, accountId, taskId, trigger: 'rerun', frozen: job, maintenance };
          await tx.insertInto('erp_job').values({ job_id: jobId, task_id: taskId, account_id: accountId, kind: 'fill', trigger: 'rerun', confirmation_digest: ended.confirmation_digest, plan: JSON.stringify(job), revision, started_at: at }).execute();
        });
      } catch (error) {
        if (started.run) {
          erpService.lease.release(started.run.jobId);
          started.run.maintenance?.release();
        }
        if (!(error instanceof ActionRefusedError || error instanceof StaleStepError)) console.error(`自动重新去报销 of task ${taskId} failed`, error);
        return false;
      }
      if (!started.run) return false;
      erpService.run(started.run);
      return true;
    },

    // 开始对账 / 重新对账: one run of the read-only reconcile job on the fill whose write result is unknown. Takes the
    // ERP lease inside the accepted change (the job releases it on its result); refused when the current verdict
    // allows only 转人工. Never touches the fill job: nothing is replayed.
    async reconcile(taskId: string, token: string): Promise<TaskSnapshot> {
      const started: { run: ReconcileRun | null } = { run: null };
      try {
        const snapshot = await mutate(
          taskId,
          token,
          'reconcile',
          async ({ tx, loaded, at, revision }) => {
            const erpService = admitted(erp, 'an ERP configured');
            // Admitted only while the write result is unknown, so the fill job it reads is there.
            const fill = admitted(loaded.erp.job, 'the fill job');
            const jobId = newJobId();
            const maintenance = erpService.acquireBackground ? erpService.acquireBackground() : { release: () => undefined };
            if (!maintenance) return { code: 'maintenance_in_progress', message: '系统正在维护，暂时不能开始对账。' };
            if (!erpService.lease.acquire({ accountId, taskId, jobId })) {
              maintenance.release();
              return ERP_IN_USE;
            }
            const draft = loaded.erp.draftMark === null ? undefined : await draftLookupOf(tx, taskId, fill.job_id, loaded.erp.draftMark, loaded.erp);
            started.run = { jobId, accountId, taskId, plan: { protocolVersion: PROTOCOL_VERSION, kind: 'reconcile', jobId, taskId, erpOrigin: loaded.erp.frozen?.plan.erpOrigin ?? erpService.config.origin, ...(draft ? { draft } : {}) }, maintenance };
            await tx.insertInto('erp_reconcile_job').values({ job_id: jobId, fill_job_id: fill.job_id, task_id: taskId, account_id: accountId, revision, started_at: at }).execute();
          },
        );
        if (started.run) erp?.reconcile(started.run);
        return snapshot;
      } catch (error) {
        if (started.run) {
          erp?.lease.release(started.run.jobId);
          started.run.maintenance?.release();
        }
        throw error;
      }
    },

    // 转人工 (hand off to a human): terminal from any reconcile state. The task's lifecycle becomes `handed_off`
    // (stage reconcile, read-only, still holding its invoices); the bucket it was made on is recorded; the lease goes.
    async handOff(taskId: string, token: string): Promise<TaskSnapshot> {
      const snapshot = await mutate(
        taskId,
        token,
        'hand_off',
        async ({ tx, loaded, at, revision }) => {
          // The bucket the hand-off was made on: the latest 对账 verdict, none before the first read.
          const bucket = loaded.erp.reconcile?.judged?.verdict.bucket ?? null;
          await tx.insertInto('erp_hand_off').values({ hand_off_id: randomUUID(), task_id: taskId, account_id: accountId, fill_job_id: loaded.erp.job?.job_id ?? null, bucket, revision, created_at: at }).execute();
          await tx.updateTable('task').set({ lifecycle: 'handed_off' }).where('task_id', '=', taskId).execute();
        },
      );
      // Terminal for the task: whichever job of it still holds the lease gives it up.
      erp?.lease.releaseTask(taskId);
      return snapshot;
    },

    // The cropped screenshot of ERP's error when the write stopped (#32), or null.
    async erpCapture(taskId: string): Promise<Uint8Array | null> {
      const task = await taskRow(db, taskId);
      const screenshot = (await loadErp(db, task.task_id)).result?.capture?.screenshot;
      return screenshot ? new Uint8Array(Buffer.from(screenshot, 'base64')) : null;
    },

    // The ERP job's side (`erp/fill-jobs.ts`): appends its facts in one accepted revision and publishes. A task closed
    // under a running job (reset) still gets the facts, without a revision.
    async erpRecord(taskId: string, write: (tx: Db) => Promise<void>): Promise<void> {
      try {
        await mutate(taskId, null, 'job', async ({ tx }) => write(tx));
      } catch (error) {
        if (!(error instanceof ActionRefusedError)) throw error;
        // The task closed under a running job, so there is no revision to bump. The facts still have to land, and
        // `writeEvent` picks its `seq` as max + 1: without a transaction two of these could choose the same one.
        await db.transaction().execute((tx) => write(tx));
      }
    },

    // ---- 去打印 (#190): only on a confirmed task; none of these touch the confirmation ----
    generatePrintSheet: (taskId: string) => printChange(taskId, (state) => printActions.generate(state)),
    rotatePlacement: (taskId: string, pageId: string, slot: PlacementSlot, rotate: boolean) => printChange(taskId, (state) => printActions.rotate(state, pageId, slot, rotate)),
    cropPlacement: (taskId: string, pageId: string, slot: PlacementSlot, corners: Corners) => printChange(taskId, (state) => printActions.crop(state, pageId, slot, corners)),
    removePaymentScreenshot: (taskId: string, screenshotId: string) => printChange(taskId, (state) => printActions.removeScreenshot(state, screenshotId)),
    completePaymentScreenshots: (taskId: string, voucherMaterialId: string) => printChange(taskId, (state) => printActions.completeScreenshots(state, voucherMaterialId)),

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
          await mutate(task_id, null, 'job', async () => undefined);
        } catch (error) {
          if (!(error instanceof ActionRefusedError || error instanceof StaleStepError)) throw error;
        }
      }
    },

    // 任务作废 (void task): a lifecycle change, not a deletion. Returns the task list without the task.
    // Any lifecycle and any ERP phase (ADR-0030); refused only while a job of this task is in flight (`voidOne`).
    async voidTask(taskId: string): Promise<TaskList> {
      await voidOne(taskId);
      return list();
    },

    // ---- The parser job's side (parse/jobs.ts) ----

    // The next material of the running inventory run: PDFs first, then images, each in upload order.
    async nextToParse(taskId: string): Promise<ParseWork | null> {
      const task = await taskRow(db, taskId);
      const rows = await materialRows(db, taskId);
      const { facts, runId, parsed, erp: record } = await loadFacts(db, task, rows);
      // Work exactly while the parser job's own write would be admitted (an open task, its run still parsing).
      if (!runId || taskPolicy(facts, record).admit('record_parse', null) !== 'ok') return null;
      const todo = rows.filter((row) => !row.excluded && !parsed.has(row.material_id));
      const next = todo.find((row) => row.medium === 'pdf') ?? todo[0];
      if (!next) return null;
      const input = { materialId: next.material_id, fileName: next.file_name, mime: next.mime, bytes: new Uint8Array() };
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
          'record_parse',
          async ({ tx, at, revision }) => {
            const latest = await tx.selectFrom('inventory_run').select('run_id').where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
            if (latest?.run_id !== runId) return STALE_JOB;
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
      for (const task of open) if (parseRunning((await loadFacts(db, task)).facts)) ids.push(task.task_id);
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
