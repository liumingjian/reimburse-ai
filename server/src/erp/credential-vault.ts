// The key the ERP 凭据 are sealed with (ADR-0033): AES-256-GCM, the key in a file only the server reads
// (BAOX_ERP_CREDENTIAL_KEY_FILE, created by the operator's candidate prepare), never in the
// database or its backups. A copy of the database alone therefore holds no usable ERP password.
//
// This differs from ADR-0022, which refused application-level encryption for invoice originals: an original is read by
// the employee who uploaded it, so the database's own access rules protect it. An ERP password is something baox has to
// use as the employee, and the threat that matters is a database or backup file read elsewhere.
//
// Each sealed value is bound to its 应用账号 (the GCM additional data), so a row copied onto another account fails to
// open instead of handing that account someone else's ERP login.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type CredentialVault = {
  seal(accountId: string, secret: string): string;
  /** Null when the value does not open with this key for this account (another key, another account, tampered). */
  open(accountId: string, sealed: string): string | null;
};

// The file holds 32 random bytes as 64 hex characters or as base64 / base64url.
export function readCredentialKey(path: string): Buffer {
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('cannot read the ERP credential key');
  }
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : /^[A-Za-z0-9+/_-]{43}=?$/.test(value) ? Buffer.from(value, 'base64url') : null;
  if (!key || key.length !== KEY_BYTES) throw new Error('the ERP credential key is not 32 bytes of hex or base64');
  return key;
}

const bound = (accountId: string) => Buffer.from(`baox-erp-credential:${VERSION}:${accountId}`, 'utf8');

export function createCredentialVault(key: Buffer): CredentialVault {
  if (key.length !== KEY_BYTES) throw new Error('the ERP credential key must be 32 bytes');
  return {
    seal(accountId, secret) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(bound(accountId));
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return [VERSION, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
    open(accountId, sealed) {
      const [version, iv, body, tag] = sealed.split('.');
      if (version !== VERSION || !iv || body === undefined || !tag) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(bound(accountId));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
