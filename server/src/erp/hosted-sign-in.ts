// ERP 凭据 (ADR-0033): the employee's ERP account and password, hosted here for the baox 本地执行器 on their PC.
//
// - Saved from the employee's own settings page, the password sealed with the server's key (`credential-vault.ts`),
//   and never answered back: the view carries the ERP account and the status only.
// - Every save is followed by a 试登录, run by the account's paired 本地执行器 on the PC (10.250.0.222 never drives ERP),
//   so ERP 自动化授权 holds only once ERP has accepted the password on that PC.
// - A login ERP refuses — at the 试登录 or in a job — deletes the password at once. baox never tries a refused
//   password again, so it cannot lock the ERP account; the employee saves a new one.
// - A job is given the 凭据 only when they are authorised. Every pairing is a 本地执行器's (ADR-0037), and every job
//   signs in with them.

import {
  ERP_CREDENTIAL_ERRORS, type ErpCredentialsView, type SaveErpCredentialsInput,
} from '@baox/contract';
import { EXECUTOR_METHODS, SIGN_IN_REFUSED_CODE, TrySignInAnswerSchema, type TrySignInAnswer, type TrySignInRequest } from '@baox/erp-executor/wire';
import type { ErpCredentials } from '@baox/erp-executor/sign-in';
import { AuthRefusal, type Clock } from '../accounts/accounts';
import type { Db } from '../db/database';
import type { MaintenanceWriteAdmission } from '../maintenance';
import { EXECUTOR_OFFLINE_CODE, ChannelError } from '../channel/channel';
import { hasPairing } from '../channel/pairing';
import type { CredentialVault } from './credential-vault';

// A cold 本地执行器 has measured up to about a minute to sign in (erp-headless-v1.md); five leaves room for a slow link.
export const TRIAL_TIMEOUT_MS = 5 * 60_000;

export type ErpCredentialPorts = {
  db: Db;
  clock: Clock;
  /** Null when the server has no key: nothing can be saved, and no job is given any 凭据. */
  vault: CredentialVault | null;
  erpOrigin: string;
  /** Ask the account's paired executor; rejects with `executor_offline` when nothing is connected. */
  request(accountId: string, method: string, payload: TrySignInRequest): Promise<unknown>;
  /** Whether a job of this account holds ERP right now: a 试登录 would knock it off. */
  erpBusy(accountId: string): boolean;
  /** Admission for the write a job's refused login makes, outside any request. */
  acquireWrite?: MaintenanceWriteAdmission;
  trialTimeoutMs?: number;
};

export type ErpCredentialService = ReturnType<typeof createErpCredentialService>;

const NONE = (available: boolean): ErpCredentialsView => ({ available, status: 'none', erpAccount: null, savedAt: null, checkedAt: null, message: null });

