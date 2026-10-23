// Reading `erp_job_event` back (ADR-0014: append-only, so a job recorded before a protocol change keeps its payload).
// #436 (ADR-0037) removed the attended path from the protocol: the `waiting_login` event and the `handed_over` and
// `waiting_login` results. Jobs recorded before it still carry them, and a strict parse of one made the task list fail
// as a whole. Each is read as what it now means; events arriving from an executor stay strictly parsed.

import { ExecutorEventSchema, type ExecutorEvent } from '@baox/erp-executor/protocol';

type Payload = { type?: unknown; status?: unknown };

/** One stored payload as an event of today's protocol, or null for the dropped `waiting_login` notice. */
export function storedEvent(payload: string): ExecutorEvent | null {
  const raw = JSON.parse(payload) as Payload;
  if (raw.type === 'waiting_login') return null;
  if (raw.type === 'result') {
    // `handed_over`: ERP 单据已交接 before ADR-0028, a closed task the employee saved themselves.
    if (raw.status === 'handed_over') return ExecutorEventSchema.parse({ ...raw, status: 'saved' });
    // `waiting_login`: the job stopped at a login nobody completed; nothing was written, as an `aborted` erp_login now.
    if (raw.status === 'waiting_login') return ExecutorEventSchema.parse({ ...raw, status: 'aborted' });
  }
  return ExecutorEventSchema.parse(raw);
}

export const storedEvents = (rows: readonly { payload: string }[]): ExecutorEvent[] =>
  rows.flatMap((row) => storedEvent(row.payload) ?? []);
