import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ADMIN_ERRORS, AUTH_ERRORS, type Account, type AccountList, type AccountUpdateInput, type ChangePasswordInput, type CredentialsInput } from '@baox/contract';
import type { Db } from '../db/database';
import type { AccountEventAction, AccountTable } from '../db/schema';
import type { MaintenanceWriteAdmission } from '../maintenance';
import { hashPassword, verifyPassword } from './password';

// App accounts (应用账号) and their server-side sessions (ADR-0018). The first account is an approved admin; later
// registrations wait for an explicit administrator approval. A session is a random token held by the browser; the
// database keeps only its sha256 and a sliding expiry. Admins promote/demote, deactivate/reactivate and set temporary
// passwords; at least one approved, active admin always remains.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A session's expiry is pushed out at most once per this interval, so ordinary requests don't write.
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export type Clock = () => Date;

export class AuthRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
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

// Readable temporary password for the emergency CLI (no look-alike characters).
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

// The emergency CLI (`baox admin emergency-reset <username>`, ADR-0018 as amended by #228 and spec #246 story 42): the
// way back in for an administrator locked out of their own account. A command line has no session, so "their own" is
// made unambiguous by refusing unless the target is the only active administrator: a sole administrator locked out is
// by definition the person at the shell, and with two or more the other one resets you in the web UI. Anything wider
// would let a shell on a shared host take over another administrator, or any 应用账号 (app account). Access to the
// machine is the authority, so no session is needed, and the audit record it writes carries no actor.
export type EmergencyReset = { temporaryPassword: string } | { refused: 'unknown_account' | 'not_admin' | 'not_sole_admin' };

export async function emergencyResetAdminPassword(db: Db, username: string, password = generateTemporaryPassword(), now: Clock = () => new Date()): Promise<EmergencyReset> {
  return db.transaction().execute(async (tx): Promise<EmergencyReset> => {
    const row = await tx.selectFrom('account').select(['account_id', 'role', 'active', 'approved']).where('username', '=', username).executeTakeFirst();
    if (!row) return { refused: 'unknown_account' };
    if (row.role !== 'admin') return { refused: 'not_admin' };
    // The same "active administrator" the last-admin guard in `update` counts.
    const admins = await tx.selectFrom('account').select('account_id').where('role', '=', 'admin').where('active', '=', 1).where('approved', '=', 1).execute();
    if (admins.length !== 1 || admins[0]?.account_id !== row.account_id) return { refused: 'not_sole_admin' };
    await setTemporaryPassword(tx, row.account_id, password, null, now().toISOString());
    return { temporaryPassword: password };
  });
}

