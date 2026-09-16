// The background 去报销 (fill ERP) job (ADR-0016): one run per `erp_job` row. It drives the executor through the job
// protocol, makes every executor event a fact of the task (appended and published in one revision), acknowledges
// `attempt_started` only once its row is durable, and answers read-backs with the server's judge.
//
// The global ERP lease is acquired by the action that starts the run (`tasks.ts`) and released here on every result:
// login wait, abort, catalog mismatch, error and done.

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import type { ErpLease } from '../erp-lease';
import { taskJudge, type FrozenJob } from './fill-plan';
import { writeAttempt, writeEvent } from './jobs';
import { ExecutorEventSchema, type ErpAccount, type ExecutorChannel, type ExecutorEvent, type FillPlan, type ResultEvent } from './protocol';

export type FillTrigger = 'start' | 'confirm_login';

// `confirm_login` is the user's 我已登录，继续: the executor probes the login once and never polls for it.
export type FillExecutor = (plan: FillPlan, channel: ExecutorChannel, options: { trigger: FillTrigger }) => Promise<ResultEvent>;

export type FillRun = { jobId: string; accountId: string; taskId: string; trigger: FillTrigger; frozen: FrozenJob };

// Appends facts of one task in one accepted revision and publishes the fresh snapshot (the task service's job path).
export type RecordFacts = (accountId: string, taskId: string, write: (tx: Db) => Promise<void>) => Promise<void>;

/** Used when no executor is configured: every job stops before touching anything. */
export const unavailableExecutor: FillExecutor = async (_plan, channel) => {
  const event: ResultEvent = { type: 'result', status: 'aborted', code: 'erp_executor_unavailable', message: '这个应用没有接上报销系统自动化。', billNo: null, capture: null };
  await channel.emit(event);
  return event;
};

/**
 * The server's own guard (ADR-0014: any loss after `attempt_started` is reconcile, never a replay): once an attempt
 * of the job is durable, only `saved` or `unknown` may end it. An executor that believes nothing was written (e.g.
 * its acknowledgement failed after the server persisted the attempt) still ends in `unknown`.
 */
export async function afterAttempts(tx: Db, jobId: string, event: ResultEvent): Promise<ResultEvent> {
  if (event.status === 'saved' || event.status === 'unknown') return event;
  const attempt = await tx.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', jobId).executeTakeFirst();
  if (!attempt) return event;
  const message = `已开始写入报销系统之后停止，写入结果不确定：${event.message ?? event.code ?? ''}`;
  return { ...event, status: 'unknown', message };
}

// The result a job gets when it ended without sending one of its own.
const NO_RESULT_CODE = 'job_ended_without_result';
const NO_RESULT_COPY = {
  attempted: '已经开始写入报销系统之后，这次去报销没有给出结果（应用出错）。写入结果不确定，应用不会重放任何写入，请对账。',
  fill: '这次去报销没有给出结果就结束了（应用出错）。报销系统没有被改动，可以再去报销。',
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

export function createFillJobs({ db, lease, execute, record }: { db: Db; lease: ErpLease; execute: FillExecutor; record: RecordFacts }) {
  const active = new Set<Promise<void>>();

  async function drive({ jobId, accountId, taskId, trigger, frozen }: FillRun): Promise<void> {
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
    try {
      await execute(frozen.plan, channel, { trigger });
    } catch (error) {
      if (!finished) {
        // The executor itself failed: after an attempt the write result is unknown, before it nothing was written.
        const attempted = (await db.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', jobId).executeTakeFirst()) !== undefined;
        const message = error instanceof Error ? error.message : String(error);
        await channel.emit({ type: 'result', status: attempted ? 'unknown' : 'aborted', code: 'executor_error', message, billNo: null, capture: null });
      }
    } finally {
      lease.release(jobId);
      // A job without a result row stays phase `running` for ever and every mutation of its task gets 409. Whatever
      // went wrong -- the executor returned without a result, or recording one threw -- give it one now.
      if (!finished) await ensureResult(db, jobId, taskId, 'fill').catch((error: unknown) => console.error(`ERP job ${jobId} could not be closed`, error));
    }
  }

  return {
    run(job: FillRun): void {
      const running: Promise<void> = drive(job)
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
