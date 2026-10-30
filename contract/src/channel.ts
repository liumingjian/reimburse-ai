import { z } from 'zod';
import type { ActionError } from './actions';

// What the paired client, the 本地执行器 (local executor, ADR-0033), shares with the app (ADR-0037: the only one; the
// 浏览器扩展 that first spoke all this is gone). 配对, invoice originals, version negotiation and the channel. Names are
// by purpose; the wire paths keep their old `/api/extension/…` spelling, so the executors already installed still
// reach them.
//
// 配对 (pairing, ADR-0019): the binding between one paired client and one 应用账号 (app account). The settings page
// issues a short 配对码 (pairing code); the client exchanges it once for a long-lived token that carries the 应用账号
// id, and the server routes ERP work by that id.
//
// Pairing is independent of the app login in both directions: 撤销配对 keeps the web session, and a logout keeps the
// client paired. Each 应用账号 has at most one pairing at a time; issuing a new 配对码 replaces the previous one.

// Where the 本地执行器 itself talks: POST redeems a 配对码, GET answers which 应用账号 the bearer token acts for.
// The client posts from no page of the app's origin, so this path is the one write the exact-origin guard lets through
// (`server/src/app.ts`); the code in the body is its whole authority, and it carries no cookie.
export const PAIRING_PATH = '/api/extension/pair';

// Carried by the install command, or read off the screen and typed in by hand, so it is short and single use rather
// than long-lived.
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

// Where the 本地执行器 fetches an invoice original (#256): `GET <INVOICE_BLOB_PATH>/<sha256>` with its token in
// `Authorization: Bearer`. It answers only for the originals named in the plan of the 去报销 running in that
// 应用账号's 本地执行器 right now (ADR-0022), so a stolen token cannot walk the employee's archive. A plain GET: the
// exact-origin write check never applies to it, the Host check does.
export const INVOICE_BLOB_PATH = '/api/extension/blobs';
export const invoiceBlobPath = (sha256: string): string => `${INVOICE_BLOB_PATH}/${sha256}`;

// ---------------------------------------------------------------------------
// Version negotiation (ADR-0021)
// ---------------------------------------------------------------------------

// The single source of truth for what the 本地执行器 is, and for what the server will still talk to (ADR-0035 keeps
// ADR-0021's gate for it).
//
// `EXECUTOR_VERSION` is what the 本地执行器 built from this tree reports in its `hello` and its 配对 request.
// `MINIMUM_EXECUTOR_VERSION` is what the server refuses to go below. Both live here, one above the other, because a
// build that ships a version the server then rejects is the one failure this arrangement has to make impossible.
//
// ADR-0021 chose refusal over best-effort compatibility: the fill protocol hands down one whole plan, and an old
// executor running half of it leaves a write of undecidable outcome behind. Refusing costs a day.
//
// Raise MINIMUM_EXECUTOR_VERSION (and EXECUTOR_VERSION with it) when a change is one an older 本地执行器 must not be
// allowed to run; installed executors update themselves to the server's program (ADR-0035).
export const EXECUTOR_VERSION = '1.2.0';
export const MINIMUM_EXECUTOR_VERSION = '1.2.0';

// Dotted numbers only, the shape `manifest.json` allows. Returns <0, 0 or >0 like any comparator; a missing part
// counts as 0, so `1.2` and `1.2.0` are the same version.
export function compareExecutorVersions(left: string, right: string): number {
  const parts = (value: string) => value.split('.').map((piece) => Number.parseInt(piece, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export const ExecutorVersionSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^\d+(\.\d+){0,3}$/);

// `browser`: what the client calls itself (the 本地执行器 says `baox 本地执行器（darwin）`), shown back to the employee
// so they can tell what is paired. The server stores it verbatim and never acts on it. `version` is the client's own version,
// reported here and again on every connect (ADR-0021); below the minimum it is refused at both.
export const PairingInputSchema = z.object({
  code: z.string().min(1).max(64),
  browser: z.string().trim().min(1).max(80).nullish(),
  version: ExecutorVersionSchema.nullish(),
});
export type PairingInput = z.infer<typeof PairingInputSchema>;

// What the 本地执行器 keeps: the token and the 应用账号 it acts for.
export const PairingTokenSchema = z.object({ token: z.string().min(1), accountId: z.string().min(1) });
export type PairingToken = z.infer<typeof PairingTokenSchema>;

// What the app answers a 本地执行器 that asks with its token (GET PAIRING_PATH): which account it acts for.
// `connected`: whether the app sees this account's channel right now. Optional: a server from before it answers none.
export const PairingIdentitySchema = z.object({ accountId: z.string().min(1), username: z.string().min(1), connected: z.boolean().optional() });
export type PairingIdentity = z.infer<typeof PairingIdentitySchema>;

// none: no pairing; waiting: a 配对码 (pairing code) is issued and no 本地执行器 has used it yet; paired: paired.
export const PAIRING_STATUSES = ['none', 'waiting', 'paired'] as const;

// The pairing service owns this state. It deliberately does not carry the application origin, because the origin is
// deployment configuration rather than a per-account pairing fact.
export const PairingStateSchema = z.object({
  status: z.enum(PAIRING_STATUSES),
  browser: z.string().nullable(),
  pairedAt: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  codeExpiresAt: z.string().nullable(),
  // Whether that 本地执行器's channel is open right now. `lastConnectedAt` says when it last spoke; this says whether
  // it is listening, which is what an employee about to click 去报销 needs to know.
  connected: z.boolean(),
  // The version the paired 本地执行器 last reported, or null when nothing has paired yet.
  version: z.string().nullable(),
  // The freshly issued 配对码, and only in the answer to issuing one: the server keeps nothing but its sha256, so it
  // can never be shown a second time.
  code: z.string().nullable(),
});
export type PairingState = z.infer<typeof PairingStateSchema>;

// The settings page receives the pairing state plus the address the running server admits and puts into the
// 本地执行器's install command. Keeping this in the HTTP view prevents a persisted pairing from carrying a stale deployment
// origin after an operator changes the address.
export const PairingViewSchema = PairingStateSchema.extend({
  activeOrigin: z.string().url(),
});
export type PairingView = z.infer<typeof PairingViewSchema>;

export const PairingFailureSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});

