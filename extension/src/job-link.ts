import type { CdpListener, CdpSession } from '@baox/erp-executor/cdp';
import { observePage } from '@baox/erp-executor/observe';
import { abortedResult, type ExecutorChannel, type ExecutorEvent, type ResultEvent } from '@baox/erp-executor/protocol';
import {
  EXECUTOR_METHODS, JOB_REFUSALS, RECONNECT_WINDOW_MS, ResumeVerdictSchema, wireChannel,
  type JobEventRequest, type PageObservation, type WireRequest,
} from '@baox/erp-executor/wire';

// One running job's hold on the app and on its page, and how it gets both back after an interruption (ADR-0020: a
// reconnect restores the channel, not the page).
//
// Everything the executor does goes through here: its events (`channel`) and its commands to the page (`adopt`). So
// when either the socket or the `chrome.debugger` goes, this is where the job stops dead, and where it resumes:
//
//   1. On a detach, `erp.detached {jobId}` goes first. On a closed channel nothing is sent: the server saw it go.
//   2. Once the channel is `ready` again, the job's own tab is re-attached if the debugger lost it (never a new tab),
//      the page is re-observed read-only, and `erp.resume {jobId, last, now}` goes out. Until that answers `ok`, the
//      executor gets neither an event out nor a command in. The server would refuse such an event anyway
//      (`resume_required`); this does not rely on it.
//   3. `{ok: true, recorded}`: nothing on record is sent again. The event the break cut off is either on record — an
//      `attempt_started` then counts as acknowledged, a `readback` has lost its verdict and ends the job — or it is
//      sent now, for the first time.
//   4. `ok: false`, `unknown_job`, the job's tab gone, the window over: the job stops without touching the page, and
//      the server decides.
//
// Where the executor cannot carry on — a detach cut off a command it had under way, a read-back verdict it will never
// get — this link ends the job with an `aborted` result, and nothing else. It never picks the disposition: the server
// turns `aborted` into `unknown` (对账) when an attempt is on record.

export type Interruption = { kind: 'debugger_detached' | 'channel_closed'; reason: string };

/** The channel to the app as a job needs it across a reconnect. */
export type ChannelWatch = {
  /** The socket went (ready → anything else). Returns what unsubscribes. */
  onClosed(listener: () => void): () => void;
  /** Resolves once the channel says `ready`; at once if it does now. */
  ready(): Promise<void>;
};

/** The job's ERP page as attached: its session, and its CDP target id as attempts record it. */
export type AttachedPage = { session: CdpSession; targetId: string };

export type JobLinkPorts = {
  jobId: string;
  erpOrigin: string;
  request: WireRequest;
  channel: ChannelWatch;
  /** The job's own tab attached again. Never a new tab: null when it is gone, and then nothing can be re-observed. */
  reattach(): Promise<AttachedPage | null>;
  onInterrupted?: (interruption: Interruption) => void;
  windowMs?: number;
};

export type JobLink = {
  /** The executor's `ExecutorChannel`: every event one `erp.event`, held while the job is interrupted. */
  channel: ExecutorChannel;
  /** The executor's session on the job's page: commands wait while the job is interrupted, and follow a re-attach. */
  adopt(page: AttachedPage): CdpSession;
  interrupt(interruption: Interruption): void;
  /** The `aborted` result this link ended the job with, if it did. */
  ownResult(): ResultEvent | null;
  close(): void;
};

class JobStopped extends Error {
  readonly code = 'extension_job_stopped';
  constructor(message = '这次去报销已经停下，没有再动报销系统页面。') {
    super(message);
    this.name = 'JobStopped';
  }
}

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
// A request the break cut off: the socket went under it, or the server already counts the job as interrupted.
const cutOffByBreak = (error: unknown) => codeOf(error) === 'channel_closed' || codeOf(error) === JOB_REFUSALS.resumeRequired;

