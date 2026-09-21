// The server side of a 对账 (reconcile) job (ADR-0016): run the read-only job through the protocol, persist its
// events like any ERP job, and classify its read-back into one 对账中断点 (reconcile bucket).
// The bucket is derived from the persisted log, not from live state, so it can be re-derived after a restart.

import type { Db } from '../db/database';
import { createErpJobs, serverChannel, type ErpJudge } from './jobs';
import { ReconcilePlanSchema, type ExecutorChannel, type ExecutorEvent, type ReadbackEvent, type ReconcilePlan, type ResultEvent } from '@baox/erp-executor/protocol';
import { classifyReconciliation, reconcileReadings, reconcileRecord } from './reconcile';

export type ReconcileExecutor = (plan: ReconcilePlan, channel: ExecutorChannel) => Promise<ResultEvent>;

/** A reconcile read-back is acknowledged, never judged live: the executor has nothing to act on. */
export const acknowledgeReadings: ErpJudge = () => ({ ok: true });

/**
 * Classify the last `reconcile` read-back in a job's event log. `expectedPreview` is the approved draft preview of
 * the fill being reconciled (enables the strict per-line match); null when none was approved yet.
 * Returns null when the job produced no read-back (login wait, abort).
 */
export function reconcileFromEvents(events: ExecutorEvent[], expectedPreview: unknown = null) {
  const readback = [...events].reverse().find((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'reconcile');
  if (!readback) return null;
  const readings = reconcileReadings(readback.readings, expectedPreview);
  const verdict = classifyReconciliation(readings);
  return { verdict, readings, record: reconcileRecord(verdict, readings) };
}

/** Drive one reconcile job through an executor (in-process in v1) and classify its read-back. */
export async function runReconcile({ db, plan: rawPlan, expectedPreview = null, execute }: {
  db: Db; plan: unknown; expectedPreview?: unknown; execute: ReconcileExecutor;
}) {
  const plan = ReconcilePlanSchema.parse(rawPlan);
  const jobs = createErpJobs(db);
  const result = await execute(plan, serverChannel({ jobs, jobId: plan.jobId, taskId: plan.taskId, judge: acknowledgeReadings }));
  const events = await jobs.events(plan.jobId);
  return { result, events, attempts: await jobs.attempts(plan.jobId), reconcile: reconcileFromEvents(events, expectedPreview) };
}
