// Where the local executor keeps its state on the employee's PC: the pairing (the app's address and the token that
// stands for one 应用账号, ADR-0021's 扩展配对 by another holder), the browser profile, and each job's staged invoices.
// Everything lives under one directory the employee's own user can read, and nobody else.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const StoredPairingSchema = z.object({ origin: z.string().url(), token: z.string().min(1), accountId: z.string().min(1) });
export type StoredPairing = z.infer<typeof StoredPairingSchema>;

export type Store = {
  home: string;
  profileDir: string;
  stagingRoot: string;
  readPairing(): StoredPairing | null;
  writePairing(pairing: StoredPairing): void;
  clearPairing(): void;
  /** The directories a job writes into, created owner-only if missing. */
  prepare(): void;
};

export function openStore(env: Record<string, string | undefined> = process.env): Store {
  const home = env['BAOX_LOCAL_EXECUTOR_HOME'] ?? join(homedir(), '.baox', 'local-executor');
  const pairingFile = join(home, 'pairing.json');
  const ensure = () => mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    home,
    profileDir: join(home, 'profile'),
    stagingRoot: join(home, 'staging'),
    readPairing() {
      if (!existsSync(pairingFile)) return null;
      const parsed = StoredPairingSchema.safeParse(JSON.parse(readFileSync(pairingFile, 'utf8')) as unknown);
      return parsed.success ? parsed.data : null;
    },
    writePairing(pairing) {
      ensure();
      writeFileSync(pairingFile, JSON.stringify(pairing), { mode: 0o600 });
      chmodSync(pairingFile, 0o600);
    },
    clearPairing() {
      rmSync(pairingFile, { force: true });
    },
    prepare() {
      for (const dir of [home, join(home, 'profile'), join(home, 'staging')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    },
  };
}
