// The executor in the 应用账号's (app account's) paired 浏览器扩展 (browser extension), driven over its channel
// (ADR-0016, ADR-0019, ADR-0020). It is a `FillExecutor` and a `ReconcileExecutor` like the in-process CDP one, so the
// job runners, the judge and every job test are unaware of where the executor runs.
//
// The protocol mapping lives in `@baox/erp-executor/wire`: the plan goes down as one `erp.fill` / `erp.reconcile`
// request, and each executor event comes back as an `erp.event` request that this module hands to the job's own
// `ExecutorChannel` and answers with that channel's reply. So the disciplines are the job runner's, untouched:
// `attempt_started` is answered only once its row is durable, a read-back only with the server's verdict.
//
// What this module adds is what the network adds:
//
// - Routing. The job runs in the extension of the account that owns the task, and only that account's socket may
//   speak for it. Another account's job reads exactly like no job at all.
// - Order. A job's events are handed to its channel one at a time, in the order they arrived.
// - Loss. When the channel goes, the job ends with the channel's own error code as a `result` (see `channelLost`),
//   after any event already in flight has landed. Nothing is re-sent: nothing is ever replayed.

import type { Db } from '../db/database';
import { EXTENSION_CONNECTION_LOST_CODE, EXTENSION_OFFLINE_CODE, ExtensionChannelError, type ChannelRequestHandler, type ExtensionChannel } from '../extension/channel';
import type { FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { ExecutorChannel, ExecutorEvent, ResultEvent } from '@baox/erp-executor/protocol';
import { EXECUTOR_METHODS, JobEventRequestSchema, resultOf, type FillRequest, type ReconcileRequest } from '@baox/erp-executor/wire';

// The two ways the channel fails a job: nothing was listening when it started, or the socket went while it ran.
const CHANNEL_LOSSES: ReadonlySet<string> = new Set([EXTENSION_OFFLINE_CODE, EXTENSION_CONNECTION_LOST_CODE]);

export type RemoteExecutor = {
  fill: FillExecutor;
  reconcile: ReconcileExecutor;
  // The channel's `onRequest`: the extension's `erp.event` requests.
  answer: ChannelRequestHandler;
};

type Running = {
  accountId: string;
  channel: ExecutorChannel;
  // False once the job has ended on this side; a late event is refused rather than recorded after the result.
  open: boolean;
  // The last event handed to the channel, so the next one waits for it.
  tail: Promise<unknown>;
};

/**
 * The typed outcome of a channel that failed under a job (`CHANNEL_LOSSES`): the job ends `aborted` with the channel's
 * code, and the server's own guard (`afterAttempts`) turns that into `unknown` — 对账, never a replay — when an attempt
 * is durable. #257's reconnection window hooks in here, before this ends the job.
 */
async function channelLost(channel: ExecutorChannel, error: ExtensionChannelError): Promise<ResultEvent> {
  const event: ResultEvent = { type: 'result', status: 'aborted', code: error.code, message: error.message, billNo: null, capture: null };
  await channel.emit(event);
  return event;
}

const emitAny = (channel: ExecutorChannel, event: ExecutorEvent): Promise<unknown> => (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);

export function createRemoteExecutor({ db, extension }: { db: Db; extension: Pick<ExtensionChannel, 'request'> }): RemoteExecutor {
  const running = new Map<string, Running>();

  async function run(plan: { jobId: string; taskId: string }, channel: ExecutorChannel, method: string, payload: FillRequest | ReconcileRequest): Promise<ResultEvent> {
    const { account_id: accountId } = await db.selectFrom('task').select('account_id').where('task_id', '=', plan.taskId).executeTakeFirstOrThrow();
    const job: Running = { accountId, channel, open: true, tail: Promise.resolve() };
    running.set(plan.jobId, job);
    try {
      return resultOf(await extension.request(accountId, method, payload));
    } catch (error) {
      if (!(error instanceof ExtensionChannelError && CHANNEL_LOSSES.has(error.code))) throw error;
      // Closed first, so no new event slips in; then the one already in flight (an `attempt_started` being made
      // durable, say) lands before the result, and the result is judged with it on record.
      job.open = false;
      await job.tail;
      return await channelLost(channel, error);
    } finally {
      job.open = false;
      running.delete(plan.jobId);
    }
  }

  return {
    fill: (plan, channel, { trigger }) => run(plan, channel, EXECUTOR_METHODS.fill, { plan, trigger }),
    reconcile: (plan, channel) => run(plan, channel, EXECUTOR_METHODS.reconcile, { plan }),
    async answer(accountId, method, payload) {
      if (method !== EXECUTOR_METHODS.event) throw new ExtensionChannelError('unknown_method', `没有处理 ${method} 的办法。`);
      const parsed = JobEventRequestSchema.safeParse(payload);
      if (!parsed.success) throw new ExtensionChannelError('bad_event', '浏览器扩展发来的任务进展看不懂。');
      const { jobId, event } = parsed.data;
      const job = running.get(jobId);
      if (!job || !job.open || job.accountId !== accountId) throw new ExtensionChannelError('unknown_job', '这次任务不在这个浏览器扩展里运行。');
      const reply = job.tail.then(() => emitAny(job.channel, event));
      job.tail = reply.catch(() => undefined);
      return reply;
    },
  };
}
