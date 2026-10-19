import { PAIRING_ERRORS, PAIRING_PATH, EXECUTOR_VERSION, PairingIdentitySchema, PairingFailureSchema, PairingTokenSchema } from '@baox/contract';
import { APP_UNREACHABLE } from './messages';

// Redeeming the 配对码 (pairing code) the install command or the 设置页 hands over, and 撤销配对 (revoking the pairing) by the 本地执行器 itself.
// Besides fetching invoice originals (`blobs.ts`), these are the only times the 本地执行器 talks HTTP to the app rather
// than over the channel. Redeeming is the only thing it ever sends without a credential: the 配对码 is the credential,
// once.
//
// The address is not a parameter of the conversation: the install command fixes it, so no one can be talked into
// pointing their 本地执行器 at someone else's server.

export type PairingOutcome = { ok: true; token: string; accountId: string } | { ok: false; code: string; message: string };

export type RedeemOptions = {
  origin: string;
  code: string;
  browser?: string | null;
  version?: string;
  // Injected so the test does not need a network; the 本地执行器 passes the global.
  fetchImpl?: typeof fetch;
};

const NETWORK_REFUSAL = { ok: false as const, code: 'network_error', message: `${APP_UNREACHABLE}然后再点一次配对。` };

export async function redeemPairingCode({ origin, code, browser = null, version = EXECUTOR_VERSION, fetchImpl = fetch }: RedeemOptions): Promise<PairingOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${PAIRING_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, browser, version }),
    });
  } catch {
    return NETWORK_REFUSAL;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = PairingTokenSchema.safeParse(body);
    if (!parsed.success) return { ok: false, code: 'invalid_response', message: '应用回的内容看不懂，请在设置页生成安装命令，重新安装后再试。' };
    return { ok: true, token: parsed.data.token, accountId: parsed.data.accountId };
  }
  // A refusal the server wrote is shown as the server wrote it: the upgrade instructions for a version that is too
  // old are the whole point of that answer.
  const failure = PairingFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, code: failure.data.error.code, message: failure.data.error.message };
  return { ok: false, code: `http_${response.status}`, message: PAIRING_ERRORS.codeInvalid };
}

export type RevokeOptions = { origin: string; token: string; fetchImpl?: typeof fetch };

/**
 * 撤销配对 on the app, with the token being given up as its authority, so the pairing ends on the server and not only
 * in this browser. True when the app no longer holds it: revoked now, or already gone (401). False when the app could
 * not be reached or answered anything else; the pairing may then still be valid there.
 */
export async function revokePairing({ origin, token, fetchImpl = fetch }: RevokeOptions): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}${PAIRING_PATH}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

/** paired carries the account's username, to name it by (#292). */
export type PairingCheck = { state: 'paired'; username: string } | { state: 'not_paired' } | { state: 'unknown' };

export type CheckOptions = { origin: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * Whether the app still honours `token`: 'not_paired' when it answers 401 (revoked from the settings page, replaced by
 * a newer 配对码, or the account deactivated), 'unknown' when it cannot be reached within `timeoutMs` or answers
 * anything else, including a 200 that is not an identity. The stored pairing alone cannot tell a revoked token from a
 * live one; this is how the 本地执行器 avoids announcing a pairing the app no longer has. The app marks every answer
 * as a connection (最近连接 (last connected) on the settings page), so ask only when nothing else settles it.
 */
export async function checkPairing({ origin, token, fetchImpl = fetch, timeoutMs = 800 }: CheckOptions): Promise<PairingCheck> {
  try {
    const response = await fetchImpl(`${origin}${PAIRING_PATH}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) return { state: 'not_paired' };
    if (!response.ok) return { state: 'unknown' };
    const identity = PairingIdentitySchema.safeParse(await response.json().catch(() => null));
    return identity.success ? { state: 'paired', username: identity.data.username } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}
