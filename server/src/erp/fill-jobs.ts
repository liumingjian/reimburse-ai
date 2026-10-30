// The background 去报销 (fill ERP) job (ADR-0016): one run per `erp_job` row. It drives the executor through the job
// protocol, makes every executor event a fact of the task (appended and published in one revision), acknowledges
// `attempt_started` only once its row is durable, and answers read-backs with the server's judge.
//
// The account's ERP lease is acquired by the action that starts the run (`tasks.ts`) and released here on every result:
// abort, catalog mismatch, error and done.
//
// Every executor signs in with the account's hosted ERP 凭据 (ADR-0033, ADR-0037): the runner reads them for the job
// and hands them to whichever executor runs it, the paired 本地执行器 or the development CDP one.

import { randomUUID } from 'node:crypto';
import { syncProjectNames } from '../books';
import { withProjectNames } from './project-names';
import type { Db } from '../db/database';
import type { ErpLease } from '../erp-lease';
import { realTimer, type Schedule } from '../channel/channel';
import type { MaintenanceLease } from '../maintenance';
import { taskJudge, type FrozenJob } from './fill-plan';
import { writeAttempt, writeEvent } from './jobs';
import { ExecutorEventSchema, type ErpAccount, type ExecutorChannel, type ExecutorEvent, type FillPlan, type ResultEvent } from '@baox/erp-executor/protocol';
import type { ErpCredentials } from '@baox/erp-executor/sign-in';
import { SIGN_IN_REFUSED_CODE } from '@baox/erp-executor/wire';

// What started this run of the fill job, recorded on `erp_job.trigger` so the audit trail can tell them apart:
// `start` is 去报销, `refill` is 重新去报销 (the recovery after an import that was never saved, ADR-0027). `refill` runs exactly like `start` — a fresh plan on a fresh 新增单 — and differs only in
// what it is allowed to start from, which `tasks.ts` decides. `rerun` is the 自动重新去报销 baox starts by itself
// (ADR-0034): a `refill` nobody clicked, whose plan asks ERP first whether the task's bill already landed.
export type FillTrigger = 'start' | 'refill' | 'rerun';

// `credentials`: the account's authorised ERP 凭据, which the executor signs in with; null when it has none (the job
// then ends at its sign-in, before any attempt). `signal` aborts when the server has ended the job (its deadline): the
// executor should stop, and every event it sends after is refused.
export type ExecutorOptions = { signal?: AbortSignal; credentials: ErpCredentials | null };
export type FillExecutor = (plan: FillPlan, channel: ExecutorChannel, options: ExecutorOptions & { trigger: FillTrigger }) => Promise<ResultEvent>;

// What the ERP 凭据 service (`hosted-sign-in.ts`) offers a job: the 凭据 to sign in with, if any, and the news that
// ERP refused them.
export type JobCredentials = {
  forJob(accountId: string): Promise<ErpCredentials | null>;
  refusedInJob(accountId: string, used: ErpCredentials, message: string): Promise<void>;
};
export const NO_CREDENTIALS: JobCredentials = { forJob: async () => null, refusedInJob: async () => undefined };

/**
 * One run of an executor with the account's 凭据. A login ERP refuses in that run deletes them (`hosted-sign-in.ts`),
 * so baox never tries a refused password again. `app.ts` refuses a 去报销 without authorised ones before any job exists
 * (where jobs go to the 本地执行器); should they be refused or cleared before the run, it goes without them.
 */
export async function withCredentials(credentials: JobCredentials, accountId: string, run: (used: ErpCredentials | null) => Promise<ResultEvent>): Promise<ResultEvent> {
  const used = await credentials.forJob(accountId);
  const result = await run(used);
  if (used && result?.code === SIGN_IN_REFUSED_CODE) await credentials.refusedInJob(accountId, used, result.message ?? '').catch(() => undefined);
  return result;
}

export type FillRun = { jobId: string; accountId: string; taskId: string; trigger: FillTrigger; frozen: FrozenJob; maintenance?: MaintenanceLease };

// Appends facts of one task in one accepted revision and publishes the fresh snapshot (the task service's job path).
export type RecordFacts = (accountId: string, taskId: string, write: (tx: Db) => Promise<void>) => Promise<void>;

/**
 * The server's own guard (ADR-0014: any loss after `attempt_started` is reconcile, never a replay): once an attempt
 * of the job is durable, only a terminal success (`drafted`, or the legacy `saved`) or `unknown` may end it. An
 * executor that believes nothing was written (e.g. its acknowledgement failed after the server persisted the attempt)
 * still ends in `unknown`.
 */
export async function afterAttempts(tx: Db, jobId: string, event: ResultEvent): Promise<ResultEvent> {
  if (event.status === 'drafted' || event.status === 'saved' || event.status === 'unknown') return event;
  const attempt = await tx.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', jobId).executeTakeFirst();
  if (!attempt) return event;
  const message = `已开始写入报销系统之后停止，写入结果不确定：${event.message ?? event.code ?? ''}`;
  return { ...event, status: 'unknown', message };
}

