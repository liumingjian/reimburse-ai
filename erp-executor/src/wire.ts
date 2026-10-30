// The executor protocol carried over the 本地执行器 (local executor) channel (ADR-0016, ADR-0020).
//
// The channel's envelope (`@baox/contract`, `ChannelMessageSchema`) already correlates a `request` with its
// `response`, in both directions. This module gives three request methods their meaning and nothing else, so the
// server's remote executor and the 本地执行器's runner speak one vocabulary:
//
//   server -> 本地执行器  `erp.fill`       {plan, trigger}   answered with the job's `result` event
//   server -> 本地执行器  `erp.reconcile`  {plan}            answered with the job's `result` event
//   server -> executor   `erp.trySignIn`  {erpOrigin, credentials}  试登录: answered with a `TrySignInAnswer`
//   本地执行器 -> server  `erp.event`      {jobId, event}    answered with what `ExecutorChannel.emit` resolves to
//   本地执行器 -> server  `erp.detached`   {jobId}           the job lost its page: interrupts the job
//   本地执行器 -> server  `erp.resume`     {jobId, last, now}  answered with a `ResumeVerdict`
//
// A local executor (ADR-0033) signs in itself, so its `erp.fill` and `erp.reconcile` also carry the employee's ERP 凭据.
// They travel with the request, never in the plan: the plan is stored with the job, the 凭据 must not be.
//
// Every executor event is a request, not a one-way `event`: the executor awaits each emit, and a reply per event keeps
// the job log in order and lets a failed write reach the executor. Two replies carry weight — the durable-attempt ack
// and the read-back verdict — and `wireChannel` refuses to hand the executor anything that is not exactly one of them,
// because an executor that mistook some other reply for the ack would mutate ERP with nothing recorded.

import { z } from 'zod';
import { ErpBrowserModeSchema } from '@baox/contract';
import {
  ErpAccountSchema, ExecutorEventSchema, FillPlanSchema, ReconcilePlanSchema,
  type Approval, type ApprovedPreview, type AttemptAck, type ExecutorChannel, type ExecutorEvent, type FreshGate, type ReadbackVerdict, type ResultEvent,
} from './protocol';

export const EXECUTOR_METHODS = { fill: 'erp.fill', reconcile: 'erp.reconcile', trySignIn: 'erp.trySignIn', event: 'erp.event', detached: 'erp.detached', resume: 'erp.resume' } as const;

// Why the server refused a job request. `unknown_job` reads the same for a job that ended, one that never existed and
// another account's; the other two tell an interrupted job's 本地执行器 what it must do next.
export const JOB_REFUSALS = { unknownJob: 'unknown_job', resumeRequired: 'resume_required', notInterrupted: 'job_not_interrupted' } as const;

// What started a fill run (the server's `FillTrigger`). `rerun` is an 自动重新去报销 (ADR-0034): it runs like
// `refill`, on a fresh 新增单, and its plan carries `rerun`.
export const FILL_TRIGGERS = ['start', 'refill', 'rerun'] as const;

export const ErpCredentialsSchema = z.object({ account: z.string().min(1).max(128), password: z.string().min(1).max(256) });

export const FillRequestSchema = z.object({ plan: FillPlanSchema, trigger: z.enum(FILL_TRIGGERS), credentials: ErpCredentialsSchema.optional(), browserMode: ErpBrowserModeSchema.optional() });
export type FillRequest = z.infer<typeof FillRequestSchema>;

export const ReconcileRequestSchema = z.object({ plan: ReconcilePlanSchema, credentials: ErpCredentialsSchema.optional(), browserMode: ErpBrowserModeSchema.optional() });
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;

// 试登录: sign in with these 凭据 and straight out again, touching nothing else. `code` is the sign-in's own failure
// code (`sign-in.ts`); `erp_sign_in_refused` is the one that disables the 凭据.
export const SIGN_IN_REFUSED_CODE = 'erp_sign_in_refused';
export const TrySignInRequestSchema = z.object({ erpOrigin: z.string().url(), credentials: ErpCredentialsSchema, browserMode: ErpBrowserModeSchema.optional() });
export type TrySignInRequest = z.infer<typeof TrySignInRequestSchema>;
export const TrySignInAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string().min(1), message: z.string() }),
]);
export type TrySignInAnswer = z.infer<typeof TrySignInAnswerSchema>;

export const JobEventRequestSchema = z.object({ jobId: z.string().min(1), event: ExecutorEventSchema });
export type JobEventRequest = z.infer<typeof JobEventRequestSchema>;

