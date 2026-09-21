// The executor protocol carried over the 浏览器扩展 (browser extension) channel (ADR-0016, ADR-0020).
//
// The channel's envelope (`@baox/contract`, `ChannelMessageSchema`) already correlates a `request` with its
// `response`, in both directions. This module gives three request methods their meaning and nothing else, so the
// server's remote executor and the extension's runner speak one vocabulary:
//
//   server -> extension  `erp.fill`       {plan, trigger}   answered with the job's `result` event
//   server -> extension  `erp.reconcile`  {plan}            answered with the job's `result` event
//   extension -> server  `erp.event`      {jobId, event}    answered with what `ExecutorChannel.emit` resolves to
//
// Every executor event is a request, not a one-way `event`: the executor awaits each emit, and a reply per event keeps
// the job log in order and lets a failed write reach the executor. Two replies carry weight — the durable-attempt ack
// and the read-back verdict — and `wireChannel` refuses to hand the executor anything that is not exactly one of them,
// because an executor that mistook some other reply for the ack would mutate ERP with nothing recorded.

import { z } from 'zod';
import {
  ExecutorEventSchema, FillPlanSchema, ReconcilePlanSchema,
  type Approval, type ApprovedPreview, type AttemptAck, type ExecutorChannel, type ExecutorEvent, type FreshGate, type ReadbackVerdict, type ResultEvent,
} from './protocol';

export const EXECUTOR_METHODS = { fill: 'erp.fill', reconcile: 'erp.reconcile', event: 'erp.event' } as const;

// What started a fill run (the server's `FillTrigger`); `confirm_login` probes the login once and never waits for it.
export const FILL_TRIGGERS = ['start', 'confirm_login', 'refill'] as const;

export const FillRequestSchema = z.object({ plan: FillPlanSchema, trigger: z.enum(FILL_TRIGGERS) });
export type FillRequest = z.infer<typeof FillRequestSchema>;

export const ReconcileRequestSchema = z.object({ plan: ReconcilePlanSchema });
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;

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

/** Sends one request over the channel and resolves with the other side's answer (the extension client's `request`). */
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
