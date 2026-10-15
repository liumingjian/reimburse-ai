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
// - Originals. While a fill runs, its extension may fetch the invoices its plan names, and nothing else
//   (`runningOriginal`, served by the blob route in `app.ts`).
// - Interruption (ADR-0020). A lost socket and a `chrome.debugger` detach are one event: the job is *interrupted*,
//   takes no events, and keeps its lease. Within `RECONNECT_WINDOW_MS` the extension may resume it by `jobId` with
//   what it re-observed; the server judges that page against the one the job left (`reobservationProblems`) and
//   either lets the job carry on or ends it. Past the window the server ends it. Either end is `aborted`, and the
//   server's own guard (`afterAttempts`) turns it into `unknown` — 对账, never a replay — when an attempt is durable.
//   Nothing is re-sent in either direction: the plan is never asked for again, and the resumed extension is told how
//   many of its events are on record so it sends none of them twice.
// - ERP 凭据 (ADR-0033). A job bound for a baox 本地执行器 carries the account's authorised 凭据 next to the plan (never
//   in it: the plan is stored). A login ERP refuses in that job deletes them (`hosted-sign-in.ts`). Its fill plan also
//   carries `draft` (ADR-0029): the 本地执行器 ends unattended, so it 暂存s the bill under baox's ownership marker, which
//   is derived from the job id and lands on record with the `save` attempt before 暂存 is pressed.

