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

export function createFillJobs({ db, lease, execute, record }: { db: Db; lease: ErpLease; execute: FillExecutor; record: RecordFacts }) {
  const active = new Set<Promise<void>>();

  async function drive({ jobId, accountId, taskId, trigger, frozen }: FillRun): Promise<void> {
    const at = () => new Date().toISOString();
    const append = (write: (tx: Db) => Promise<void>) => record(accountId, taskId, write);
    let erpAccount: ErpAccount | null = null;
    let finished = false;
    const judge = taskJudge(frozen.judge, {
      onApproved: async (preview) => {
        await db.insertInto('erp_approved_preview').values({ job_id: jobId, task_id: taskId, account_id: accountId, digest: preview.previewDigest ?? '', preview: JSON.stringify(preview), created_at: at() }).execute();
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
        case 'result':
          // Released before the result is visible, so whoever sees the result sees the lease free.
          lease.release(taskId);
          finished = true;
          await append((tx) => writeEvent(tx, jobId, taskId, event, at()));
          return undefined;
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
      lease.release(taskId);
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
