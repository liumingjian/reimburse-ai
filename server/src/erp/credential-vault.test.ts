import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createCredentialVault, readCredentialKey } from './credential-vault';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const keyFile = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'baox-key-'));
  dirs.push(dir);
  const path = join(dir, 'erp-credential.key');
  writeFileSync(path, content);
  return path;
};

describe('the ERP 凭据 vault', () => {
  const vault = createCredentialVault(randomBytes(32));

  it('opens what it sealed, for the account it sealed it for, and the sealed form shows nothing of the password', () => {
    const sealed = vault.seal('alice', 'ERP-密码-1');
    expect(sealed).not.toContain('ERP');
    expect(vault.open('alice', sealed)).toBe('ERP-密码-1');
    expect(vault.seal('alice', 'ERP-密码-1')).not.toBe(sealed);
  });

  it('opens nothing for another account, under another key, or once tampered with', () => {
    const sealed = vault.seal('alice', 'secret');
    expect(vault.open('bob', sealed)).toBeNull();
    expect(createCredentialVault(randomBytes(32)).open('alice', sealed)).toBeNull();
    const [version, iv, body, tag] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(vault.open('alice', [version, iv, flipped.toString('base64url'), tag].join('.'))).toBeNull();
    expect(vault.open('alice', 'not sealed')).toBeNull();
  });

  it('reads a 32-byte key as hex or base64, and refuses anything else', () => {
    const key = randomBytes(32);
    expect(readCredentialKey(keyFile(`${key.toString('hex')}\n`))).toEqual(key);
    expect(readCredentialKey(keyFile(key.toString('base64')))).toEqual(key);
    expect(readCredentialKey(keyFile(key.toString('base64url')))).toEqual(key);
    expect(() => readCredentialKey(keyFile(randomBytes(16).toString('hex')))).toThrow(/32 bytes/);
    expect(() => readCredentialKey(join(tmpdir(), 'no-such-baox-key'))).toThrow(/cannot read/);
  });
});
