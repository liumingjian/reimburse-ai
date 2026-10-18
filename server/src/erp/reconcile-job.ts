// The server side of a 对账 (reconcile) job (ADR-0016): run the read-only job through the protocol, persist its
// events like any ERP job, and classify its read-back into one 对账中断点 (reconcile bucket).
// The bucket is derived from the persisted log, not from live state, so it can be re-derived after a restart.

import type { ExecutorChannel, ExecutorEvent, ReadbackEvent, ReconcilePlan, ResultEvent } from '@baox/erp-executor/protocol';
import type { ExecutorOptions } from './fill-jobs';
import { classifyReconciliation, reconcileReadings, reconcileRecord } from './reconcile';

// As a fill's (`ExecutorOptions`): the 凭据 to sign in with, and the server's deadline (`reconcile-jobs.ts`).
export type ReconcileExecutor = (plan: ReconcilePlan, channel: ExecutorChannel, options?: ExecutorOptions) => Promise<ResultEvent>;

/**
 * Classify the last `reconcile` read-back in a job's event log. `expectedPreview` is the approved draft preview of
 * the fill being reconciled (enables the strict per-line match); null when none was approved yet.
 * Returns null when the job produced no read-back (an abort, a failed sign-in).
 */
export function reconcileFromEvents(events: ExecutorEvent[], expectedPreview: unknown = null) {
  const readback = [...events].reverse().find((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'reconcile');
  if (!readback) return null;
  const readings = reconcileReadings(readback.readings, expectedPreview);
  const verdict = classifyReconciliation(readings);
  return { verdict, readings, record: reconcileRecord(verdict, readings) };
}