// The result of issuing a 配对码 or revoking the pairing: the new pairing when the server handled it; !ok only when
// the request itself failed.
export type PairingChangeOutcome = { ok: true; pairing: PairingView } | { ok: false; error: ActionError; pairing: PairingView | null };

// The one refusal both halves of version negotiation give (ADR-0021): the 配对 request and the channel's first
// message answer with the same sentence, so an employee who hits it twice reads it once. Running the 设置页's install
// command again puts the current program in place and pairs it in one go.
export const EXECUTOR_VERSION_TOO_OLD_CODE = 'version_too_old';

// Null when the reported version is good enough; the sentence to show otherwise. A client that reports no version
// at all is by construction older than the first one that did, so it is refused too.
export function executorVersionRefusal(reported: string | null | undefined, minimum: string): string | null {
  if (reported && compareExecutorVersions(reported, minimum) >= 0) return null;
  const which = reported ? `你装的是 ${reported} 版。` : '你装的这一版太旧，连版本号都报不上来。';
  return `这台服务器要求 baox 本地执行器 ${minimum} 或更新的版本，所以没有连上。${which}请回到设置页生成安装命令，在这台电脑上再运行一次。`;
}

export const PAIRING_ERRORS = {
  codeInvalid: '配对码不对，或者已经过期、已经用过。请在设置页重新生成一个。',
  notPaired: '这个本地执行器的配对已经失效，请在设置页重新生成安装命令。',
} as const;

export const PAIRING_STATUS_LABELS: Readonly<Record<(typeof PAIRING_STATUSES)[number], string>> = {
  none: '还没有配对',
  waiting: '配对码已生成，等待本地执行器连上',
  paired: '已配对',
};

// ---------------------------------------------------------------------------
// The channel (ADR-0019, ADR-0020)
// ---------------------------------------------------------------------------

// The 本地执行器 opens this; the server never reaches into the employee's PC. The pairing credential travels in
// the first message, never in the URL, because a URL is written into proxy and browser logs and a long-lived
// credential must not be.
export const CHANNEL_PATH = '/api/extension/channel';

// How often the client sends a `ping`: often enough that a wedged channel is noticed within a minute (the server
// gives up after three silent beats).
export const CHANNEL_HEARTBEAT_MS = 15_000;

// Both sides speak one envelope, and either may be the one asking.
//
// `request` carries a correlation id that the matching `response` echoes, because the fill protocol is
// request/response in both directions rather than a one-way event stream: the executor's `attempt_started` waits for
// the server to answer that the attempt is durable, and its `readback` waits for the server's verdict. Ids are unique
// per sender, so the two directions never collide over one.
//
// `event` is the one-way half, for what nobody waits on. `method` and `name` are left open here and given meaning by
// the fill protocol; this package pins the envelope only.
export const ChannelHelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  version: ExecutorVersionSchema.nullish(),
});
export type ChannelHello = z.infer<typeof ChannelHelloSchema>;

export const ChannelReadySchema = z.object({
  type: z.literal('ready'),
  accountId: z.string().min(1),
  heartbeatMs: z.number().int().positive(),
});
export type ChannelReady = z.infer<typeof ChannelReadySchema>;

// Sent, and then the socket is closed. The 本地执行器 logs `message` as it stands.
export const ChannelRefusedSchema = z.object({
  type: z.literal('refused'),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ChannelRefused = z.infer<typeof ChannelRefusedSchema>;

export const ChannelRequestSchema = z.object({
  type: z.literal('request'),
  id: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type ChannelRequest = z.infer<typeof ChannelRequestSchema>;

export const ChannelResponseSchema = z.union([
  z.object({ type: z.literal('response'), id: z.string().min(1).max(64), ok: z.literal(true), payload: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.string().min(1).max(64), ok: z.literal(false), error: z.object({ code: z.string().min(1), message: z.string().min(1) }) }),
]);
export type ChannelResponse = z.infer<typeof ChannelResponseSchema>;

export const ChannelEventSchema = z.object({
  type: z.literal('event'),
  name: z.string().min(1).max(64),
  payload: z.unknown(),
});
export type ChannelEvent = z.infer<typeof ChannelEventSchema>;

export const ChannelMessageSchema = z.union([ChannelHelloSchema, ChannelReadySchema, ChannelRefusedSchema, ChannelRequestSchema, ChannelResponseSchema, ChannelEventSchema]);
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

// The heartbeat is a `request` like any other, so one correlation mechanism covers everything: an unanswered ping is
// a wedged channel, which a silent socket on its own does not tell you.
export const CHANNEL_PING_METHOD = 'ping';

// Close codes, in the private 4000-4999 range. The client tells them apart to decide whether reconnecting could
// ever help (for these three it cannot) and what to tell the employee.
export const CHANNEL_CLOSE = { notPaired: 4001, versionTooOld: 4002, badMessage: 4003 } as const;

export const CHANNEL_ERRORS = {
  notPaired: PAIRING_ERRORS.notPaired,
  badMessage: '这个本地执行器发来的内容看不懂，连接已经断开。请在设置页生成安装命令，重新安装后再试。',
} as const;
