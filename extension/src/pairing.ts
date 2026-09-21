import { EXTENSION_PAIRING_ERRORS, EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingFailureSchema, ExtensionTokenSchema } from '@baox/contract';

// Redeeming the 配对码 (pairing code) the employee typed into the popup. This is the only moment the extension talks
// HTTP to the app rather than over the channel, and the only thing it ever sends without a credential: the 配对码 is
// the credential, once.
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

const NETWORK_REFUSAL = { ok: false as const, code: 'network_error', message: '连不上应用。请确认你在公司网络里，应用也开着，然后再试一次。' };

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