import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { EXTENSION_CONNECTION_LOST_CODE, EXTENSION_OFFLINE_CODE, ExtensionChannelError, realTimer, type ChannelRequestHandler, type ExtensionChannel, type Schedule } from '../extension/channel';
import type { FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { ErpCredentials } from '@baox/erp-executor/sign-in';
import { abortedResult, type ExecutorChannel, type ExecutorEvent, type Preconditions, type ResultEvent } from '@baox/erp-executor/protocol';
import {
  EXECUTOR_METHODS, JOB_REFUSALS, JobEventRequestSchema, JobRefSchema, RECONNECT_WINDOW_MS, ResumeRequestSchema, resultOf, SIGN_IN_REFUSED_CODE,
  type FillRequest, type PageObservation, type ReconcileRequest, type ResumeRequest, type ResumeVerdict,
} from '@baox/erp-executor/wire';

// Past the window, whether it was the socket or the debugger that went: one event, one outcome.
export const RECONNECT_EXPIRED_CODE = 'extension_reconnect_expired';
const RECONNECT_EXPIRED_MESSAGE = '浏览器扩展和报销系统页面之间的连接中断了，两分钟内没有恢复。';
// Back within the window, but the page is not the one the job left.
export const REOBSERVATION_MISMATCH_CODE = 'reobservation_mismatch';

export type RemoteExecutor = {
  fill: FillExecutor;
  reconcile: ReconcileExecutor;
  // The channel's `onRequest`: the extension's `erp.event`, `erp.detached` and `erp.resume` requests.
  answer: ChannelRequestHandler;
  // The channel's `onLost`: that account's socket went, so its job is interrupted.
  lost: (accountId: string) => void;
  // The task whose running fill, in this account's extension, names this invoice original; null for anything else.
  runningOriginal: (accountId: string, sha256: string) => { taskId: string } | null;
};

// `live` takes events. `interrupted` takes only `erp.resume`, until the window closes. `resuming` is a resume being
// judged: the window is already closed and nothing else is taken; an interruption heard meanwhile is held until the
// verdict (`lostWhileResuming`). `ended` takes nothing.
type JobState = 'live' | 'interrupted' | 'resuming' | 'ended';

type Running = {
  accountId: string;
  taskId: string;
  // The originals the plan names (a fill's invoices; none for 对账): all its extension may fetch.
  originals: ReadonlySet<string>;
  channel: ExecutorChannel;
  state: JobState;
  // The last event handed to the channel, so the next one waits for it.
  tail: Promise<unknown>;
  // Closes the reconnection window early; set only while interrupted.
  cancelWindow: (() => void) | null;
  // The socket went (or the debugger detached) while a resume was being judged. The verdict then reaches nobody, and
  // the extension's retry would find a live job and give up, leaving it running for ever: so the job is interrupted
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
 * Before any attempt, `last` is the extension's own word, and that is deliberate. The server cannot observe a page,
 * and before an attempt nothing has been written, so a wrong `last` can only let a job continue — whose next write is
 * still guarded by the attempt-time precondition check. Once an attempt exists, the page is also held against what
 * the server recorded with it, which the extension cannot rewrite.
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

// What the ERP 凭据 service (`hosted-sign-in.ts`) offers a job: the 凭据 to send, if any, and the news that ERP refused them.
export type JobCredentials = {
  forJob(accountId: string): Promise<ErpCredentials | null>;
  refusedInJob(accountId: string, used: ErpCredentials, message: string): Promise<void>;
};
/** baox's ownership marker for a job (ADR-0029): one per job, the same on every send, unguessable as its job id is. */
export const draftMarkOf = (jobId: string) => `baox-${createHash('sha256').update(`baox-draft:${jobId}`).digest('hex').slice(0, 10)}`;

/** What goes to the executor: a job bound for a 本地执行器 (it is sent 凭据) also 暂存s its bill under the job's marker. */
function payloadFor(method: string, payload: FillRequest | ReconcileRequest, credentials: ErpCredentials | null) {
  if (!credentials) return payload;
  if (method !== EXECUTOR_METHODS.fill) return { ...payload, credentials };
  const fill = payload as FillRequest;
  return { ...fill, plan: { ...fill.plan, draft: { mark: draftMarkOf(fill.plan.jobId) } }, credentials };
}

const NO_CREDENTIALS: JobCredentials = { forJob: async () => null, refusedInJob: async () => undefined };

export function createRemoteExecutor({ db, extension, schedule = realTimer, credentials: hosted = NO_CREDENTIALS }: { db: Db; extension: Pick<ExtensionChannel, 'request'>; schedule?: Schedule; credentials?: JobCredentials }): RemoteExecutor {
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

  // A lost socket or a detached debugger: the same event, whichever reported it first.
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

  async function run(plan: { jobId: string; taskId: string; invoices?: Array<{ sha256: string }> }, channel: ExecutorChannel, method: string, payload: FillRequest | ReconcileRequest, signal?: AbortSignal): Promise<ResultEvent> {
    const { account_id: accountId } = await db.selectFrom('task').select('account_id').where('task_id', '=', plan.taskId).executeTakeFirstOrThrow();
    const originals = new Set((plan.invoices ?? []).map((invoice) => invoice.sha256));
    const credentials = await hosted.forJob(accountId);
    let job!: Running;
    const outcome = new Promise<ResultEvent>((finish, fail) => {
      job = { accountId, taskId: plan.taskId, originals, channel, state: 'live', tail: Promise.resolve(), cancelWindow: null, lostWhileResuming: false, finish, fail };
    });
    running.set(plan.jobId, job);
    // The server ended the job (its deadline): it is over on this side, whatever state it was in. Its window closes, and
    // anything the extension still sends for it reads like no job at all.
    signal?.addEventListener('abort', () => {
      if (job.state === 'ended') return;
      job.state = 'ended';
      job.fail(new Error('这次任务已经被应用结束了。'));
    }, { once: true });
    extension.request(accountId, method, payloadFor(method, payload, credentials)).then(
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
        if (error instanceof ExtensionChannelError && error.code === EXTENSION_OFFLINE_CODE) return void conclude(job, error.code, error.message);
        if (error instanceof ExtensionChannelError && error.code === EXTENSION_CONNECTION_LOST_CODE) return interrupt(job);
        if (job.state === 'live') job.fail(error);
      },
    );
    try {
      const result = await outcome;
      if (credentials && result.code === SIGN_IN_REFUSED_CODE) await hosted.refusedInJob(accountId, credentials, result.message ?? '').catch(() => undefined);
      return result;
    } finally {
      job.state = 'ended';
      job.cancelWindow?.();
      running.delete(plan.jobId);
    }
  }

  // The job an account's extension names, or the refusal that reads the same for every job it may not speak for.
  function ownJob(accountId: string, jobId: string): Running {
    const job = running.get(jobId);
    if (!job || job.state === 'ended' || job.accountId !== accountId) throw new ExtensionChannelError(JOB_REFUSALS.unknownJob, '这次任务不在这个浏览器扩展里运行。');
    return job;
  }

  async function resume(accountId: string, request: ResumeRequest): Promise<ResumeVerdict> {
    const job = ownJob(accountId, request.jobId);
    if (job.state !== 'interrupted') throw new ExtensionChannelError(JOB_REFUSALS.notInterrupted, '这次任务没有中断，不需要恢复。');
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
        await conclude(job, REOBSERVATION_MISMATCH_CODE, `浏览器扩展重新连上之后，页面已经不是中断前的样子：${problems.join('；')}。`);
        return { ok: false, reasons: problems };
      }
      const { recorded } = await db.selectFrom('erp_job_event').select((eb) => eb.fn.countAll<number>().as('recorded')).where('job_id', '=', request.jobId).executeTakeFirstOrThrow();
      // Ended while being judged (the server's deadline): there is no job left to carry on.
      if (job.state !== 'resuming') throw new ExtensionChannelError(JOB_REFUSALS.unknownJob, '这次任务不在这个浏览器扩展里运行。');
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
    fill: (plan, channel, { trigger, signal }) => run(plan, channel, EXECUTOR_METHODS.fill, { plan, trigger }, signal),
    reconcile: (plan, channel, options) => run(plan, channel, EXECUTOR_METHODS.reconcile, { plan }, options?.signal),
    async answer(accountId, method, payload) {
      switch (method) {
        case EXECUTOR_METHODS.event: {
          const parsed = JobEventRequestSchema.safeParse(payload);
          if (!parsed.success) throw new ExtensionChannelError('bad_event', '浏览器扩展发来的任务进展看不懂。');
          const { jobId, event } = parsed.data;
          const job = ownJob(accountId, jobId);
          if (job.state !== 'live') throw new ExtensionChannelError(JOB_REFUSALS.resumeRequired, '这次任务中断过，要先重新确认页面才能继续。');
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
          if (!parsed.success) throw new ExtensionChannelError('bad_request', '浏览器扩展发来的请求看不懂。');
          interrupt(ownJob(accountId, parsed.data.jobId));
          return null;
        }
        case EXECUTOR_METHODS.resume: {
          const parsed = ResumeRequestSchema.safeParse(payload);
          if (!parsed.success) throw new ExtensionChannelError('bad_request', '浏览器扩展发来的请求看不懂。');
          return resume(accountId, parsed.data);
        }
        default:
          throw new ExtensionChannelError('unknown_method', `没有处理 ${method} 的办法。`);
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