/**
 * Every ERP job ends within its deadline, whatever its executor does: a 本地执行器 whose socket stays up while its
 * runner hangs opens no reconnection window, and a page that never settles never answers. Past the deadline the server
 * takes no more of the job's events, lets the ones already being recorded land (an `attempt_started` among them must be
 * on record before the result is judged), records `aborted` through the job's own path — which `afterAttempts` turns
 * into `unknown`, so 对账, once an attempt is durable — and aborts the executor's signal. Generous on purpose: a slow but
 * healthy run must never meet it.
 */
export const FILL_JOB_DEADLINE_MS = 15 * 60_000;
export const RECONCILE_JOB_DEADLINE_MS = 5 * 60_000;
export const JOB_DEADLINE_CODE = 'erp_job_deadline';
export const JOB_DEADLINE_COPY = {
  fill: '这次去报销超过 15 分钟还没有结束，应用把它停下了。',
  reconcile: '这次对账超过 5 分钟还没有结束，应用把它停下了。对账只读，不会改动报销系统，可以再对账一次。',
} as const;
const JOB_CLOSED_MESSAGE = '这次任务已经结束，应用不再接受它的进展。';

/**
 * Runs a job's executor against its deadline. `emit` is the job's own recording path; the executor gets a gated copy
 * that refuses everything once the deadline has passed. Resolves `true` when the deadline ended the job, after its
 * in-flight events have landed and its signal has been aborted; the caller then records the deadline result.
 */
export async function withinDeadline(
  { deadlineMs, schedule }: { deadlineMs: number; schedule: Schedule },
  emit: ExecutorChannel['emit'],
  execute: (channel: ExecutorChannel, signal: AbortSignal) => Promise<unknown>,
): Promise<boolean> {
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  const gated = (async (event: ExecutorEvent) => {
    if (closed) throw new Error(JOB_CLOSED_MESSAGE);
    const reply = (emit as (event: ExecutorEvent) => Promise<unknown>)(event);
    const settled = reply.then(() => undefined, () => undefined);
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
    return reply;
  }) as ExecutorChannel['emit'];
  let cancel = () => {};
  const overdue = new Promise<'overdue'>((resolve) => {
    cancel = schedule(() => resolve('overdue'), deadlineMs);
  });
  try {
    if ((await Promise.race([execute({ emit: gated }, controller.signal), overdue])) !== 'overdue') return false;
    closed = true;
    controller.abort();
    await Promise.allSettled([...inFlight]);
    return true;
  } finally {
    cancel();
  }
}

export const isRefusal = (answer: ResultEvent | null): answer is ResultEvent => answer?.type === 'result' && answer.status === 'aborted';

// The result a job gets when it ended without sending one of its own.
export const NO_RESULT_CODE = 'job_ended_without_result';
const NO_RESULT_COPY = {
  attempted: '已经开始写入报销系统之后，这次去报销没有给出结果（应用出错）。写入结果不确定，应用不会重放任何写入，请对账。',
  // No 「报销系统没有被改动」: that is the task's to say (an earlier run may have written), and the page says it when true.
  fill: '这次去报销没有给出结果就结束了（应用出错）。',
  reconcile: '这次对账没有给出结果就结束了（应用出错）。对账只读，不会改动报销系统，可以再对账一次。',
} as const;

/**
 * Closes a job that produced no `result` event, so its task never stays stuck in phase `running` with every mutation
 * answering 409. Written straight to the database, without a revision or SSE: the recording path is exactly what may
 * have failed. A fill job with a durable attempt ends `unknown` (reconcile, never a replay), one without an attempt
 * and every reconcile job end `aborted` (nothing was written). Idempotent: a job that has its result keeps it.
 */
