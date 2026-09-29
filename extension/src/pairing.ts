import { EXTENSION_PAIRING_ERRORS, EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingFailureSchema, ExtensionTokenSchema } from '@baox/contract';
import { APP_UNREACHABLE } from './messages';

// Redeeming the 配对码 (pairing code) the employee typed into the popup, and 撤销配对 (revoking the pairing) from it.
// Besides fetching invoice originals (`blobs.ts`), these are the only times the extension talks HTTP to the app rather
// than over the channel. Redeeming is the only thing it ever sends without a credential: the 配对码 is the credential,
// once.
//
// The address is not a parameter of the conversation. It is baked into the build (`origin.ts`) and the popup has no
// field for it, so no one can be talked into pointing their extension at someone else's server.

export type PairingOutcome = { ok: true; token: string; accountId: string } | { ok: false; code: string; message: string };

export type RedeemOptions = {
  origin: string;
  code: string;
  browser?: string | null;
  version?: string;
  // Injected so the test does not need a network; the service worker passes the global.
  fetchImpl?: typeof fetch;
};

const NETWORK_REFUSAL = { ok: false as const, code: 'network_error', message: `${APP_UNREACHABLE}然后再点一次配对。` };

export async function redeemPairingCode({ origin, code, browser = null, version = EXTENSION_VERSION, fetchImpl = fetch }: RedeemOptions): Promise<PairingOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}${EXTENSION_PAIR_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, browser, version }),
    });
  } catch {
    return NETWORK_REFUSAL;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = ExtensionTokenSchema.safeParse(body);
    if (!parsed.success) return { ok: false, code: 'invalid_response', message: '应用回的内容看不懂，请更新扩展后再试。' };
    return { ok: true, token: parsed.data.token, accountId: parsed.data.accountId };
  }
  // A refusal the server wrote is shown as the server wrote it: the upgrade instructions for a version that is too
  // old are the whole point of that answer.
  const failure = ExtensionPairingFailureSchema.safeParse(body);
  if (failure.success) return { ok: false, code: failure.data.error.code, message: failure.data.error.message };
  return { ok: false, code: `http_${response.status}`, message: EXTENSION_PAIRING_ERRORS.codeInvalid };
}

export type RevokeOptions = { origin: string; token: string; fetchImpl?: typeof fetch };

/**
 * 撤销配对 on the app, with the token being given up as its authority, so the pairing ends on the server and not only
 * in this browser. True when the app no longer holds it: revoked now, or already gone (401). False when the app could
 * not be reached or answered anything else; the pairing may then still be valid there.
 */
export async function revokePairing({ origin, token, fetchImpl = fetch }: RevokeOptions): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}${EXTENSION_PAIR_PATH}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

export type PairingCheck = 'paired' | 'not_paired' | 'unknown';

export type CheckOptions = { origin: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number };

/**
 * Whether the app still honours `token`: 'not_paired' when it answers 401 (revoked from the settings page, replaced by
 * a newer 配对码, or the account deactivated), 'unknown' when it cannot be reached within `timeoutMs` or answers
 * anything else. The stored pairing alone cannot tell a revoked token from a live one; this is how the page bridge
 * avoids announcing a pairing the app no longer has.
 */
export async function checkPairing({ origin, token, fetchImpl = fetch, timeoutMs = 800 }: CheckOptions): Promise<PairingCheck> {
  try {
    const response = await fetchImpl(`${origin}${EXTENSION_PAIR_PATH}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) return 'not_paired';
    return response.ok ? 'paired' : 'unknown';
  } catch {
    return 'unknown';
  }
}
