// A fake 浏览器扩展 (browser extension) client for server tests (spec #246 Testing Decisions, seam 2). It speaks the
// channel's real envelope to the app's real channel — `hello`, correlated `request`/`response` in both directions —
// without a socket or a port, and runs whatever executor a test hands it on its side of the wire, exactly where the
// extension's `chrome.debugger` executor (#255) will run: the plan arrives as `erp.fill` / `erp.reconcile`, and every
// event goes back through `wireChannel`, the mapping the real extension uses.
//
// Reconnection (ADR-0020) is driven the way the real extension must drive it: a disconnected fake is gone for good,
// and the extension coming back is a fresh fake on the same credential that says `hello` again, then `resume`s the job
// by id with what it re-observed, and only then carries on over `channel(jobId)`. A `chrome.debugger` detach is
// `detached(jobId)` on a socket that stays up.

import { EXTENSION_VERSION, type ChannelMessage } from '@baox/contract';
import type { ExecutorChannel, ExecutorEvent, FillPlan, ReconcilePlan, ResultEvent } from '@baox/erp-executor/protocol';
import { EXECUTOR_METHODS, FillRequestSchema, JobEventRequestSchema, ReconcileRequestSchema, ResumeVerdictSchema, wireChannel, type FillRequest, type PageObservation, type ResumeVerdict } from '@baox/erp-executor/wire';
import type { ExtensionChannel } from '../../extension/channel';

export type FillRunner = (plan: FillPlan, channel: ExecutorChannel, trigger: FillRequest['trigger']) => Promise<ResultEvent>;
export type ReconcileRunner = (plan: ReconcilePlan, channel: ExecutorChannel) => Promise<ResultEvent>;

export type FakeExtension = {
  // Sends `hello` and resolves once the server answered `ready`.
  connect(): Promise<void>;
  // The socket goes: nothing further is sent either way, and every request of this extension still waiting fails.
  disconnect(): void;
  // Every request the server made of this extension, in order.
  asked(): Array<{ method: string; payload: unknown }>;
  // Every executor event this extension sent up, in order.
  sent(): ExecutorEvent[];
  // A raw request to the server, as the extension would make one.
  request(method: string, payload: unknown): Promise<unknown>;
  // The debugger lost the job's page (`erp.detached`); the socket stays up.
  detached(jobId: string): Promise<unknown>;
  // `erp.resume`: the page as it was right before the interruption, and as it is now.
  resume(jobId: string, last: PageObservation, now: PageObservation): Promise<ResumeVerdict>;
  // The job's event stream from this extension, for carrying on after a resume.
  channel(jobId: string): ExecutorChannel;
};

class FakeRequestFailed extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FakeRequestFailed';
  }
}

export function fakeExtension(channel: ExtensionChannel, token: string, runners: { fill?: FillRunner; reconcile?: ReconcileRunner }): FakeExtension {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const asked: Array<{ method: string; payload: unknown }> = [];
  const sent: ExecutorEvent[] = [];
  let live = true;
  let nextId = 0;
  let ready!: () => void;
  const readied = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const session = channel.open({ send: (data) => hear(JSON.parse(data) as ChannelMessage), close: () => drop() });
  const say = (message: ChannelMessage) => {
    if (live) void session.message(JSON.stringify(message));
  };

  function drop(): void {
    if (!live) return;
    live = false;
    for (const waiter of pending.values()) waiter.reject(new FakeRequestFailed('channel_closed', '和应用的连接断开了。'));
    pending.clear();
  }

  function hear(message: ChannelMessage): void {
    switch (message.type) {
      case 'ready':
        ready();
        return;
      case 'response': {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiter?.resolve(message.payload);
        else waiter?.reject(new FakeRequestFailed(message.error.code, message.error.message));
        return;
      }
      case 'request':
        asked.push({ method: message.method, payload: message.payload });
        void serve(message.method, message.payload).then(
          (payload) => say({ type: 'response', id: message.id, ok: true, payload }),
          (error: unknown) => say({ type: 'response', id: message.id, ok: false, error: { code: 'executor_failed', message: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      default:
        return;
    }
  }

  async function serve(method: string, payload: unknown): Promise<ResultEvent> {
    if (method === EXECUTOR_METHODS.fill && runners.fill) {
      const { plan, trigger } = FillRequestSchema.parse(payload);
      return runners.fill(plan, wireChannel(plan.jobId, request), trigger);
    }
    if (method === EXECUTOR_METHODS.reconcile && runners.reconcile) {
      const { plan } = ReconcileRequestSchema.parse(payload);
      return runners.reconcile(plan, wireChannel(plan.jobId, request));
    }
    throw new Error(`this fake extension does not run ${method}`);
  }

  function request(method: string, payload: unknown): Promise<unknown> {
    if (!live) return Promise.reject(new FakeRequestFailed('channel_closed', '和应用的连接断开了。'));
    const event = method === EXECUTOR_METHODS.event ? JobEventRequestSchema.safeParse(payload) : null;
    if (event?.success) sent.push(event.data.event);
    nextId += 1;
    const id = `e${nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      say({ type: 'request', id, method, payload });
    });
  }

  return {
    async connect() {
      say({ type: 'hello', token, version: EXTENSION_VERSION });
      await readied;
    },
    disconnect() {
      drop();
      session.closed();
    },
    asked: () => asked,
    sent: () => sent,
    request,
    detached: (jobId) => request(EXECUTOR_METHODS.detached, { jobId }),
    resume: async (jobId, last, now) => ResumeVerdictSchema.parse(await request(EXECUTOR_METHODS.resume, { jobId, last, now })),
    channel: (jobId) => wireChannel(jobId, request),
  };
}
