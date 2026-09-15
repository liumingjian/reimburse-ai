// The background 对账 (reconcile) job (ADR-0016): one run per `erp_reconcile_job` row. It drives the read-only
// executor, makes each of its events a fact of the task (one revision + SSE each), and acknowledges its read-back
// without judging it live: the bucket is derived from the persisted log (`fill-state.ts`).
//
// The global ERP lease is acquired by the `reconcile` action (`tasks.ts`) and released here on the result.

import type { ErpLease } from '../erp-lease';
import type { RecordFacts } from './fill-jobs';
import { writeEvent } from './jobs';
import { ExecutorEventSchema, type ExecutorChannel, type ExecutorEvent, type ReconcilePlan, type ResultEvent } from './protocol';
import type { ReconcileExecutor } from './reconcile-job';

export type ReconcileRun = { jobId: string; accountId: string; taskId: string; plan: ReconcilePlan };

/** Used when no executor is configured: the reconcile stops at once, nothing was read. */
export const unavailableReconcileExecutor: ReconcileExecutor = async (_plan, channel) => {
  const event: ResultEvent = { type: 'result', status: 'aborted', code: 'erp_executor_unavailable', message: '这个应用没有接上报销系统自动化。', billNo: null, capture: null };
  await channel.emit(event);
  return event;
};

export function createReconcileJobs({ lease, execute, record }: { lease: ErpLease; execute: ReconcileExecutor; record: RecordFacts }) {
  const active = new Set<Promise<void>>();

  async function drive({ jobId, accountId, taskId, plan }: ReconcileRun): Promise<void> {
    const at = () => new Date().toISOString();
    let finished = false;
    const emit = async (raw: ExecutorEvent) => {
      const event = ExecutorEventSchema.parse(raw);
      // A reconcile job never mutates ERP: an attempt from it is a bug, never a fact.
      if (event.type === 'attempt_started') throw new Error('a reconcile job may not start an ERP action attempt');
      if (event.type === 'result') {
        lease.release(taskId);
        finished = true;
      }
      await record(accountId, taskId, (tx) => writeEvent(tx, jobId, taskId, event, at()));
      return event.type === 'readback' ? { ok: true as const } : undefined;
    };
    const channel = { emit: emit as ExecutorChannel['emit'] };
    try {
      await execute(plan, channel);
    } catch (error) {
      if (!finished) {
        const message = error instanceof Error ? error.message : String(error);
        await channel.emit({ type: 'result', status: 'aborted', code: 'executor_error', message, billNo: null, capture: null });
      }
    } finally {
      lease.release(taskId);
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
