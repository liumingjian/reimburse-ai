// One 本地执行器 per employee login: a second copy (the login's autostart next to one started by `setup`, say) would
// hold a second channel and the two would take the account's pairing from each other. The first writes its pid into
// the executor's directory; a later one that finds that pid alive leaves.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else, which is still a live process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Claim the login's single executor slot; null when another live process holds it. */
export function claimInstance(home: string, pid: number = process.pid): { release(): void } | null {
  const file = join(home, 'executor.pid');
  if (existsSync(file)) {
    const holder = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) return null;
  }
  writeFileSync(file, String(pid), { mode: 0o600 });
  return {
    release() {
      if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(pid)) rmSync(file, { force: true });
    },
  };
}
