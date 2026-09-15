import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ADMIN_ERRORS, AUTH_ERRORS, type Account, type AccountList, type AccountUpdateInput, type ChangePasswordInput, type CredentialsInput } from '@baox/contract';
import type { Db } from '../db/database';
import type { AccountEventAction, AccountTable } from '../db/schema';
import { hashPassword, verifyPassword } from './password';

// 应用账号 (app accounts) and their server-side sessions (ADR-0018). The first account is the admin; register opens
// after it. A session is a random token held by the browser; the database keeps only its sha256 and a sliding expiry.
// Admins promote/demote, deactivate/reactivate and set temporary passwords; at least one active admin always remains.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A session's expiry is pushed out at most once per this interval, so ordinary requests don't write.
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export type Clock = () => Date;

export class AuthRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// `mustChangePassword`: the account signed in with a temporary password; only change-password is open to it.
export type SignedIn = { account: Account; token: string; mustChangePassword: boolean };
// `renewed` tells the HTTP layer to re-send the cookie with a fresh Max-Age.
export type SessionLookup = { account: Account; renewed: boolean; mustChangePassword: boolean };

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

function toAccount(row: Pick<AccountTable, 'account_id' | 'username' | 'role'>): Account {
  return { accountId: row.account_id, username: row.username ?? row.account_id, role: row.role };
}

// Readable temporary password for the CLI (no look-alike characters).
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...randomBytes(12)].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function recordEvent(db: Db, accountId: string, actorAccountId: string | null, action: AccountEventAction, at: string): Promise<void> {
  await db.insertInto('account_event').values({ event_id: randomUUID(), account_id: accountId, actor_account_id: actorAccountId, action, created_at: at }).execute();
}

// Sets a temporary password that must be changed at next login, and signs the account out everywhere.
async function setTemporaryPassword(db: Db, accountId: string, password: string, actorAccountId: string | null, at: string): Promise<void> {
  await db.updateTable('account').set({ password_hash: await hashPassword(password), must_change_password: 1 }).where('account_id', '=', accountId).execute();
  await db.deleteFrom('session').where('account_id', '=', accountId).execute();
  await recordEvent(db, accountId, actorAccountId, actorAccountId === null ? 'cli_reset_password' : 'temporary_password', at);
}

// `baox admin reset-password <username>`: the local fallback for a locked-out (sole) admin. Access to the machine is
// the authority, so no session is needed. Returns the temporary password to show, or null for an unknown username.
export async function resetPasswordLocally(db: Db, username: string, password = generateTemporaryPassword(), now: Clock = () => new Date()): Promise<string | null> {
  const row = await db.selectFrom('account').select('account_id').where('username', '=', username).executeTakeFirst();
  if (!row) return null;
  await setTemporaryPassword(db, row.account_id, password, null, now().toISOString());
  return password;
}