const AttemptAckSchema = z.object({ persisted: z.literal(true) });

// The preview model is the server's; the executor only carries it into the fill, so its shape is not re-checked here.
const present = (value: unknown) => typeof value === 'object' && value !== null;
const ReadbackVerdictSchema = z.union([
  z.object({
    ok: z.literal(true),
    preview: z.custom<ApprovedPreview>(present).optional(),
    approval: z.custom<Approval>(present).optional(),
    freshGate: z.custom<FreshGate>(present).optional(),
  }),
  z.object({ ok: z.literal(false), reasons: z.array(z.string()) }),
]);

/** The job's `result` event out of an `erp.fill` / `erp.reconcile` answer; anything else is a protocol error. */
export function resultOf(payload: unknown): ResultEvent {
  const event = ExecutorEventSchema.parse(payload);
  if (event.type !== 'result') throw new Error(`the executor answered its job with a ${event.type} event instead of its result`);
  return event;
}

/** Sends one request over the channel and resolves with the other side's answer (the 本地执行器 client's `request`). */
export type WireRequest = (method: string, payload: unknown) => Promise<unknown>;

/** The executor's end of the wire: an `ExecutorChannel` whose every emit is one `erp.event` request for `jobId`. */
export function wireChannel(jobId: string, request: WireRequest): ExecutorChannel {
  const emit = async (event: ExecutorEvent): Promise<AttemptAck | ReadbackVerdict | undefined> => {
    const reply = await request(EXECUTOR_METHODS.event, { jobId, event } satisfies JobEventRequest);
    if (event.type === 'attempt_started') return AttemptAckSchema.parse(reply);
    if (event.type === 'readback') return ReadbackVerdictSchema.parse(reply) as ReadbackVerdict;
    return undefined;
  };
  return { emit: emit as ExecutorChannel['emit'] };
}

// Reconnection (ADR-0020: a reconnect restores the channel, not the page). A job is *interrupted* when its 本地执行器's
// socket goes or it loses its page (`erp.detached`) — one event, one rule. For this long afterwards the
// 本地执行器 may resume it by `jobId`; past it, the server ends the job itself.
export const RECONNECT_WINDOW_MS = 120_000;

// The 发票助手 (invoice assistant) as the 本地执行器 finds it. It is one-shot — once closed it never reopens — so its
// state is part of what "the same page" means, and `unrecognised` is never a page anyone may carry on from.
export const ASSISTANT_STATES = ['closed', 'open', 'unrecognised'] as const;

/** What the 本地执行器 sees of the ERP page, read without touching it. */
export const PageObservationSchema = z.object({
  // Who is logged in; null when nobody is, or it could not be read.
  erpAccount: ErpAccountSchema.nullable(),
  // The one 费用报销单 open; null when none is.
  form: z.object({ targetId: z.string(), formInstanceId: z.string(), formMode: z.enum(['new', 'modify']), billNo: z.string().nullable() }).nullable(),
  assistant: z.enum(ASSISTANT_STATES),
});
export type PageObservation = z.infer<typeof PageObservationSchema>;

/**
 * `erp.resume`: sent once the 本地执行器 is back (a fresh `hello` → `ready`, or the page re-attached) and has
 * re-observed the page, before it does anything else. `last` is the page as it saw it right before the interruption,
 * `now` as it sees it after; the server judges the two against each other and against the job's record.
 */
export const ResumeRequestSchema = z.object({ jobId: z.string().min(1), last: PageObservationSchema, now: PageObservationSchema });
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

/**
 * The server's answer to `erp.resume`. `ok: true` carries how many of the job's events are on record: the 本地执行器
 * sends none of those again (nothing is ever replayed) and carries on from the next. An `attempt_started` among them
 * counts as acknowledged, because durable is what the acknowledgement means; a `readback` among them lost its
 * verdict, so the executor must not act on it and ends the job instead. `ok: false` means the page is not the one the
 * job left: the server has already ended the job, and the 本地执行器 stops without touching the page.
 */
export const ResumeVerdictSchema = z.union([
  z.object({ ok: z.literal(true), recorded: z.number().int().nonnegative() }),
  z.object({ ok: z.literal(false), reasons: z.array(z.string()) }),
]);
export type ResumeVerdict = z.infer<typeof ResumeVerdictSchema>;

export const JobRefSchema = z.object({ jobId: z.string().min(1) });
