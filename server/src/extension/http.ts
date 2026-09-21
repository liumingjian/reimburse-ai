import { EXTENSION_MINIMUM_VERSION, EXTENSION_PAIRING_ERRORS, EXTENSION_PAIR_PATH, EXTENSION_VERSION_TOO_OLD_CODE, ExtensionPairInputSchema, extensionVersionRefusal, HTTP_ENDPOINTS } from '@baox/contract';
import type { Context, Hono } from 'hono';
import { AuthRefusal } from '../accounts/accounts';
import { accountOf, type AppEnv } from '../accounts/http';
import type { PairingService } from './pairing';

// 扩展配对 over HTTP, in two halves that never share a credential.
//
// The settings page's half sits behind the session gate like every other `/api/*` route. The extension's half is
// EXTENSION_PAIR_PATH, mounted before that gate: the extension has no session and must not be given one, because a
// pairing outlives every login (ADR-0019). It proves itself with the 配对码 it was typed, and afterwards with its
// own token in `Authorization: Bearer`.
//
// Version negotiation happens here as well as on the channel (ADR-0021). Refusing at pairing is what makes the
// refusal legible: an employee who has just typed a 配对码 is watching the popup, and gets told to update before an
// unusable pairing is written down at all.

const PAIRING_PATH = HTTP_ENDPOINTS.getExtensionPairing.path;

function bearer(c: Context): string | undefined {
  const [scheme, value] = (c.req.header('authorization') ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

// Mount before `requireAccount`: these two carry no cookie. The exact-origin guard in `app.ts` lets the redemption
// through because the 配对码 in the body is its whole authority, so a page on another origin gains nothing by
// posting one it does not have.
export function mountExtensionPairRoutes(app: Hono<AppEnv>, pairings: PairingService, minimumVersion: string = EXTENSION_MINIMUM_VERSION): void {
  app.post(EXTENSION_PAIR_PATH, async (c) => {
    const input = ExtensionPairInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthRefusal(401, 'pairing_code_invalid', EXTENSION_PAIRING_ERRORS.codeInvalid);
    // Before the code is spent: a 配对码 burnt by an extension that then cannot connect would leave the employee
    // issuing a second one for no reason.
    const tooOld = extensionVersionRefusal(input.data.version, minimumVersion);
    if (tooOld) throw new AuthRefusal(403, EXTENSION_VERSION_TOO_OLD_CODE, tooOld);
    return c.json(await pairings.redeem(input.data.code, input.data.browser ?? null, input.data.version ?? null));
  });

  // What the extension asks to find out whether it is still paired, and which 应用账号 it acts for.
  app.get(EXTENSION_PAIR_PATH, async (c) => {
    const found = await pairings.lookup(bearer(c));
    if (!found) return c.json({ error: { code: 'not_paired', message: EXTENSION_PAIRING_ERRORS.notPaired } }, 401);
    return c.json(found);
  });
}

// Mount after `requireAccount`: the settings page's view of its own account's pairing.
export function mountPairingRoutes(app: Hono<AppEnv>, pairings: PairingService): void {
  app.get(PAIRING_PATH, async (c) => c.json(await pairings.view(accountOf(c).accountId)));
  app.post(HTTP_ENDPOINTS.createExtensionPairingCode.path, async (c) => c.json(await pairings.issue(accountOf(c).accountId)));
  app.post(HTTP_ENDPOINTS.revokeExtensionPairing.path, async (c) => c.json(await pairings.revoke(accountOf(c).accountId)));
}
