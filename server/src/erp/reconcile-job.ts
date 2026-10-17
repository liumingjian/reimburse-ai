// The server side of a 对账 (reconcile) job (ADR-0016): run the read-only job through the protocol, persist its
// events like any ERP job, and classify its read-back into one 对账中断点 (reconcile bucket).
// The bucket is derived from the persisted log, not from live state, so it can be re-derived after a restart.

import type { ExecutorChannel, ExecutorEvent, ReadbackEvent, ReconcilePlan, ResultEvent } from '@baox/erp-executor/protocol';
import { classifyReconciliation, reconcileReadings, reconcileRecord } from './reconcile';

// `signal` aborts when the server has ended the job (its deadline, `reconcile-jobs.ts`).
export type ReconcileExecutor = (plan: ReconcilePlan, channel: ExecutorChannel, options?: { signal?: AbortSignal }) => Promise<ResultEvent>;

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