export async function ensureResult(db: Db, jobId: string, taskId: string, kind: 'fill' | 'reconcile'): Promise<void> {
  const done = await db.selectFrom('erp_job_event').select('event_id').where('job_id', '=', jobId).where('type', '=', 'result').executeTakeFirst();
  if (done) return;
  const attempted = kind === 'fill' && (await db.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', jobId).executeTakeFirst()) !== undefined;
  const event: ResultEvent = {
    type: 'result',
    status: attempted ? 'unknown' : 'aborted',
    code: NO_RESULT_CODE,
    message: attempted ? NO_RESULT_COPY.attempted : NO_RESULT_COPY[kind],
    billNo: null,
    capture: null,
  };
  await writeEvent(db, jobId, taskId, event, new Date().toISOString());
}

// Asked once a run has settled and given back its leases: whether to start an 自动重新去报销 (ADR-0034) is the task
// service's call. `serverEnded`: the server, not the executor, gave the run its result (deadline, a throw, none at all).
export type FillSettled = (run: FillRun, outcome: { serverEnded: boolean }) => Promise<unknown>;

export function createFillJobs({ db, lease, execute, record, schedule = realTimer, deadlineMs = FILL_JOB_DEADLINE_MS, onSettled, credentials = NO_CREDENTIALS }: { db: Db; lease: ErpLease; execute: FillExecutor; record: RecordFacts; schedule?: Schedule; deadlineMs?: number; onSettled?: FillSettled; credentials?: JobCredentials }) {
  const active = new Set<Promise<void>>();

  async function drive({ jobId, accountId, taskId, trigger, frozen, maintenance }: FillRun): Promise<{ serverEnded: boolean }> {
    let serverEnded = false;
    const at = () => new Date().toISOString();
    const append = (write: (tx: Db) => Promise<void>) => record(accountId, taskId, write);
    let erpAccount: ErpAccount | null = null;
    let finished = false;
    const judge = taskJudge(frozen.judge, {
      // Through the task service like every other fact of the job: one revision and one pushed snapshot, rather than
      // a bare insert the page never hears about.
      onApproved: async (preview) => {
        await append(async (tx) => {
          await tx
            .insertInto('erp_approved_preview')
            .values({ job_id: jobId, task_id: taskId, account_id: accountId, digest: preview.previewDigest ?? '', preview: JSON.stringify(preview), created_at: at() })
            .execute();
        });
      },
    });
    const emit = async (raw: ExecutorEvent) => {
      const event = ExecutorEventSchema.parse(raw);
      switch (event.type) {
        case 'catalog_confirmed': {
          const refreshed = withProjectNames(frozen, event.projects);
          await append(async tx => {
            await writeEvent(tx, jobId, taskId, event, at());
            await syncProjectNames(tx, accountId, taskId, event.projects, at());
          });
          Object.assign(frozen.judge, refreshed.judge);
          frozen.plan = refreshed.plan;
          return undefined;
        }
        case 'attempt_started':
          erpAccount = event.erpAccount;
          await append((tx) => writeAttempt(tx, jobId, taskId, event, at()));
          return { persisted: true as const };
        case 'readback':
          await append((tx) => writeEvent(tx, jobId, taskId, event, at()));
          return judge(event, { erpAccount });
        case 'result': {
          // Released before the result is visible, so whoever sees the result sees the lease free.
          lease.release(jobId);
          // Marked finished only once the row is durable: a throw in here must leave it false, so the fallback in
          // `drive`'s `finally` still gives the job a result.
          await append(async (tx) => writeEvent(tx, jobId, taskId, await afterAttempts(tx, jobId, event), at()));
          finished = true;
          return undefined;
        }
        default:
          await append((tx) => writeEvent(tx, jobId, taskId, event, at()));
          return undefined;
      }
    };
    const channel = { emit: emit as ExecutorChannel['emit'] };
    // Typed through `as`: it is set inside the callback, where control flow would not see it.
    let answered = null as ResultEvent | null;
    try {
      const overdue = await withinDeadline({ deadlineMs, schedule }, channel.emit, async (gated, signal) => {
        answered = await withCredentials(credentials, accountId, (used) => execute(frozen.plan, gated, { trigger, signal, credentials: used }));
      });
      if (overdue && !finished) {
        serverEnded = true;
        await channel.emit({ type: 'result', status: 'aborted', code: JOB_DEADLINE_CODE, message: JOB_DEADLINE_COPY.fill, billNo: null, capture: null });
      } else if (!finished && isRefusal(answered)) {
        // Answered, never emitted: the 本地执行器 turns a job away (busy, no 凭据) in its answer alone. A refusal
        // claims nothing about ERP, so it is recorded with its own reason; `afterAttempts` still makes it 写入结果未知
        // once an attempt is durable. A claimed success that was never recorded stays worth nothing (ADR-0014).
        await channel.emit(answered);
      }
    } catch (error) {
      if (!finished) {
        serverEnded = true;
        // The executor itself failed: after an attempt the write result is unknown, before it nothing was written.
        const attempted = (await db.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', jobId).executeTakeFirst()) !== undefined;
        const message = error instanceof Error ? error.message : String(error);
        await channel.emit({ type: 'result', status: attempted ? 'unknown' : 'aborted', code: 'executor_error', message, billNo: null, capture: null });
      }
    } finally {
      lease.release(jobId);
      // A job without a result row stays phase `running` for ever and every mutation of its task gets 409. Whatever
      // went wrong -- the executor returned without a result, or recording one threw -- give it one now. Keep the
      // maintenance lease through this direct fallback write, because it does not use the normal task-service path.
      if (!finished) {
        serverEnded = true;
        await ensureResult(db, jobId, taskId, 'fill').catch((error: unknown) => console.error(`ERP job ${jobId} could not be closed`, error));
      }
      maintenance?.release();
    }
    return { serverEnded };
  }

  return {
    run(job: FillRun): void {
      const running: Promise<void> = drive(job)
        .then((outcome) => onSettled?.(job, outcome))
        .then(() => undefined)
        .catch((error: unknown) => console.error(`ERP job ${job.jobId} failed`, error))
        .finally(() => active.delete(running));
      active.add(running);
    },

    // Waits a moment for running jobs; a real ERP job can take minutes and simply ends with the process.
    async close(): Promise<void> {
      if (active.size === 0) return;
      await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    },
  };
}

export type FillJobs = ReturnType<typeof createFillJobs>;

export const newJobId = (): string => randomUUID();