export function createAccountService(db: Db, clock: Clock) {
  const iso = (date: Date) => date.toISOString();

  async function hasAccounts(): Promise<boolean> {
    const row = await db.selectFrom('account').select('account_id').where('username', 'is not', null).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async function openSession(account: Account, mustChangePassword = false): Promise<SignedIn> {
    const token = randomBytes(32).toString('base64url');
    const now = clock();
    await db
      .insertInto('session')
      .values({ token_sha256: sha256(token), account_id: account.accountId, created_at: iso(now), expires_at: iso(new Date(now.getTime() + SESSION_TTL_MS)) })
      .execute();
    return { account, token, mustChangePassword };
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
        must_change_password: 0,
        created_at: iso(clock()),
      })
      .execute();
    return account;
  }

  // Every account with credentials, admins first, then by creation.
  async function list(): Promise<AccountList> {
    const rows = await db.selectFrom('account').selectAll().where('username', 'is not', null).orderBy('created_at').orderBy('username').execute();
    const accounts = rows.map((row) => ({ ...toAccount(row), active: row.active === 1, mustChangePassword: row.must_change_password === 1 }));
    return { accounts: [...accounts.filter((a) => a.role === 'admin'), ...accounts.filter((a) => a.role !== 'admin')] };
  }

  return {
    hasAccounts,
    list,

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
      return openSession(toAccount(row), row.must_change_password === 1);
    },

    async logout(token: string): Promise<void> {
      await db.deleteFrom('session').where('token_sha256', '=', sha256(token)).execute();
    },

    // Replaces the signed-in account's password after checking the current one; clears a temporary password.
    async changePassword(accountId: string, input: ChangePasswordInput): Promise<void> {
      const row = await db.selectFrom('account').selectAll().where('account_id', '=', accountId).executeTakeFirst();
      if (!row?.password_hash || !(await verifyPassword(input.currentPassword, row.password_hash))) throw new AuthRefusal(400, 'wrong_password', ADMIN_ERRORS.wrongPassword);
      if (input.newPassword === input.currentPassword) throw new AuthRefusal(400, 'same_password', ADMIN_ERRORS.samePassword);
      await db.updateTable('account').set({ password_hash: await hashPassword(input.newPassword), must_change_password: 0 }).where('account_id', '=', accountId).execute();
      await recordEvent(db, accountId, accountId, 'password_changed', iso(clock()));
    },

    // One admin change to another account (or oneself). Refuses anything that would leave no active admin.
    async update(actor: Account, accountId: string, change: AccountUpdateInput): Promise<AccountList> {
      if (actor.role !== 'admin') throw new AuthRefusal(403, 'forbidden', ADMIN_ERRORS.forbidden);
      const at = iso(clock());
      await db.transaction().execute(async (tx) => {
        const target = await tx.selectFrom('account').selectAll().where('account_id', '=', accountId).where('username', 'is not', null).executeTakeFirst();
        if (!target) throw new AuthRefusal(404, 'account_not_found', ADMIN_ERRORS.accountNotFound);
        const wouldDropAdmin = target.role === 'admin' && target.active === 1 && (('role' in change && change.role === 'user') || ('active' in change && !change.active));
        if (wouldDropAdmin) {
          const admins = await tx.selectFrom('account').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'admin').where('active', '=', 1).executeTakeFirstOrThrow();
          if (Number(admins.n) <= 1) throw new AuthRefusal(400, 'last_admin', ADMIN_ERRORS.lastAdmin);
        }
        if ('role' in change) {
          if (change.role === target.role) return;
          await tx.updateTable('account').set({ role: change.role }).where('account_id', '=', accountId).execute();
          await recordEvent(tx, accountId, actor.accountId, change.role === 'admin' ? 'promoted' : 'demoted', at);
        } else if ('active' in change) {
          if ((target.active === 1) === change.active) return;
          await tx.updateTable('account').set({ active: change.active ? 1 : 0 }).where('account_id', '=', accountId).execute();
          // A deactivated account is signed out at once; its tasks, audit records and occupancy stay untouched.
          if (!change.active) await tx.deleteFrom('session').where('account_id', '=', accountId).execute();
          await recordEvent(tx, accountId, actor.accountId, change.active ? 'reactivated' : 'deactivated', at);
        } else {
          await setTemporaryPassword(tx, accountId, change.temporaryPassword, actor.accountId, at);
        }
      });
      return list();
    },

    // The account behind a session token, or null when the token is unknown, expired or its account deactivated.
    // Use slides the expiry forward.
    async lookup(token: string | undefined): Promise<SessionLookup | null> {
      if (!token) return null;
      const now = clock();
      const row = await db
        .selectFrom('session')
        .innerJoin('account', 'account.account_id', 'session.account_id')
        .select(['session.token_sha256', 'session.expires_at', 'account.account_id', 'account.username', 'account.role', 'account.active', 'account.must_change_password'])
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
      return { account: toAccount(row), renewed, mustChangePassword: row.must_change_password === 1 };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
