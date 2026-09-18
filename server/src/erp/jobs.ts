// The server side of the ERP job protocol (ADR-0016): it persists every executor event, makes each
// `attempt_started` durable before acknowledging it, and answers `readback` with the server's own judgement.

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import {
  ExecutorEventSchema, FillPlanSchema,
  type AttemptStartedEvent, type ErpAccount, type ExecutorChannel, type ExecutorEvent, type FillPlan,
  type ReadbackEvent, type ReadbackVerdict, type ResultEvent,
} from './protocol';

type ErpTables = {
  erp_job_event: { event_id: string; job_id: string; task_id: string; seq: number; type: string; payload: string; created_at: string };
  erp_attempt: {
    attempt_id: string; job_id: string; task_id: string; action: string; preconditions: string; expected_postconditions: string;
    erp_build: string; form_id: string; erp_account: string; erp_tenant: string; erp_display_name: string; started_at: string;
  };
};

export type AttemptRecord = {
  attemptId: string; jobId: string; taskId: string; action: AttemptStartedEvent['action'];
  preconditions: AttemptStartedEvent['preconditions']; expectedPostconditions: Record<string, unknown>;
  compatibility: AttemptStartedEvent['compatibility']; erpAccount: ErpAccount; startedAt: string;
};

/** Append one executor event to a job's log, inside whatever transaction `db` is. */
export async function writeEvent(db: Db, jobId: string, taskId: string, event: ExecutorEvent, at: string): Promise<void> {
  const erp = db.withTables<ErpTables>();
  const last = await erp.selectFrom('erp_job_event').select((eb) => eb.fn.max('seq').as('seq')).where('job_id', '=', jobId).executeTakeFirst();
  await erp.insertInto('erp_job_event').values({
    event_id: randomUUID(), job_id: jobId, task_id: taskId, seq: Number(last?.seq ?? 0) + 1,
    type: event.type, payload: JSON.stringify(event), created_at: at,
  }).execute();
}

/** Persist an attempt and its event, inside whatever transaction `db` is. */
export async function writeAttempt(db: Db, jobId: string, taskId: string, event: AttemptStartedEvent, at: string): Promise<void> {
  await db.withTables<ErpTables>().insertInto('erp_attempt').values({
    attempt_id: event.attemptId, job_id: jobId, task_id: taskId, action: event.action,
    preconditions: JSON.stringify(event.preconditions), expected_postconditions: JSON.stringify(event.expectedPostconditions),
    erp_build: event.compatibility.erpBuild, form_id: event.compatibility.formId,
    erp_account: event.erpAccount.account, erp_tenant: event.erpAccount.tenant, erp_display_name: event.erpAccount.displayName,
    started_at: at,
  }).execute();
  await writeEvent(db, jobId, taskId, event, at);
}

export function createErpJobs(db: Db, { now = () => new Date() }: { now?: () => Date } = {}) {
  const erp = db.withTables<ErpTables>();

  return {
    /** Append one executor event to the job's log. */
    async append(jobId: string, taskId: string, event: ExecutorEvent): Promise<void> {
      await db.transaction().execute((trx) => writeEvent(trx, jobId, taskId, event, now().toISOString()));
    },

    /** Persist an attempt (and its event) in one transaction. Only after this resolves may the executor mutate. */
    async recordAttempt(jobId: string, taskId: string, event: AttemptStartedEvent): Promise<void> {
      await db.transaction().execute((trx) => writeAttempt(trx, jobId, taskId, event, now().toISOString()));
    },

    async attempts(jobId: string): Promise<AttemptRecord[]> {
      const rows = await erp.selectFrom('erp_attempt').selectAll().where('job_id', '=', jobId).orderBy('started_at').orderBy('attempt_id').execute();
      return rows.map((row) => ({
        attemptId: row.attempt_id, jobId: row.job_id, taskId: row.task_id, action: row.action as AttemptRecord['action'],
        preconditions: JSON.parse(row.preconditions), expectedPostconditions: JSON.parse(row.expected_postconditions),
        compatibility: { erpBuild: row.erp_build, formId: row.form_id },
        erpAccount: { account: row.erp_account, tenant: row.erp_tenant, displayName: row.erp_display_name },
        startedAt: row.started_at,
      }));
    },

    async events(jobId: string): Promise<ExecutorEvent[]> {
      const rows = await erp.selectFrom('erp_job_event').select(['payload']).where('job_id', '=', jobId).orderBy('seq').execute();
      return rows.map((row) => ExecutorEventSchema.parse(JSON.parse(row.payload)));
    },
  };
}

export type ErpJobs = ReturnType<typeof createErpJobs>;

/** The server's judgement of a raw read-back. The executor never compares; it waits for this verdict. */
export type ErpJudge = (event: ReadbackEvent, context: { erpAccount: ErpAccount | null }) => ReadbackVerdict | Promise<ReadbackVerdict>;

/**
 * The channel the executor emits into. Every event is validated at the boundary and persisted; an
 * `attempt_started` resolves only after its row is durable; a `readback` resolves with the judge's verdict.
 */
export function serverChannel({ jobs, jobId, taskId, judge }: { jobs: ErpJobs; jobId: string; taskId: string; judge: ErpJudge }): ExecutorChannel {
  let erpAccount: ErpAccount | null = null;
  const emit = async (raw: ExecutorEvent) => {
    const event = ExecutorEventSchema.parse(raw);
    switch (event.type) {
      case 'attempt_started':
        erpAccount = event.erpAccount;
        await jobs.recordAttempt(jobId, taskId, event);
        return { persisted: true as const };
      case 'readback': {
        await jobs.append(jobId, taskId, event);
        return judge(event, { erpAccount });
      }
      default:
        await jobs.append(jobId, taskId, event);
        return undefined;
    }
  };
  return { emit: emit as ExecutorChannel['emit'] };
}

export type Executor = (plan: FillPlan, channel: ExecutorChannel) => Promise<ResultEvent>;

/** Drive one fill job through an executor (in-process in v1) and return its result and persisted event log. */
export async function runErpJob({ db, plan: rawPlan, judge, execute }: { db: Db; plan: unknown; judge: ErpJudge; execute: Executor }) {
  const plan = FillPlanSchema.parse(rawPlan);
  const jobs = createErpJobs(db);
  const result = await execute(plan, serverChannel({ jobs, jobId: plan.jobId, taskId: plan.taskId, judge }));
  return { result, events: await jobs.events(plan.jobId), attempts: await jobs.attempts(plan.jobId) };
}
