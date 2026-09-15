import { AUTH_ERRORS, CredentialsInputSchema, UNAUTHENTICATED_CODE, type Account, type Session } from '@baox/contract';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_TTL_MS, type AccountService, type SignedIn } from './accounts';

// Auth over HTTP: the public session/auth endpoints, the session cookie, and the gate every other `/api/*` route sits
// behind. Handlers read who is asking with `accountOf(c)`.

export const SESSION_COOKIE = 'baox_session';

export type AppEnv = { Variables: { account: Account } };

export function accountOf(c: Context<AppEnv>): Account {
  return c.get('account');
}

// HttpOnly + SameSite=Strict; no Secure flag because the server binds 127.0.0.1 over plain HTTP (ADR-0018).
function putCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

const unauthenticated = (c: Context) => c.json({ error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated } }, 401);

export function requireAccount(accounts: AccountService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const found = await accounts.lookup(token);
    if (!found) {
      if (token) deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return unauthenticated(c);
    }
    if (found.renewed && token) putCookie(c, token);
    c.set('account', found.account);
    await next();
  };
}

export function mountAuthRoutes(app: Hono<AppEnv>, accounts: AccountService): void {
  const signedIn = (c: Context, result: SignedIn) => {
    putCookie(c, result.token);
    const session: Session = { status: 'signed_in', account: result.account };
    return c.json(session);
  };

  const withCredentials = (run: (input: { username: string; password: string }) => Promise<SignedIn>) => async (c: Context) => {
    const input = CredentialsInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'invalid_input', message: input.error.issues[0]?.message ?? '请求无效。' } }, 400);
    return signedIn(c, await run(input.data));
  };

  app.get('/api/session', async (c) => {
    const found = await accounts.lookup(getCookie(c, SESSION_COOKIE));
    if (found) return c.json({ status: 'signed_in', account: found.account } satisfies Session);
    return c.json({ status: (await accounts.hasAccounts()) ? 'signed_out' : 'setup_required', account: null } satisfies Session);
  });
  app.post('/api/auth/setup', withCredentials(accounts.setup));
  app.post('/api/auth/register', withCredentials(accounts.register));
  app.post('/api/auth/login', withCredentials(accounts.login));
  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await accounts.logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ status: (await accounts.hasAccounts()) ? 'signed_out' : 'setup_required', account: null } satisfies Session);
  });
}
