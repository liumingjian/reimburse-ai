import { CreatePairingCodeInputSchema, MINIMUM_CLIENT_VERSION, PAIRING_ERRORS, PAIRING_PATH, CLIENT_VERSION_TOO_OLD_CODE, PairingInputSchema, clientVersionRefusal, HTTP_ENDPOINTS, type PairingState } from '@baox/contract';
import type { Context, Hono } from 'hono';
import { AuthRefusal } from '../accounts/accounts';
import { accountOf, type AppEnv } from '../accounts/http';
import { activeOrigin, type PublicOrigin } from '../public-origin';
import type { PairingService } from './pairing';

// 配对 over HTTP, in two halves that never share a credential.
//
// The settings page's half sits behind the session gate like every other `/api/*` route. The 本地执行器's half is
// PAIRING_PATH, mounted before that gate: the 本地执行器 has no session and must not be given one, because a
// pairing outlives every login (ADR-0019). It proves itself with the 配对码 it was typed, and afterwards with its
// own token in `Authorization: Bearer`.
//
// Version negotiation happens here as well as on the channel (ADR-0021). Refusing at pairing is what makes the
// refusal legible: an employee who has just typed a 配对码 is watching the install, and gets told to update before an
// unusable pairing is written down at all.

const SETTINGS_PAIRING_PATH = HTTP_ENDPOINTS.getPairing.path;
const INSTALL_SYSTEM_INVALID = '请选择 Mac 或 Windows。';

export function bearer(c: Context): string | undefined {
  const [scheme, value] = (c.req.header('authorization') ?? '').split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

// Mount before `requireAccount`: these carry no cookie. The exact-origin guard in `app.ts` lets the redemption
// through because the 配对码 in the body is its whole authority, so a page on another origin gains nothing by
// posting one it does not have.
export function mountClientPairRoutes(app: Hono<AppEnv>, pairings: PairingService, minimumVersion: string = MINIMUM_CLIENT_VERSION): void {
  // No rate limit, deliberately. A 配对码 is 8 characters from a 31-letter alphabet (about 8.5e11 codes), good for ten
  // minutes and for one redemption, and only exists while an employee is pairing; guessing one live code in that window
  // takes hundreds of billions of requests, far past what this host could answer. A limiter would add state for no
  // margin that matters. Revisit if codes get shorter or longer-lived.
  app.post(PAIRING_PATH, async (c) => {
    const input = PairingInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthRefusal(401, 'pairing_code_invalid', PAIRING_ERRORS.codeInvalid);
    // Before the code is spent: a 配对码 burnt by a 本地执行器 that then cannot connect would leave the employee
    // issuing a second one for no reason.
    const tooOld = clientVersionRefusal(input.data.version, minimumVersion);
    if (tooOld) throw new AuthRefusal(403, CLIENT_VERSION_TOO_OLD_CODE, tooOld);
    return c.json(await pairings.redeem(input.data.code, input.data.browser ?? null, input.data.version ?? null));
  });

  // What the 本地执行器 asks to find out whether it is still paired, and which 应用账号 it acts for.
  app.get(PAIRING_PATH, async (c) => {
    const found = await pairings.lookup(bearer(c));
    if (!found) return c.json({ error: { code: 'not_paired', message: PAIRING_ERRORS.notPaired } }, 401);
    return c.json(found);
  });

  // 撤销配对 from the 本地执行器 itself: the same revocation as the settings page's, so the server never keeps a
  // pairing the employee believes is gone. The bearer token is its whole authority, as for GET.
  app.delete(PAIRING_PATH, async (c) => {
    if (!(await pairings.revokeToken(bearer(c)))) return c.json({ error: { code: 'not_paired', message: PAIRING_ERRORS.notPaired } }, 401);
    return c.json({ revoked: true });
  });
}

// Mount after `requireAccount`: the settings page's view of its own account's pairing. The application origin comes
// from the parsed deployment configuration, the address the install command points the 本地执行器 at.
export function mountPairingRoutes(app: Hono<AppEnv>, pairings: PairingService, publicOrigin: PublicOrigin | null): void {
  const view = (c: Context, pairing: PairingState) => ({ ...pairing, activeOrigin: activeOrigin(publicOrigin, c.req.url) });
  app.get(SETTINGS_PAIRING_PATH, async (c) => c.json(view(c, await pairings.view(accountOf(c).accountId))));
  // The body may name the system the code is for (the one-command install, #425); a code that re-pairs a running
  // 本地执行器 through 47319 names none.
  app.post(HTTP_ENDPOINTS.createPairingCode.path, async (c) => {
    const input = CreatePairingCodeInputSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
    if (!input.success) return c.json({ error: { code: 'invalid_input', message: INSTALL_SYSTEM_INVALID } }, 400);
    return c.json(view(c, await pairings.issue(accountOf(c).accountId, input.data.system ?? null)));
  });
  app.post(HTTP_ENDPOINTS.revokePairing.path, async (c) => c.json(view(c, await pairings.revoke(accountOf(c).accountId))));
}
