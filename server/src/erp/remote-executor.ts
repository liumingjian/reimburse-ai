// The executor in the 应用账号's (app account's) paired 本地执行器 (local executor), driven over its channel
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
// - Routing. The job runs in the 本地执行器 of the account that owns the task, and only that account's socket may
//   speak for it. Another account's job reads exactly like no job at all.
// - Order. A job's events are handed to its channel one at a time, in the order they arrived.
// - Originals. While a fill runs, its 本地执行器 may fetch the invoices its plan names, and nothing else
//   (`runningOriginal`, served by the blob route in `app.ts`).
// - Interruption (ADR-0020). A lost socket and a lost page (`erp.detached`) are one event: the job is *interrupted*,
//   takes no events, and keeps its lease. Within `RECONNECT_WINDOW_MS` the 本地执行器 may resume it by `jobId` with
//   what it re-observed; the server judges that page against the one the job left (`reobservationProblems`) and
//   either lets the job carry on or ends it. Past the window the server ends it. Either end is `aborted`, and the
//   server's own guard (`afterAttempts`) turns it into `unknown` — 对账, never a replay — when an attempt is durable.
//   Nothing is re-sent in either direction: the plan is never asked for again, and the resumed 本地执行器 is told how
//   many of its events are on record so it sends none of them twice.
// - ERP 凭据 (ADR-0033, ADR-0037). Every job carries the account's authorised 凭据 next to the plan (never in it: the
//   plan is stored), as the job runner hands them to every executor (`fill-jobs.ts`).

