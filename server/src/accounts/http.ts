import {
  ADMIN_ERRORS,
  AUTH_ERRORS,
  AccountUpdateInputSchema,
  ChangePasswordInputSchema,
  CredentialsInputSchema,
  PASSWORD_CHANGE_REQUIRED_CODE,
  UNAUTHENTICATED_CODE,
  type Account,
  type Session,
} from '@baox/contract';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_TTL_MS, type AccountService, type SignedIn } from './accounts';

// Auth over HTTP: the public session/auth endpoints, the session cookie, and the gate every other `/api/*` route sits
// behind. Handlers read who is asking with `accountOf(c)`.

export const SESSION_COOKIE = 'baox_session';
// The only session route open to an account that still has to replace its temporary password.
export const CHANGE_PASSWORD_PATH = '/api/auth/change-password';

export type AppEnv = { Variables: { account: Account } };

export function accountOf(c: Context<AppEnv>): Account {
  return c.get('account');
}

// HttpOnly + SameSite=Strict; no Secure flag because the server binds 127.0.0.1 over plain HTTP (ADR-0018).
function putCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

const unauthenticated = (c: Context) => c.json({ error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated } }, 401);

const sessionOf = (account: Account, mustChangePassword: boolean): Session => ({ status: mustChangePassword ? 'password_change_required' : 'signed_in', account });

export function requireAccount(accounts: AccountService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const found = await accounts.lookup(token);
    if (!found) {
      if (token) deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return unauthenticated(c);
    }
    if (found.renewed && token) putCookie(c, token);
    if (found.mustChangePassword && c.req.path !== CHANGE_PASSWORD_PATH) {
      return c.json({ error: { code: PASSWORD_CHANGE_REQUIRED_CODE, message: ADMIN_ERRORS.passwordChangeRequired } }, 403);
    }
    c.set('account', found.account);
    await next();
  };
}

const invalid = (c: Context, message: string | undefined) => c.json({ error: { code: 'invalid_input', message: message ?? '请求无效。' } }, 400);

export function mountAuthRoutes(app: Hono<AppEnv>, accounts: AccountService): void {
  const signedIn = (c: Context, result: SignedIn) => {
    putCookie(c, result.token);
    return c.json(sessionOf(result.account, result.mustChangePassword));
  };

  const withCredentials = (run: (input: { username: string; password: string }) => Promise<SignedIn>) => async (c: Context) => {
    const input = CredentialsInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c, input.error.issues[0]?.message);
    return signedIn(c, await run(input.data));
  };

  app.get('/api/session', async (c) => {
    const found = await accounts.lookup(getCookie(c, SESSION_COOKIE));
    if (found) return c.json(sessionOf(found.account, found.mustChangePassword));
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

// Session routes behind the gate: changing one's own password, and the admin's account management.
// Mount after `app.use('/api/*', requireAccount(...))`.
export function mountAccountRoutes(app: Hono<AppEnv>, accounts: AccountService): void {
  app.post(CHANGE_PASSWORD_PATH, async (c) => {
    const input = ChangePasswordInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return invalid(c, input.error.issues[0]?.message);
    const account = accountOf(c);
    await accounts.changePassword(account.accountId, input.data);
    return c.json(sessionOf(account, false));
  });

  const forbidden = (c: Context<AppEnv>) => c.json({ error: { code: 'forbidden', message: ADMIN_ERRORS.forbidden } }, 403);
  app.get('/api/admin/accounts', async (c) => (accountOf(c).role === 'admin' ? c.json(await accounts.list()) : forbidden(c)));
  app.post('/api/admin/accounts/:id', async (c) => {
    if (accountOf(c).role !== 'admin') return forbidden(c);
    const input = AccountUpdateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: 'invalid_input', message: input.error.issues[0]?.message ?? '请求无效。' }, accounts: (await accounts.list()).accounts }, 400);
    return c.json(await accounts.update(accountOf(c), c.req.param('id'), input.data));
  });
}
