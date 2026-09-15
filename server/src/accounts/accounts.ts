import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AUTH_ERRORS, type Account, type CredentialsInput } from '@baox/contract';
import type { Db } from '../db/database';
import type { AccountTable } from '../db/schema';
import { hashPassword, verifyPassword } from './password';

// 应用账号 (app accounts) and their server-side sessions (ADR-0018). The first account is the admin; register opens
// after it. A session is a random token held by the browser; the database keeps only its sha256 and a sliding expiry.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A session's expiry is pushed out at most once per this interval, so ordinary requests don't write.
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export type Clock = () => Date;

export class AuthRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SignedIn = { account: Account; token: string };
// `renewed` tells the HTTP layer to re-send the cookie with a fresh Max-Age.
export type SessionLookup = { account: Account; renewed: boolean };

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

function toAccount(row: Pick<AccountTable, 'account_id' | 'username' | 'role'>): Account {
  return { accountId: row.account_id, username: row.username ?? row.account_id, role: row.role };
}

export function createAccountService(db: Db, clock: Clock) {
  const iso = (date: Date) => date.toISOString();

  async function hasAccounts(): Promise<boolean> {
    const row = await db.selectFrom('account').select('account_id').where('username', 'is not', null).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async function openSession(account: Account): Promise<SignedIn> {
    const token = randomBytes(32).toString('base64url');
    const now = clock();
    await db
      .insertInto('session')
      .values({ token_sha256: sha256(token), account_id: account.accountId, created_at: iso(now), expires_at: iso(new Date(now.getTime() + SESSION_TTL_MS)) })
      .execute();
    return { account, token };
  }

  async function createAccount(credentials: CredentialsInput, role: Account['role']): Promise<Account> {
    const taken = await db.selectFrom('account').select('account_id').where('username', '=', credentials.username).executeTakeFirst();
    if (taken) throw new AuthRefusal(409, 'username_taken', AUTH_ERRORS.usernameTaken);
    const account: Account = { accountId: randomUUID(), username: credentials.username, role };
    await db
      .insertInto('account')
      .values({
        account_id: account.accountId,
        display_name: credentials.username,
        username: credentials.username,
        password_hash: await hashPassword(credentials.password),
        role,
        active: 1,
        created_at: iso(clock()),
      })
      .execute();
    return account;
  }

  return {
    hasAccounts,

    // The first account ever becomes the admin; once one exists this is refused.
    async setup(credentials: CredentialsInput): Promise<SignedIn> {
      if (await hasAccounts()) throw new AuthRefusal(409, 'setup_done', AUTH_ERRORS.setupDone);
      return openSession(await createAccount(credentials, 'admin'));
    },

    // Open self-registration, only after the admin exists.
    async register(credentials: CredentialsInput): Promise<SignedIn> {
      if (!(await hasAccounts())) throw new AuthRefusal(409, 'setup_required', AUTH_ERRORS.setupRequired);
      return openSession(await createAccount(credentials, 'user'));
    },

    // Unknown username, wrong password and a deactivated account all get the same answer.
    async login(credentials: CredentialsInput): Promise<SignedIn> {
      const row = await db.selectFrom('account').selectAll().where('username', '=', credentials.username).executeTakeFirst();
      const ok = row?.password_hash && row.active === 1 && (await verifyPassword(credentials.password, row.password_hash));
      if (!row || !ok) throw new AuthRefusal(401, 'invalid_credentials', AUTH_ERRORS.invalidCredentials);
      return openSession(toAccount(row));
    },

    async logout(token: string): Promise<void> {
      await db.deleteFrom('session').where('token_sha256', '=', sha256(token)).execute();
    },

    // The account behind a session token, or null when the token is unknown, expired or its account deactivated.
    // Use slides the expiry forward.
    async lookup(token: string | undefined): Promise<SessionLookup | null> {
      if (!token) return null;
      const now = clock();
      const row = await db
        .selectFrom('session')
        .innerJoin('account', 'account.account_id', 'session.account_id')
        .select(['session.token_sha256', 'session.expires_at', 'account.account_id', 'account.username', 'account.role', 'account.active'])
        .where('session.token_sha256', '=', sha256(token))
        .executeTakeFirst();
      if (!row) return null;
      const expiresAt = Date.parse(row.expires_at);
      if (expiresAt <= now.getTime() || row.active !== 1) {
        await db.deleteFrom('session').where('token_sha256', '=', row.token_sha256).execute();
        return null;
      }
      const renewed = expiresAt - now.getTime() < SESSION_TTL_MS - RENEW_AFTER_MS;
      if (renewed) {
        await db
          .updateTable('session')
          .set({ expires_at: iso(new Date(now.getTime() + SESSION_TTL_MS)) })
          .where('token_sha256', '=', row.token_sha256)
          .execute();
      }
      return { account: toAccount(row), renewed };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
