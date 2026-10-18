import { createHash, randomBytes } from 'node:crypto';
import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, PAIRING_ERRORS, InstallSystemSchema, type PairingHolderKind, type PairingState, type InstallSystem } from '@baox/contract';
import { AuthRefusal, type Clock } from '../accounts/accounts';
import type { Db } from '../db/database';
import type { MaintenanceWriteAdmission } from '../maintenance';

// 扩展配对 (extension pairing, ADR-0019): one 浏览器扩展 (browser extension) bound to one 应用账号 (app account).
// The settings page issues a 配对码 (pairing code); the extension exchanges it once for a long-lived token.
//
// The token is held the way a session token is: the extension keeps the random string, the database keeps only its
// sha256, so a copy of the database never hands anyone a working extension. The 配对码 is stored the same way, and
// only for the ten minutes it is good for.
//
// One row per 应用账号 (the primary key), so "one active pairing per account" is the table's own shape: issuing a new
// 配对码 replaces the row, which is what makes the previously paired extension's token stop resolving. Revoking
// deletes the row and touches no session; a logout deletes a session and touches no row. Both also close the old
// extension's live socket (`live.disconnect`): the token is checked only when a socket opens, so a row deleted under
// an open socket would otherwise leave that extension receiving this account's next 去报销.
//
// What is stored is what the settings page can still read after a restart: which browser, when it paired, when it
// last spoke, which version it reported. Whether it is connected *now* is not storable — it is a live socket
// (`channel.ts`) — so the view asks for it.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// No look-alike characters (no I, L, O, 0, 1): the employee reads this off the settings page and types it in.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const NOT_PAIRED: PairingState = { status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, connected: false, version: null, holder: null, code: null };

