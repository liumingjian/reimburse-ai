// The background 对账 (reconcile) job (ADR-0016): one run per `erp_reconcile_job` row. It drives the read-only
// executor, makes each of its events a fact of the task (one revision + SSE each), and acknowledges its read-back
// without judging it live: the bucket is derived from the persisted log (`fill-state.ts`).
//
// The account's ERP lease is acquired by the `reconcile` action (`tasks.ts`) and released here on the result.

import type { Db } from '../db/database';
import type { ErpLease } from '../erp-lease';
import { realTimer, type Schedule } from '../channel/channel';
import type { MaintenanceLease } from '../maintenance';
import { ensureResult, isRefusal, JOB_DEADLINE_CODE, JOB_DEADLINE_COPY, NO_CREDENTIALS, RECONCILE_JOB_DEADLINE_MS, withCredentials, withinDeadline, type JobCredentials, type RecordFacts } from './fill-jobs';
import { writeEvent } from './jobs';
import { ExecutorEventSchema, type ExecutorChannel, type ExecutorEvent, type ReconcilePlan, type ResultEvent } from '@baox/erp-executor/protocol';
import type { ReconcileExecutor } from './reconcile-job';

export type ReconcileRun = { jobId: string; accountId: string; taskId: string; plan: ReconcilePlan; maintenance?: MaintenanceLease };

export function createReconcileJobs({ db, lease, execute, record, schedule = realTimer, deadlineMs = RECONCILE_JOB_DEADLINE_MS, credentials = NO_CREDENTIALS }: { db: Db; lease: ErpLease; execute: ReconcileExecutor; record: RecordFacts; schedule?: Schedule; deadlineMs?: number; credentials?: JobCredentials }) {
  const active = new Set<Promise<void>>();

  async function drive({ jobId, accountId, taskId, plan, maintenance }: ReconcileRun): Promise<void> {
    const at = () => new Date().toISOString();
    let finished = false;
    const emit = async (raw: ExecutorEvent) => {
      const event = ExecutorEventSchema.parse(raw);
      // A reconcile job never mutates ERP: an attempt from it is a bug, never a fact.
      if (event.type === 'attempt_started') throw new Error('a reconcile job may not start an ERP action attempt');
      // Released before the result is visible, so whoever sees the result sees the lease free. `finished` is set only
      // once the row is durable, so a throw while recording still leaves the fallback below a job to close.
      if (event.type === 'result') lease.release(jobId);
      await record(accountId, taskId, (tx) => writeEvent(tx, jobId, taskId, event, at()));
      if (event.type === 'result') finished = true;
      return event.type === 'readback' ? { ok: true as const } : undefined;
    };
    const channel = { emit: emit as ExecutorChannel['emit'] };
    try {
      let answered = null as ResultEvent | null;
      const overdue = await withinDeadline({ deadlineMs, schedule }, channel.emit, async (gated, signal) => {
        answered = await withCredentials(credentials, accountId, (used) => execute(plan, gated, { signal, credentials: used }));
      });
      if (overdue && !finished) await channel.emit({ type: 'result', status: 'aborted', code: JOB_DEADLINE_CODE, message: JOB_DEADLINE_COPY.reconcile, billNo: null, capture: null });
      // A refusal the 本地执行器 answered with alone (busy, no 凭据) keeps its own reason, as for a fill.
      else if (!finished && isRefusal(answered)) await channel.emit(answered);
    } catch (error) {
      if (!finished) {
        const message = error instanceof Error ? error.message : String(error);
        await channel.emit({ type: 'result', status: 'aborted', code: 'executor_error', message, billNo: null, capture: null });
      }
    } finally {
      lease.release(jobId);
      // Never leave the run without a result: the task would stay 对账中 and refuse every mutation until a restart.
      // The maintenance lease covers this fallback direct write as well as the normal channel writes above.
      if (!finished) await ensureResult(db, jobId, taskId, 'reconcile').catch((error: unknown) => console.error(`ERP reconcile job ${jobId} could not be closed`, error));
      maintenance?.release();
    }
  }

  return {
    run(job: ReconcileRun): void {
      const running: Promise<void> = drive(job)
        .catch((error: unknown) => console.error(`ERP reconcile job ${job.jobId} failed`, error))
        .finally(() => active.delete(running));
      active.add(running);
    },
    async close(): Promise<void> {
      if (active.size === 0) return;
      await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    },
  };
}

export type ReconcileJobs = ReturnType<typeof createReconcileJobs>;
