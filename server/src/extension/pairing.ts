import { createHash, randomBytes } from 'node:crypto';
import { EXTENSION_PAIRING_CODE_LENGTH, EXTENSION_PAIRING_CODE_TTL_MS, EXTENSION_PAIRING_ERRORS, type ExtensionPairing } from '@baox/contract';
import { AuthRefusal, type Clock } from '../accounts/accounts';
import type { Db } from '../db/database';

// 扩展配对 (extension pairing, ADR-0019): one 浏览器扩展 (browser extension) bound to one 应用账号 (app account).
// The settings page issues a 配对码 (pairing code); the extension exchanges it once for a long-lived token.
//
// The token is held the way a session token is: the extension keeps the random string, the database keeps only its
// sha256, so a copy of the database never hands anyone a working extension. The 配对码 is stored the same way, and
// only for the ten minutes it is good for.
//
// One row per 应用账号 (the primary key), so "one active pairing per account" is the table's own shape: issuing a new
// 配对码 replaces the row, which is what makes the previously paired extension's token stop resolving. Revoking
// deletes the row and touches no session; a logout deletes a session and touches no row.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// No look-alike characters (no I, L, O, 0, 1): the employee reads this off the settings page and types it in.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const NOT_PAIRED: ExtensionPairing = { status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, code: null };

function generatePairingCode(): string {
  return [...randomBytes(EXTENSION_PAIRING_CODE_LENGTH)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

// A 配对码 is read aloud or copied with stray spaces and dashes, and its alphabet has no lowercase letters.
const normalise = (code: string) => code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

// Wrong, expired and already-used codes get the same refusal: which one it was is not the extension's business, and
// telling it apart would confirm a guessed code to whoever guessed it.
const refuseCode = () => new AuthRefusal(401, 'pairing_code_invalid', EXTENSION_PAIRING_ERRORS.codeInvalid);

export function createPairingService(db: Db, clock: Clock) {
  const iso = (date: Date) => date.toISOString();

  // `code` is the string just issued, carried through this once; every other caller passes nothing and the employee
  // sees no code, because there is none to show.
  async function view(accountId: string, code: string | null = null): Promise<ExtensionPairing> {
    const row = await db.selectFrom('extension_pairing').selectAll().where('account_id', '=', accountId).executeTakeFirst();
    if (!row) return NOT_PAIRED;
    if (!row.token_sha256 && (row.code_expires_at === null || Date.parse(row.code_expires_at) <= clock().getTime())) {
      // Nobody used it in time; drop it rather than leave the page saying an extension is expected.
      await db.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute();
      return NOT_PAIRED;
    }
    return {
      status: row.token_sha256 ? 'paired' : 'waiting',
      browser: row.browser,
      pairedAt: row.paired_at,
      lastConnectedAt: row.last_connected_at,
      codeExpiresAt: row.code_expires_at,
      code,
    };
  }

  return {
    view,

    // Issuing is also how a pairing is replaced: the previous row goes first, so an extension paired a moment ago
    // stops being this account's extension before the new 配对码 is even readable.
    async issue(accountId: string): Promise<ExtensionPairing> {
      const code = generatePairingCode();
      const now = clock();
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute();
        await tx
          .insertInto('extension_pairing')
          .values({
            account_id: accountId,
            code_sha256: sha256(code),
            code_expires_at: iso(new Date(now.getTime() + EXTENSION_PAIRING_CODE_TTL_MS)),
            token_sha256: null,
            browser: null,
            created_at: iso(now),
            paired_at: null,
            last_connected_at: null,
          })
          .execute();
      });
      return view(accountId, code);
    },

    // 撤销配对: the extension's token stops resolving at once. The account's web session is untouched.
    async revoke(accountId: string): Promise<ExtensionPairing> {
      await db.deleteFrom('extension_pairing').where('account_id', '=', accountId).execute();
      return NOT_PAIRED;
    },

    // Single use: the update matches only while the code is still on the row and clears it in the same statement, so
    // two extensions racing the same 配对码 cannot both walk away with a token.
    async redeem(code: string, browser: string | null): Promise<{ token: string; accountId: string }> {
      const now = clock();
      const codeSha = sha256(normalise(code));
      const row = await db.selectFrom('extension_pairing').selectAll().where('code_sha256', '=', codeSha).executeTakeFirst();
      if (!row || row.code_expires_at === null || Date.parse(row.code_expires_at) <= now.getTime()) throw refuseCode();
      const token = randomBytes(32).toString('base64url');
      const at = iso(now);
      const updated = await db
        .updateTable('extension_pairing')
        .set({ code_sha256: null, code_expires_at: null, token_sha256: sha256(token), browser, paired_at: at, last_connected_at: at })
        .where('account_id', '=', row.account_id)
        .where('code_sha256', '=', codeSha)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw refuseCode();
      return { token, accountId: row.account_id };
    },

    // The 应用账号 an extension acts for, or null when the pairing is gone (revoked, replaced) or the account can no
    // longer act at all. A deactivated or unapproved account loses its extension the way it loses its sessions.
    // Every answer marks the connection: the settings page has no other sign that the pairing is alive.
    async lookup(token: string | undefined): Promise<{ accountId: string } | null> {
      if (!token) return null;
      const tokenSha = sha256(token);
      const row = await db
        .selectFrom('extension_pairing')
        .innerJoin('account', 'account.account_id', 'extension_pairing.account_id')
        .select(['extension_pairing.account_id', 'account.active', 'account.approved'])
        .where('extension_pairing.token_sha256', '=', tokenSha)
        .executeTakeFirst();
      if (!row || row.active !== 1 || row.approved !== 1) return null;
      await db.updateTable('extension_pairing').set({ last_connected_at: iso(clock()) }).where('token_sha256', '=', tokenSha).execute();
      return { accountId: row.account_id };
    },
  };
}

export type PairingService = ReturnType<typeof createPairingService>;