function generatePairingCode(): string {
  return [...randomBytes(PAIRING_CODE_LENGTH)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

// A 配对码 is read aloud or copied with stray spaces and dashes, and its alphabet has no lowercase letters.
const normalise = (code: string) => code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

// Wrong, expired and already-used codes get the same refusal: which one it was is not the extension's business, and
// telling it apart would confirm a guessed code to whoever guessed it.
const refuseCode = () => new AuthRefusal(401, 'pairing_code_invalid', PAIRING_ERRORS.codeInvalid);

// Whether this 应用账号 has a redeemed pairing (a 配对码 issued but not yet used is none). Takes the handle to read
// through, so the 去报销 refusal (`app.ts`) can ask inside the transaction it is already in.
export async function hasPairing(db: Db, accountId: string): Promise<boolean> {
  const row = await db.selectFrom('extension_pairing').select('token_sha256').where('account_id', '=', accountId).executeTakeFirst();
  return !!row?.token_sha256;
}

// What this account's redeemed pairing is, or null when there is none. Anything that did not say (every extension
// paired before the column existed) is an extension: only a baox 本地执行器 that said so is given the ERP 凭据.
export async function holderOf(db: Db, accountId: string): Promise<PairingHolderKind | null> {
  const row = await db.selectFrom('extension_pairing').select(['token_sha256', 'holder']).where('account_id', '=', accountId).executeTakeFirst();
  if (!row?.token_sha256) return null;
  return row.holder === 'local_executor' ? 'local_executor' : 'extension';
}

// What the pairing service needs of the live channel (`channel.ts`): whether an account's extension is connected, and
// closing its socket when the pairing goes. It defaults to "nothing is connected" so a server wired without a channel —
// every test that only exercises pairing — still answers the contract's shape.
export type LivePairings = { connected(accountId: string): boolean; disconnect(accountId: string): void };
const NO_CHANNEL: LivePairings = { connected: () => false, disconnect: () => undefined };

export function createPairingService(db: Db, clock: Clock, live: LivePairings = NO_CHANNEL, acquireWrite: MaintenanceWriteAdmission = () => ({ release: () => undefined })) {
  const iso = (date: Date) => date.toISOString();

  // Pairing reads normally update liveness or remove an expired code. They remain reads when maintenance has admitted:
  // the stale status is less harmful than allowing a GET or WebSocket hello to cross the durable write boundary.
  async function optionalWrite(write: () => Promise<unknown>): Promise<boolean> {
    const maintenance = acquireWrite();
    if (!maintenance) return false;
    try {
      await write();
      return true;
    } finally {
      maintenance.release();
    }
  }

  // `code` is the string just issued, carried through this once; every other caller passes nothing and the employee
  // sees no code, because there is none to show.
  async function view(accountId: string, code: string | null = null): Promise<PairingState> {
    const row = await db.selectFrom('extension_pairing').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    if (!row) return NOT_PAIRED;
    if (!row.token_sha256 && (row.code_expires_at === null || Date.parse(row.code_expires_at) <= clock().getTime())) {
      // Nobody used it in time; drop it rather than leave the page saying an extension is expected.
      await optionalWrite(() => db.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute());
      return NOT_PAIRED;
    }
    return {
      status: row.token_sha256 ? 'paired' : 'waiting',
      browser: row.browser,
      pairedAt: row.paired_at,
      lastConnectedAt: row.last_connected_at,
      codeExpiresAt: row.code_expires_at,
      connected: row.token_sha256 ? live.connected(accountId) : false,
      version: row.version,
      holder: row.token_sha256 ? (row.holder === 'local_executor' ? 'local_executor' : 'extension') : null,
      code,
    };
  }

  return {
    view,

    // Issuing is also how a pairing is replaced: the previous row goes first, so an extension paired a moment ago
    // stops being this account's extension before the new 配对码 is even readable.
    // `system`: the one-command install's choice (#425), which makes the code fetch that system's install script.
    async issue(accountId: string, system: InstallSystem | null = null): Promise<PairingState> {
      const code = generatePairingCode();
      const now = clock();
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute();
        await tx
          .insertInto('extension_pairing')
          .values({
            account_id: accountId,
            code_sha256: sha256(code),
            code_expires_at: iso(new Date(now.getTime() + PAIRING_CODE_TTL_MS)),
            token_sha256: null,
            browser: null,
            version: null,
            holder: null,
            install_system: system,
            install_code_sha256: system ? sha256(code) : null,
            created_at: iso(now),
            paired_at: null,
            last_connected_at: null,
          })
          .execute();
      });
      live.disconnect(accountId);
      return view(accountId, code);
    },

    // What `/install/<配对码>` answers for (#425): the account and system of a code issued for an install, for its ten
    // minutes, whether it has paired yet or not. Null for any other code. Reading it spends nothing.
    async installCode(code: string): Promise<{ accountId: string; system: InstallSystem } | null> {
      const row = await db
        .selectFrom('extension_pairing')
        .select(['account_id', 'install_system', 'created_at'])
        .where('install_code_sha256', '=', sha256(normalise(code)))
        .executeTakeFirst();
      if (!row || Date.parse(row.created_at) + PAIRING_CODE_TTL_MS <= clock().getTime()) return null;
      const system = InstallSystemSchema.safeParse(row.install_system);
      return system.success ? { accountId: row.account_id, system: system.data } : null;
    },

    // 撤销配对 (revoke the pairing): the extension's token stops resolving and its socket closes, at once. The
    // account's web session is untouched.
    async revoke(accountId: string): Promise<PairingState> {
      await db.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute();
      live.disconnect(accountId);
      return NOT_PAIRED;
    },

    // 撤销配对 from the extension's own popup, authorised by the token it holds. It works for a deactivated account
    // too, whose token no longer resolves in `lookup`: the extension is giving the pairing up, not using it. False
    // when the token names no pairing (already revoked or replaced).
    async revokeToken(token: string | undefined): Promise<boolean> {
      if (!token) return false;
      const row = await db.selectFrom('extension_pairing').select('account_id').where('token_sha256', '=', sha256(token)).executeTakeFirst();
      if (!row) return false;
      await db.deleteFrom('extension_pairing').where('account_id', '=', row.account_id).where('token_sha256', '=', sha256(token)).execute();
      live.disconnect(row.account_id);
      return true;
    },

    // Single use: the update matches only while the code is still on the row and clears it in the same statement, so
    // two extensions racing the same 配对码 cannot both walk away with a token.
    async redeem(code: string, browser: string | null, version: string | null, holder: PairingHolderKind | null = null): Promise<{ token: string; accountId: string }> {
      const now = clock();
      const codeSha = sha256(normalise(code));
      const row = await db.selectFrom('extension_pairing').selectAll().where('code_sha256', '=', codeSha).executeTakeFirst();
      if (!row || row.code_expires_at === null || Date.parse(row.code_expires_at) <= now.getTime()) throw refuseCode();
      const token = randomBytes(32).toString('base64url');
      const at = iso(now);
      const updated = await db
        .updateTable('extension_pairing')
        .set({ code_sha256: null, code_expires_at: null, token_sha256: sha256(token), browser, version, holder: holder ?? 'extension', paired_at: at, last_connected_at: at })
        .where('account_id', '=', row.account_id)
        .where('code_sha256', '=', codeSha)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw refuseCode();
      return { token, accountId: row.account_id };
    },

    // The 应用账号 an extension acts for, or null when the pairing is gone (revoked, replaced) or the account can no
    // longer act at all. A deactivated or unapproved account loses its extension the way it loses its sessions.
    // Every answer marks the connection: the settings page has no other sign that the pairing is alive. The username is
    // how the extension names the account when asking before it switches to another one (#292).
    async lookup(token: string | undefined): Promise<{ accountId: string; username: string } | null> {
      if (!token) return null;
      const tokenSha = sha256(token);
      const row = await db
        .selectFrom('extension_pairing')
        .innerJoin('account', 'account.account_id', 'extension_pairing.account_id')
        .select(['extension_pairing.account_id', 'account.username', 'account.active', 'account.approved'])
        .where('extension_pairing.token_sha256', '=', tokenSha)
        .executeTakeFirst();
      if (!row || row.active !== 1 || row.approved !== 1) return null;
      await optionalWrite(() => db.updateTable('extension_pairing').set({ last_connected_at: iso(clock()) }).where('token_sha256', '=', tokenSha).execute());
      return { accountId: row.account_id, username: row.username ?? row.account_id };
    },

    // The version an extension reports when it opens its channel (ADR-0021). An extension is replaced by unpacking a
    // new directory over the old one, so the version on the row is only ever as fresh as the last connect.
    async noteConnection(accountId: string, version: string | null): Promise<void> {
      await optionalWrite(() => db.updateTable('extension_pairing').set({ version, last_connected_at: iso(clock()) }).where('account_id', '=', accountId).execute());
    },
  };
}

export type PairingService = ReturnType<typeof createPairingService>;