import { readErpBrowserSettings } from './browser-settings';
import type { Db } from '../db/database';
import { EXECUTOR_OFFLINE_CODE } from '@baox/contract';
import { EXECUTOR_CONNECTION_LOST_CODE, ChannelError, realTimer, type ChannelRequestHandler, type ExecutorHub, type Schedule } from '../channel/channel';
import type { ExecutorOptions, FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { ErpCredentials } from '@baox/erp-executor/sign-in';
import { abortedResult, type ExecutorChannel, type ExecutorEvent, type Preconditions, type ResultEvent } from '@baox/erp-executor/protocol';
import {
  EXECUTOR_METHODS, JOB_REFUSALS, JobEventRequestSchema, JobRefSchema, RECONNECT_WINDOW_MS, ResumeRequestSchema, resultOf,
  type FillRequest, type PageObservation, type ReconcileRequest, type ResumeRequest, type ResumeVerdict,
} from '@baox/erp-executor/wire';

// Past the window, whether it was the socket or the page that went: one event, one outcome.
export const RECONNECT_EXPIRED_CODE = 'executor_reconnect_expired';
const RECONNECT_EXPIRED_MESSAGE = '本地执行器和报销系统页面之间的连接中断了，两分钟内没有恢复。';
// Back within the window, but the page is not the one the job left.
export const REOBSERVATION_MISMATCH_CODE = 'reobservation_mismatch';

export type RemoteExecutor = {
  fill: FillExecutor;
  reconcile: ReconcileExecutor;
  // The channel's `onRequest`: the 本地执行器's `erp.event`, `erp.detached` and `erp.resume` requests.
  answer: ChannelRequestHandler;
  // The channel's `onLost`: that account's socket went, so its job is interrupted.
  lost: (accountId: string) => void;
  // The task whose running fill, in this account's 本地执行器, names this invoice original; null for anything else.
  runningOriginal: (accountId: string, sha256: string) => { taskId: string } | null;
};

// `live` takes events. `interrupted` takes only `erp.resume`, until the window closes. `resuming` is a resume being
// judged: the window is already closed and nothing else is taken; an interruption heard meanwhile is held until the
// verdict (`lostWhileResuming`). `ended` takes nothing.
type JobState = 'live' | 'interrupted' | 'resuming' | 'ended';

type Running = {
  accountId: string;
  taskId: string;
  // The originals the plan names (a fill's invoices; none for 对账): all its 本地执行器 may fetch.
  originals: ReadonlySet<string>;
  channel: ExecutorChannel;
  state: JobState;
  // The last event handed to the channel, so the next one waits for it.
  tail: Promise<unknown>;
  // Closes the reconnection window early; set only while interrupted.
  cancelWindow: (() => void) | null;
  // The socket went (or the page was lost) while a resume was being judged. The verdict then reaches nobody, and
  // the 本地执行器's retry would find a live job and give up, leaving it running for ever: so the job is interrupted
  // again the moment it would have gone live, and the window opens anew.
  lostWhileResuming: boolean;
  // Settle `run`: the job is over on this side.
  finish: (result: ResultEvent) => void;
  fail: (error: unknown) => void;
};

const emitAny = (channel: ExecutorChannel, event: ExecutorEvent): Promise<unknown> => (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);

const sameAccount = (a: PageObservation['erpAccount'], b: PageObservation['erpAccount']) => a?.account === b?.account && a?.tenant === b?.tenant;
const sameForm = (a: PageObservation['form'], b: PageObservation['form']) =>
  a === b || (a !== null && b !== null && a.targetId === b.targetId && a.formInstanceId === b.formInstanceId && a.formMode === b.formMode && a.billNo === b.billNo);

type AttemptOnRecord = { preconditions: Preconditions; account: string; tenant: string };

/**
 * ADR-0020's re-observation, judged here because the server owns judgement: the page after the interruption must be
 * the page before it — the same 费用报销单, the same ERP identity, the 发票助手 in the same recognisable state — and,
 * once an attempt is on record, the form and identity that attempt was made on. Any problem at all ends the job.
 *
 * Before any attempt, `last` is the 本地执行器's own word, and that is deliberate. The server cannot observe a page,
 * and before an attempt nothing has been written, so a wrong `last` can only let a job continue — whose next write is
 * still guarded by the attempt-time precondition check. Once an attempt exists, the page is also held against what
 * the server recorded with it, which the 本地执行器 cannot rewrite.
 */
function reobservationProblems({ last, now }: Pick<ResumeRequest, 'last' | 'now'>, attempt: AttemptOnRecord | null): string[] {
  const problems: string[] = [];
  if (!sameForm(last.form, now.form)) problems.push('打开的报销单和中断前不是同一张，或者它的状态变了');
  if (!sameAccount(last.erpAccount, now.erpAccount)) problems.push('报销系统里登录的账号和中断前不一样');
  if (now.assistant === 'unrecognised') problems.push('认不出发票助手现在的状态');
  else if (last.assistant !== now.assistant) problems.push('发票助手的状态和中断前不一样');
  if (attempt) {
    if (now.form?.formInstanceId !== attempt.preconditions.formInstanceId || now.form?.targetId !== attempt.preconditions.targetId) problems.push('打开的报销单不是这次写入的那一张');
    if (now.erpAccount?.account !== attempt.account || now.erpAccount?.tenant !== attempt.tenant) problems.push('报销系统里登录的账号不是这次写入时的那一个');
  }
  return problems;
}

/**
 * What goes to the 本地执行器 (ADR-0037): the plan (every fill plan carries its `draft`, `fill-plan.ts`) and the
 * account's 凭据 the job runner read for it. Without them the job ends at its sign-in.
 */
function payloadFor(payload: FillRequest | ReconcileRequest, credentials: ErpCredentials | null) {
  return credentials ? { ...payload, credentials } : payload;
}

export function createRemoteExecutor({ db, channel: hub, schedule = realTimer }: { db: Db; channel: Pick<ExecutorHub, 'request'>; schedule?: Schedule }): RemoteExecutor {
  const running = new Map<string, Running>();

  // Ends the job on the server's say-so, after any event already in flight has landed, so the result is judged with
  // it on record (an `attempt_started` being made durable, say).
  async function conclude(job: Running, code: string, message: string): Promise<void> {
    job.state = 'ended';
    try {
      await job.tail;
      const event = abortedResult(code, message);
      await job.channel.emit(event);
      job.finish(event);
    } catch (error) {
      job.fail(error);
    }
  }

  // A lost socket or a lost page: the same event, whichever reported it first.
  function interrupt(job: Running): void {
    if (job.state === 'resuming') {
      job.lostWhileResuming = true;
      return;
    }
    if (job.state !== 'live') return;
    job.state = 'interrupted';
    job.cancelWindow = schedule(() => {
      job.cancelWindow = null;
      if (job.state === 'interrupted') void conclude(job, RECONNECT_EXPIRED_CODE, RECONNECT_EXPIRED_MESSAGE);
    }, RECONNECT_WINDOW_MS);
  }

  async function run(plan: { jobId: string; taskId: string; invoices?: Array<{ sha256: string }> }, channel: ExecutorChannel, method: string, payload: FillRequest | ReconcileRequest, { signal, credentials }: ExecutorOptions): Promise<ResultEvent> {
    const { account_id: accountId } = await db.selectFrom('task').select('account_id').where('task_id', '=', plan.taskId).executeTakeFirstOrThrow();
    const { browserMode } = await readErpBrowserSettings(db, accountId);
    const originals = new Set((plan.invoices ?? []).map((invoice) => invoice.sha256));
    let job!: Running;
    const outcome = new Promise<ResultEvent>((finish, fail) => {
      job = { accountId, taskId: plan.taskId, originals, channel, state: 'live', tail: Promise.resolve(), cancelWindow: null, lostWhileResuming: false, finish, fail };
    });
    running.set(plan.jobId, job);
    // The server ended the job (its deadline): it is over on this side, whatever state it was in. Its window closes, and
    // anything the 本地执行器 still sends for it reads like no job at all.
    signal?.addEventListener('abort', () => {
      if (job.state === 'ended') return;
      job.state = 'ended';
      job.fail(new Error('这次任务已经被应用结束了。'));
    }, { once: true });
    hub.request(accountId, method, { ...payloadFor(payload, credentials), browserMode }).then(
      // The executor's own answer counts only while the job is live: an interrupted job's late answer describes a page
      // nobody watched.
      (answer) => {
        if (job.state !== 'live') return;
        try {
          job.finish(resultOf(answer));
        } catch (error) {
          job.fail(error);
        }
      },
      (error: unknown) => {
        // Nothing was listening, so nothing ran: there is nothing to resume.
        if (error instanceof ChannelError && error.code === EXECUTOR_OFFLINE_CODE) return void conclude(job, error.code, error.message);
        if (error instanceof ChannelError && error.code === EXECUTOR_CONNECTION_LOST_CODE) return interrupt(job);
        if (job.state === 'live') job.fail(error);
      },
    );
    try {
      return await outcome;
    } finally {
      job.state = 'ended';
      job.cancelWindow?.();
      running.delete(plan.jobId);
    }
  }

  // The job an account's 本地执行器 names, or the refusal that reads the same for every job it may not speak for.
  function ownJob(accountId: string, jobId: string): Running {
    const job = running.get(jobId);
    if (!job || job.state === 'ended' || job.accountId !== accountId) throw new ChannelError(JOB_REFUSALS.unknownJob, '这次任务不在这个本地执行器里运行。');
    return job;
  }

  async function resume(accountId: string, request: ResumeRequest): Promise<ResumeVerdict> {
    const job = ownJob(accountId, request.jobId);
    if (job.state !== 'interrupted') throw new ChannelError(JOB_REFUSALS.notInterrupted, '这次任务没有中断，不需要恢复。');
    // Back inside the window: it closes now, whatever the judgement says.
    job.cancelWindow?.();
    job.cancelWindow = null;
    job.state = 'resuming';
    job.lostWhileResuming = false;
    try {
      await job.tail;
      const attempt = await db
        .selectFrom('erp_attempt').select(['preconditions', 'erp_account', 'erp_tenant'])
        .where('job_id', '=', request.jobId).orderBy('started_at', 'desc').orderBy('attempt_id', 'desc').executeTakeFirst();
      const problems = reobservationProblems(request, attempt ? { preconditions: JSON.parse(attempt.preconditions) as Preconditions, account: attempt.erp_account, tenant: attempt.erp_tenant } : null);
      if (problems.length > 0) {
        await conclude(job, REOBSERVATION_MISMATCH_CODE, `本地执行器重新连上之后，页面已经不是中断前的样子：${problems.join('；')}。`);
        return { ok: false, reasons: problems };
      }
      const { recorded } = await db.selectFrom('erp_job_event').select((eb) => eb.fn.countAll<number>().as('recorded')).where('job_id', '=', request.jobId).executeTakeFirstOrThrow();
      // Ended while being judged (the server's deadline): there is no job left to carry on.
      if (job.state !== 'resuming') throw new ChannelError(JOB_REFUSALS.unknownJob, '这次任务不在这个本地执行器里运行。');
      job.state = 'live';
      if (job.lostWhileResuming) interrupt(job);
      return { ok: true, recorded: Number(recorded) };
    } catch (error) {
      job.state = 'ended';
      job.fail(error);
      throw error;
    }
  }

  return {
    fill: (plan, channel, { trigger, ...options }) => run(plan, channel, EXECUTOR_METHODS.fill, { plan, trigger }, options),
    reconcile: (plan, channel, options) => run(plan, channel, EXECUTOR_METHODS.reconcile, { plan }, options ?? { credentials: null }),
    async answer(accountId, method, payload) {
      switch (method) {
        case EXECUTOR_METHODS.event: {
          const parsed = JobEventRequestSchema.safeParse(payload);
          if (!parsed.success) throw new ChannelError('bad_event', '本地执行器发来的任务进展看不懂。');
          const { jobId, event } = parsed.data;
          const job = ownJob(accountId, jobId);
          if (job.state !== 'live') throw new ChannelError(JOB_REFUSALS.resumeRequired, '这次任务中断过，要先重新确认页面才能继续。');
          const reply = job.tail.then(() => emitAny(job.channel, event));
          job.tail = reply.catch(() => undefined);
          // The result on record ends the job. After a resume it is the only way the end arrives: the `erp.fill` that
          // asked for it went with the old socket.
          if (event.type === 'result') {
            job.state = 'ended';
            void reply.then(() => job.finish(event), (error: unknown) => job.fail(error));
          }
          return reply;
        }
        case EXECUTOR_METHODS.detached: {
          const parsed = JobRefSchema.safeParse(payload);
          if (!parsed.success) throw new ChannelError('bad_request', '本地执行器发来的请求看不懂。');
          interrupt(ownJob(accountId, parsed.data.jobId));
          return null;
        }
        case EXECUTOR_METHODS.resume: {
          const parsed = ResumeRequestSchema.safeParse(payload);
          if (!parsed.success) throw new ChannelError('bad_request', '本地执行器发来的请求看不懂。');
          return resume(accountId, parsed.data);
        }
        default:
          throw new ChannelError('unknown_method', `没有处理 ${method} 的办法。`);
      }
    },
    lost(accountId) {
      for (const job of running.values()) if (job.accountId === accountId) interrupt(job);
    },
    runningOriginal(accountId, sha256) {
      // A job serves its originals to its own account until it has ended. An interrupted job has not ended: it may
      // still need its invoices when it resumes.
      for (const job of running.values()) {
        if (job.state !== 'ended' && job.accountId === accountId && job.originals.has(sha256)) return { taskId: job.taskId };
      }
      return null;
    },
  };
}