/** The job's own end when a detach cut off a command under way (exported for the real-browser suite's assertion). */
export const DETACHED_MID_COMMAND = {
  code: 'debugger_detached_mid_command',
  message: '浏览器扩展对报销系统页面的控制在一步操作进行到一半时断开了，这一步有没有生效看不出来，所以没有继续。',
} as const;
const READBACK_VERDICT_LOST = { code: 'readback_verdict_lost', message: '连接恢复了，但中断前送去核对的页面读数没有拿到结论，所以没有继续。' } as const;
const RECORD_MISMATCH = { code: 'resume_record_mismatch', message: '连接恢复了，但应用记下的进展和浏览器扩展发出的对不上，所以没有继续。' } as const;

export function createJobLink({ jobId, erpOrigin, request, channel, reattach, onInterrupted, windowMs = RECONNECT_WINDOW_MS }: JobLinkPorts): JobLink {
  let state: 'live' | 'interrupted' | 'stopped' = 'live';
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  let page: AttachedPage | null = null;
  let pageGone = false;
  let detachNotice = false;
  let channelDown = false;
  // Interrupted again while recovering: the recovery starts over.
  let again = false;
  // A detach cut off a command the executor had under way; whether it took effect cannot be known.
  let killed = false;
  let commands = 0;
  // The session whose last command failed, until one succeeds on it. Chrome fails a command it cut off before it
  // reports the detach, and nothing bounds how long before: a detach that arrives after a failure, with no success
  // in between, is taken as that failure's cause, so it counts as a detach mid-command (`interrupt`). Wrongly taken,
  // it only ends a job that could have resumed — to 对账 at worst, never a replay.
  let failedOn: CdpSession | null = null;
  // The job's log as this side knows it: how many events the server answered, the one out now, and the one a break
  // cut off (on record or not — the resume says which).
  let acknowledged = 0;
  let sending: Promise<unknown> | null = null;
  let held: ExecutorEvent | null = null;
  let heldOnRecord = false;
  // The page as it stood when the job last reported: re-read before every event, so it exists when a break comes.
  let last: PageObservation | null = null;
  let own: ResultEvent | null = null;
  const subscriptions: Array<{ method: string; listener: CdpListener; off: (() => void) | undefined }> = [];

  async function pass(): Promise<void> {
    while (state === 'interrupted') await gate;
    if (state === 'stopped') throw new JobStopped();
  }

  function stop(): void {
    state = 'stopped';
    open();
  }

  // The `aborted` result, as the next event of the job's log; the server decides what it becomes.
  async function conclude({ code, message }: { code: string; message: string }): Promise<void> {
    own = abortedResult(code, message);
    try {
      await request(EXECUTOR_METHODS.event, { jobId, event: own } satisfies JobEventRequest);
    } catch {
      // Lost as well: the server ends the job once the window is over, by the same rule.
    }
    stop();
  }

  function interrupt(interruption: Interruption): void {
    if (state === 'stopped') return;
    if (interruption.kind === 'channel_closed') {
      // The request that failed and the status change are the same loss.
      if (channelDown) return;
      channelDown = true;
    } else {
      pageGone = true;
      detachNotice = true;
      if (commands > 0 || (page !== null && failedOn === page.session)) killed = true;
    }
    onInterrupted?.(interruption);
    if (state === 'interrupted') {
      again = true;
      return;
    }
    state = 'interrupted';
    gate = new Promise((resolve) => {
      open = resolve;
    });
    void recover();
  }

  async function recover(): Promise<void> {
    const until = Date.now() + windowMs;
    // Every wait is bounded by the window: past it the server has ended the job, and there is nothing to resume.
    const inWindow = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new JobStopped()), Math.max(0, until - Date.now()));
      work.then(
        (value) => {
          clearTimeout(timer);
          if (state === 'stopped') reject(new JobStopped());
          else resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    try {
      for (;;) {
        again = false;
        if (detachNotice) {
          detachNotice = false;
          await inWindow(request(EXECUTOR_METHODS.detached, { jobId }).catch((error: unknown) => {
            // With the socket gone too, the server has already seen the one interruption this is.
            if (codeOf(error) !== 'channel_closed') throw error;
          }));
        }
        await inWindow(channel.ready());
        channelDown = false;
        // An event already out is answered or cut off before the log is counted.
        await inWindow(Promise.resolve(sending).catch(() => undefined));
        if (pageGone) {
          const back = await inWindow(reattach());
          if (!back) return stop();
          page = back;
          pageGone = false;
          for (const entry of subscriptions) entry.off = back.session.on?.(entry.method, entry.listener);
        }
        if (!last || !page) return stop();
        const now = await inWindow(observePage(page.session, { targetId: page.targetId, erpOrigin }));
        if (again) continue;
        let verdict;
        try {
          verdict = ResumeVerdictSchema.parse(await inWindow(request(EXECUTOR_METHODS.resume, { jobId, last, now })));
        } catch (error) {
          if (codeOf(error) === 'channel_closed') continue;
          throw error;
        }
        if (!verdict.ok) return stop();
        // Interrupted again after the server let the job go on: it hears of that too (`erp.detached` or the socket),
        // and the job resumes once more.
        if (again) continue;
        const { recorded } = verdict;
        if (recorded < acknowledged || recorded > acknowledged + (held ? 1 : 0)) return await conclude(RECORD_MISMATCH);
        heldOnRecord = held !== null && recorded > acknowledged;
        if (heldOnRecord && held?.type === 'readback') return await conclude(READBACK_VERDICT_LOST);
        if (killed) return await conclude(DETACHED_MID_COMMAND);
        state = 'live';
        open();
        return;
      }
    } catch {
      // `unknown_job`, the window over, anything unexpected: stop here, touch nothing, and let the server decide.
      stop();
    }
  }

  const sendEvent: WireRequest = async (method, payload) => {
    const { event } = payload as JobEventRequest;
    for (;;) {
      await pass();
      if (killed) {
        // Cut off after the resume already let the job go on (a command that answered late).
        await conclude(DETACHED_MID_COMMAND);
        throw new JobStopped();
      }
      if (held === event) {
        held = null;
        if (heldOnRecord) {
          heldOnRecord = false;
          acknowledged += 1;
          // Durable is what the acknowledgement means. (A `readback` on record never gets here: it ended the job.)
          return event.type === 'attempt_started' ? { persisted: true } : null;
        }
        // Not on record: what follows is its first time on the wire, not a replay.
      }
      if (page && !pageGone) {
        const seen = await observePage(page.session, { targetId: page.targetId, erpOrigin });
        // A break while looking: that look is not the page before it.
        if (state !== 'live' || pageGone) continue;
        last = seen;
      }
      const out = request(method, payload);
      sending = out;
      try {
        const reply = await out;
        acknowledged += 1;
        return reply;
      } catch (error) {
        if (!cutOffByBreak(error)) {
          if (codeOf(error) === JOB_REFUSALS.unknownJob) stop();
          throw error;
        }
        held = event;
        interrupt({ kind: 'channel_closed', reason: error instanceof Error ? error.message : String(error) });
      } finally {
        if (sending === out) sending = null;
      }
    }
  };

  return {
    channel: wireChannel(jobId, sendEvent),
    adopt(attached) {
      page = attached;
      return {
        async send(method, params, options) {
          await pass();
          const session = page!.session;
          commands += 1;
          try {
            const answer = await session.send(method, params, options);
            if (failedOn === session) failedOn = null;
            return answer;
          } catch (error) {
            // A command the adapter recognised as cut off by a detach has already interrupted the job, with this
            // command still counted; any other failure is held against a detach that may yet be reported.
            failedOn = session;
            throw error;
          } finally {
            commands -= 1;
          }
        },
        on(method, listener) {
          const entry = { method, listener, off: page!.session.on?.(method, listener) };
          subscriptions.push(entry);
          return () => {
            entry.off?.();
            const at = subscriptions.indexOf(entry);
            if (at >= 0) subscriptions.splice(at, 1);
          };
        },
        close() {
          page?.session.close();
        },
      };
    },
    interrupt,
    ownResult: () => own,
    close: stop,
  };
}