export function createAccountService(db: Db, clock: Clock, acquireWrite: MaintenanceWriteAdmission = () => ({ release: () => undefined })) {
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

  // Takes the password already hashed and runs inside the caller's transaction: scrypt is slow enough that two
  // requests racing between the check and the insert would otherwise both pass it.
  async function insertAccount(tx: Db, credentials: CredentialsInput, passwordHash: string, role: Account['role'], approved: boolean, at: string): Promise<Account> {
    const taken = await tx.selectFrom('account').select('account_id').where('username', '=', credentials.username).executeTakeFirst();
    if (taken) throw new AuthRefusal(409, 'username_taken', AUTH_ERRORS.usernameTaken);
    const account: Account = { accountId: randomUUID(), username: credentials.username, role };
    await tx
      .insertInto('account')
      .values({
        account_id: account.accountId,
        display_name: credentials.username,
        username: credentials.username,
        password_hash: passwordHash,
        role,
        active: 1,
        approved: approved ? 1 : 0,
        must_change_password: 0,
        created_at: at,
      })
      .execute();
    return account;
  }

  async function firstAccount(tx: Db): Promise<boolean> {
    return (await tx.selectFrom('account').select('account_id').where('username', 'is not', null).limit(1).executeTakeFirst()) === undefined;
  }

  // Every account with credentials, admins first, then by creation.
  async function list(): Promise<AccountList> {
    const rows = await db.selectFrom('account').selectAll().where('username', 'is not', null).orderBy('created_at').orderBy('username').execute();
    const accounts = rows.map((row) => ({ ...toAccount(row), active: row.active === 1, approved: row.approved === 1, mustChangePassword: row.must_change_password === 1 }));
    return { accounts: [...accounts.filter((a) => a.role === 'admin'), ...accounts.filter((a) => a.role !== 'admin')] };
  }

  return {
    hasAccounts,
    list,

    // The first account ever becomes the admin; once one exists this is refused. The check and the insert are one
    // transaction, so two concurrent setups cannot both become admin. `onCreated` (the one-time legacy import,
    // ADR-0018) runs inside that same transaction: the machine gets its admin together with its legacy data, or
    // neither. Failing between the two would leave an admin with no `import_run` row, and the import could then never
    // run, because setup refuses every later attempt with `setup_done`.
    async setup(credentials: CredentialsInput, onCreated?: (tx: Db, accountId: string) => Promise<void>): Promise<SignedIn> {
      const passwordHash = await hashPassword(credentials.password);
      const at = iso(clock());
      const account = await db.transaction().execute(async (tx) => {
        if (!(await firstAccount(tx))) throw new AuthRefusal(409, 'setup_done', AUTH_ERRORS.setupDone);
        const created = await insertAccount(tx, credentials, passwordHash, 'admin', true, at);
        await onCreated?.(tx, created.accountId);
        return created;
      });
      return openSession(account);
    },

    // Open self-registration, only after the first administrator exists. A registration creates no session: it waits
    // for an administrator's separately audited approval before credentials can open one.
    async register(credentials: CredentialsInput): Promise<void> {
      const passwordHash = await hashPassword(credentials.password);
      const at = iso(clock());
      await db.transaction().execute(async (tx) => {
        if (await firstAccount(tx)) throw new AuthRefusal(409, 'setup_required', AUTH_ERRORS.setupRequired);
        await insertAccount(tx, credentials, passwordHash, 'user', false, at);
      });
    },

    // A pending account learns its status only after proving its password. Unknown usernames, wrong passwords and
    // deactivated accounts retain the generic answer.
    async login(credentials: CredentialsInput): Promise<SignedIn> {
      const row = await db.selectFrom('account').selectAll().where('username', '=', credentials.username).executeTakeFirst();
      if (!row?.password_hash || !(await verifyPassword(credentials.password, row.password_hash))) throw new AuthRefusal(401, 'invalid_credentials', AUTH_ERRORS.invalidCredentials);
      if (row.approved !== 1) throw new AuthRefusal(403, 'pending_approval', AUTH_ERRORS.pendingApproval);
      if (row.active !== 1) throw new AuthRefusal(401, 'invalid_credentials', AUTH_ERRORS.invalidCredentials);
      return openSession(toAccount(row), row.must_change_password === 1);
    },

    async logout(token: string): Promise<void> {
      await db.deleteFrom('session').where('token_sha256', '=', sha256(token)).execute();
    },

    // Replaces the signed-in account's password after checking the current one; clears a temporary password.
    // Every other session of the account is dropped: whoever knew the old password (or was handed a temporary one)
    // must not keep an open session afterwards. `keepToken` is the caller's own session, which stays signed in.
    async changePassword(accountId: string, input: ChangePasswordInput, keepToken?: string): Promise<void> {
      const row = await db.selectFrom('account').selectAll().where('account_id', '=', accountId).executeTakeFirst();
      if (!row?.password_hash || !(await verifyPassword(input.currentPassword, row.password_hash))) throw new AuthRefusal(400, 'wrong_password', ADMIN_ERRORS.wrongPassword);
      if (input.newPassword === input.currentPassword) throw new AuthRefusal(400, 'same_password', ADMIN_ERRORS.samePassword);
      const passwordHash = await hashPassword(input.newPassword);
      await db.transaction().execute(async (tx) => {
        // Keep a concurrent password change from accepting credentials that are no longer current.
        const changed = await tx.updateTable('account').set({ password_hash: passwordHash, must_change_password: 0 })
          .where('account_id', '=', accountId).where('password_hash', '=', row.password_hash).executeTakeFirst();
        if (changed.numUpdatedRows !== 1n) throw new AuthRefusal(400, 'wrong_password', ADMIN_ERRORS.wrongPassword);
        let drop = tx.deleteFrom('session').where('account_id', '=', accountId);
        if (keepToken) drop = drop.where('token_sha256', '!=', sha256(keepToken));
        await drop.execute();
        await recordEvent(tx, accountId, accountId, 'password_changed', iso(clock()));
      });
    },

    // One admin change to another account (or oneself). Refuses anything that would leave no active admin.
    async update(actor: Account, accountId: string, change: AccountUpdateInput): Promise<AccountList> {
      if (actor.role !== 'admin') throw new AuthRefusal(403, 'forbidden', ADMIN_ERRORS.forbidden);
      const at = iso(clock());
      await db.transaction().execute(async (tx) => {
        const target = await tx.selectFrom('account').selectAll().where('account_id', '=', accountId).where('username', 'is not', null).executeTakeFirst();
        if (!target) throw new AuthRefusal(404, 'account_not_found', ADMIN_ERRORS.accountNotFound);
        if ('approved' in change) {
          if (target.approved === 1) return;
          await tx.updateTable('account').set({ approved: 1 }).where('account_id', '=', accountId).execute();
          await recordEvent(tx, accountId, actor.accountId, 'approved', at);
          return;
        }
        // Do not let activation, promotion, or a password reset become a second path to usable credentials.
        if (target.approved !== 1) throw new AuthRefusal(400, 'approval_required', ADMIN_ERRORS.approvalRequired);
        const givingUpAdmin = ('role' in change && change.role === 'user') || ('active' in change && !change.active);
        const wouldDropAdmin = target.role === 'admin' && target.active === 1 && target.approved === 1 && givingUpAdmin;
        if (wouldDropAdmin) {
          const admins = await tx.selectFrom('account').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'admin').where('active', '=', 1).where('approved', '=', 1).executeTakeFirstOrThrow();
          if (Number(admins.n) <= 1) throw new AuthRefusal(400, 'last_admin', ADMIN_ERRORS.lastAdmin);
        }
        // Checked after the last-admin guard, so the sole admin still gets the more informative `last_admin`: an admin
        // never takes their own admin rights or their own access away. The guard above only catches the case where
        // nobody else is left, so with a colleague around an admin could otherwise lock themselves out of the machine
        // they administer with one click. Another admin does it for them.
        if (accountId === actor.accountId && givingUpAdmin) throw new AuthRefusal(400, 'self_change', ADMIN_ERRORS.selfChange);
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

    // The account behind a session token, or null when the token is unknown, expired, pending approval or deactivated.
    // Use slides the expiry forward.
    async lookup(token: string | undefined): Promise<SessionLookup | null> {
      if (!token) return null;
      const now = clock();
      const row = await db
        .selectFrom('session')
        .innerJoin('account', 'account.account_id', 'session.account_id')
        .select(['session.token_sha256', 'session.expires_at', 'account.account_id', 'account.username', 'account.role', 'account.active', 'account.approved', 'account.must_change_password'])
        .where('session.token_sha256', '=', sha256(token))
        .executeTakeFirst();
      if (!row) return null;
      const expiresAt = Date.parse(row.expires_at);
      if (expiresAt <= now.getTime() || row.active !== 1 || row.approved !== 1) {
        // A GET and SSE heartbeat normally clean expired sessions. Once maintenance has closed the write boundary,
        // authentication may still deny the token, but this optional housekeeping write must wait for reopening.
        const maintenance = acquireWrite();
        if (maintenance) {
          try {
            await db.deleteFrom('session').where('token_sha256', '=', row.token_sha256).execute();
          } finally {
            maintenance.release();
          }
        }
        return null;
      }
      const renewed = expiresAt - now.getTime() < SESSION_TTL_MS - RENEW_AFTER_MS;
      if (renewed) {
        // Sliding the expiry is optional: returning the existing authenticated session avoids turning a read into a
        // maintenance bypass. `renewed` remains false, so the HTTP layer does not send a longer-lived cookie either.
        const maintenance = acquireWrite();
        if (!maintenance) return { account: toAccount(row), renewed: false, mustChangePassword: row.must_change_password === 1 };
        try {
          await db
            .updateTable('session')
            .set({ expires_at: iso(new Date(now.getTime() + SESSION_TTL_MS)) })
            .where('token_sha256', '=', row.token_sha256)
            .execute();
        } finally {
          maintenance.release();
        }
      }
      return { account: toAccount(row), renewed, mustChangePassword: row.must_change_password === 1 };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
