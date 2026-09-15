// Crash recovery of ERP jobs (ADR-0014/0016). A job lives only as long as its process: after a restart, a fill job or
// a reconcile job with no `result` event would stay running forever and every mutation of its task would get 409.
// At startup each gets the result its facts allow, appended like any executor event (one revision + SSE):
//   - a fill job with a durable attempt: `unknown` (ERP 写入结果未知) -> reconcile. Nothing is ever replayed.
//   - a fill job without an attempt: `aborted`, nothing was written, the task may start 去报销 again.
//   - a reconcile job: `aborted`, it only reads, so it may simply be run again.

import type { Db } from '../db/database';
import type { RecordFacts } from './fill-jobs';
import { writeEvent } from './jobs';
import type { ResultEvent } from './protocol';

export const RESTART_CODE = 'server_restart';
const AFTER_ATTEMPT = '应用在写入报销系统的过程中停止了（重启或崩溃），写入结果不确定。应用不会重放任何写入，请对账。';
const BEFORE_ATTEMPT = '应用在写入报销系统之前停止了（重启或崩溃）。';
const RECONCILE = '应用在对账过程中停止了（重启或崩溃），这次对账没有结论。';

const result = (status: ResultEvent['status'], message: string): ResultEvent => ({ type: 'result', status, code: RESTART_CODE, message, billNo: null, capture: null });

async function unfinished(db: Db, table: 'erp_job' | 'erp_reconcile_job') {
  return db
    .selectFrom(table)
    .select(['job_id', 'task_id', 'account_id'])
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('erp_job_event').select('erp_job_event.event_id').whereRef('erp_job_event.job_id', '=', `${table}.job_id`).where('erp_job_event.type', '=', 'result'))))
    .execute();
}

export async function recoverErpJobs(db: Db, record: RecordFacts): Promise<number> {
  const at = new Date().toISOString();
  let recovered = 0;
  for (const job of await unfinished(db, 'erp_job')) {
    const attempted = (await db.selectFrom('erp_attempt').select('attempt_id').where('job_id', '=', job.job_id).executeTakeFirst()) !== undefined;
    const event = attempted ? result('unknown', AFTER_ATTEMPT) : result('aborted', BEFORE_ATTEMPT);
    await record(job.account_id, job.task_id, (tx) => writeEvent(tx, job.job_id, job.task_id, event, at));
    recovered += 1;
  }
  for (const job of await unfinished(db, 'erp_reconcile_job')) {
    await record(job.account_id, job.task_id, (tx) => writeEvent(tx, job.job_id, job.task_id, result('aborted', RECONCILE), at));
    recovered += 1;
  }
  return recovered;
}
