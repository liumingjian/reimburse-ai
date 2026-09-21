import { z } from 'zod';
import type { ActionError } from './actions';

// 扩展配对 (extension pairing, ADR-0019): the binding between one 浏览器扩展 (browser extension) and one 应用账号
// (app account). The settings page issues a short 配对码 (pairing code); the extension exchanges it once for a
// long-lived token that carries the 应用账号 id, and the server routes ERP work by that id.
//
// Pairing is independent of the app login in both directions: 撤销配对 keeps the web session, and a logout keeps the
// extension paired. Each 应用账号 has at most one pairing at a time; issuing a new 配对码 replaces the previous one.

// Where the extension itself talks: POST redeems a 配对码, GET answers which 应用账号 the bearer token acts for.
// The extension posts from its own `chrome-extension://…` origin, so this path is the one write the exact-origin
// guard lets through (`server/src/app.ts`); the code in the body is its whole authority, and it carries no cookie.
export const EXTENSION_PAIR_PATH = '/api/extension/pair';

// Read off the screen and typed into the extension by hand, so it is short and single use rather than long-lived.
export const EXTENSION_PAIRING_CODE_LENGTH = 8;
export const EXTENSION_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

// `browser`: what the extension calls the browser it runs in, shown back to the employee so they can tell which
// browser is paired. The server stores it verbatim and never acts on it.
export const ExtensionPairInputSchema = z.object({
  code: z.string().min(1).max(64),
  browser: z.string().trim().min(1).max(80).nullish(),
});
export type ExtensionPairInput = z.infer<typeof ExtensionPairInputSchema>;

// What the extension keeps: the token and the 应用账号 it acts for.
export const ExtensionTokenSchema = z.object({ token: z.string().min(1), accountId: z.string().min(1) });
export type ExtensionToken = z.infer<typeof ExtensionTokenSchema>;

export const ExtensionIdentitySchema = z.object({ accountId: z.string().min(1) });
export type ExtensionIdentity = z.infer<typeof ExtensionIdentitySchema>;

// none 没有配对；waiting 配对码已生成、还没有扩展用过；paired 已配对。
export const EXTENSION_PAIRING_STATUSES = ['none', 'waiting', 'paired'] as const;

export const ExtensionPairingSchema = z.object({
  status: z.enum(EXTENSION_PAIRING_STATUSES),
  browser: z.string().nullable(),
  pairedAt: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  codeExpiresAt: z.string().nullable(),
  // The freshly issued 配对码, and only in the answer to issuing one: the server keeps nothing but its sha256, so it
  // can never be shown a second time.
  code: z.string().nullable(),
});
export type ExtensionPairing = z.infer<typeof ExtensionPairingSchema>;

export const ExtensionPairingFailureSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});

// 生成配对码 / 撤销配对的结果：服务端处理了就是新的配对情况；请求本身失败才是 !ok。
export type ExtensionPairingOutcome = { ok: true; pairing: ExtensionPairing } | { ok: false; error: ActionError; pairing: ExtensionPairing | null };

export const EXTENSION_PAIRING_ERRORS = {
  codeInvalid: '配对码不对，或者已经过期、已经用过。请在设置页重新生成一个。',
  notPaired: '这个浏览器扩展的配对已经失效，请在设置页重新生成配对码。',
} as const;

export const EXTENSION_PAIRING_STATUS_LABELS: Readonly<Record<(typeof EXTENSION_PAIRING_STATUSES)[number], string>> = {
  none: '还没有配对',
  waiting: '配对码已生成，等待扩展填入',
  paired: '已配对',
};