export function createErpCredentialService({ db, clock, vault, erpOrigin, request, erpBusy, acquireWrite = () => ({ release: () => undefined }), trialTimeoutMs = TRIAL_TIMEOUT_MS }: ErpCredentialPorts) {
  const iso = () => clock().toISOString();
  // One 试登录 per account at a time: a second click waits for the first rather than logging in again.
  const trials = new Map<string, Promise<ErpCredentialsView>>();
  // The save (by `saved_at`) a job's login was refused with, kept here too: should maintenance hold the write back,
  // the refused password is still never handed to another job.
  const refused = new Map<string, string>();

  async function view(accountId: string): Promise<ErpCredentialsView> {
    const row = await db.selectFrom('erp_credential').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    if (!row) return NONE(!!vault);
    return { available: !!vault, status: row.status, erpAccount: row.erp_account, savedAt: row.saved_at, checkedAt: row.checked_at, message: row.message };
  }

  // What the 试登录 came to, written only onto the 凭据 it tried: a save or a clear meanwhile wins.
  async function settle(accountId: string, savedAt: string, outcome: { status: 'untested' | 'authorised' | 'refused'; message: string | null; checked: boolean }) {
    await db.updateTable('erp_credential')
      .set({
        status: outcome.status, message: outcome.message,
        ...(outcome.checked ? { checked_at: iso() } : {}),
        ...(outcome.status === 'refused' ? { password_sealed: null } : {}),
      })
      .where('account_id', '=', accountId).where('saved_at', '=', savedAt)
      .execute();
  }

  async function answerOf(accountId: string, payload: TrySignInRequest): Promise<TrySignInAnswer | { offline: true } | { timedOut: true }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ timedOut: true }>((done) => { timer = setTimeout(() => done({ timedOut: true }), trialTimeoutMs); });
    try {
      const answer = await Promise.race([request(accountId, EXECUTOR_METHODS.trySignIn, payload), timeout]);
      if (answer && typeof answer === 'object' && 'timedOut' in answer) return { timedOut: true };
      const parsed = TrySignInAnswerSchema.safeParse(answer);
      return parsed.success ? parsed.data : { ok: false, code: 'bad_answer', message: 'baox 本地执行器的试登录回答看不懂，请更新本地执行器后再试。' };
    } catch (error) {
      if (error instanceof ChannelError && error.code === EXECUTOR_OFFLINE_CODE) return { offline: true };
      return { ok: false, code: 'trial_failed', message: `试登录没有完成：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function trial(accountId: string): Promise<ErpCredentialsView> {
    const row = await db.selectFrom('erp_credential').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    if (!row || !row.password_sealed) throw new AuthRefusal(400, 'erp_credentials_none', ERP_CREDENTIAL_ERRORS.nothingSaved);
    const untested = async (message: string) => { await settle(accountId, row.saved_at, { status: 'untested', message, checked: false }); return view(accountId); };
    if (!(await hasPairing(db, accountId))) return untested(ERP_CREDENTIAL_ERRORS.notPaired);
    if (erpBusy(accountId)) return untested(ERP_CREDENTIAL_ERRORS.erpInUse);
    const password = vault?.open(accountId, row.password_sealed) ?? null;
    if (password === null) throw new AuthRefusal(503, 'erp_credentials_unavailable', ERP_CREDENTIAL_ERRORS.unavailable);
    const answer = await answerOf(accountId, { erpOrigin, credentials: { account: row.erp_account, password } });
    if ('offline' in answer) return untested(ERP_CREDENTIAL_ERRORS.noExecutor);
    if ('timedOut' in answer) return untested(ERP_CREDENTIAL_ERRORS.timedOut);
    if (answer.ok) await settle(accountId, row.saved_at, { status: 'authorised', message: null, checked: true });
    else await settle(accountId, row.saved_at, { status: answer.code === SIGN_IN_REFUSED_CODE ? 'refused' : 'untested', message: answer.message, checked: true });
    return view(accountId);
  }

  function trialOnce(accountId: string): Promise<ErpCredentialsView> {
    const running = trials.get(accountId);
    if (running) return running;
    const started = trial(accountId).finally(() => trials.delete(accountId));
    trials.set(accountId, started);
    return started;
  }

  return {
    view,

    async save(accountId: string, input: SaveErpCredentialsInput): Promise<ErpCredentialsView> {
      if (!vault) throw new AuthRefusal(503, 'erp_credentials_unavailable', ERP_CREDENTIAL_ERRORS.unavailable);
      // Saving again while a 试登录 runs replaces what it tries; its outcome then lands nowhere (`settle`).
      const row = { account_id: accountId, erp_account: input.account, password_sealed: vault.seal(accountId, input.password), status: 'untested' as const, message: null, saved_at: iso(), checked_at: null };
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('erp_credential').where('account_id', '=', accountId).execute();
        await tx.insertInto('erp_credential').values(row).execute();
      });
      return trialOnce(accountId);
    },

    test: (accountId: string) => trialOnce(accountId),

    async clear(accountId: string): Promise<ErpCredentialsView> {
      await db.deleteFrom('erp_credential').where('account_id', '=', accountId).execute();
      return view(accountId);
    },

    /**
     * The 凭据 a job of this account signs in with: only authorised ones. `untested` also gives saved ones no 试登录
     * has passed yet: the server's own executor (development, e2e) has no 本地执行器 to try them on, and signs in with
     * them as it finds them. Refused ones never go, and a refusal in the job deletes them as anywhere else.
     */
    async forJob(accountId: string, { untested = false }: { untested?: boolean } = {}): Promise<ErpCredentials | null> {
      if (!vault) return null;
      const row = await db.selectFrom('erp_credential').selectAll().where('account_id', '=', accountId).executeTakeFirst();
      const usable = row?.status === 'authorised' || (untested && row?.status === 'untested');
      if (!row || !usable || !row.password_sealed || refused.get(accountId) === row.saved_at) return null;
      const password = vault.open(accountId, row.password_sealed);
      return password === null ? null : { account: row.erp_account, password };
    },

    /** A job's sign-in was refused by ERP: the password it used goes, whichever of the account's saves it was. */
    async refusedInJob(accountId: string, used: ErpCredentials, message: string): Promise<void> {
      const row = await db.selectFrom('erp_credential').selectAll().where('account_id', '=', accountId).executeTakeFirst();
      if (!row?.password_sealed || row.erp_account !== used.account || vault?.open(accountId, row.password_sealed) !== used.password) return;
      refused.set(accountId, row.saved_at);
      const admission = acquireWrite();
      if (!admission) return;
      try {
        await settle(accountId, row.saved_at, { status: 'refused', message, checked: true });
      } finally {
        admission.release();
      }
    },
  };
}

// 去报销's check before any job exists (`app.ts`, inside the accepted change, so it reads through that transaction):
// the 本地执行器 signs in itself, so it needs authorised 凭据 and a key to open them.
export async function erpCredentialsReady(tx: Db, accountId: string, keyed: boolean): Promise<boolean> {
  if (!keyed) return false;
  const row = await tx.selectFrom('erp_credential').select(['status', 'password_sealed']).where('account_id', '=', accountId).executeTakeFirst();
  return row?.status === 'authorised' && !!row.password_sealed;
}
