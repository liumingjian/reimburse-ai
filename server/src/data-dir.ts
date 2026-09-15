import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// The data directory (ADR-0015): `baox.sqlite`, content-addressed originals under `files/sha256/<ab>/<hash>`, and
// `backups/`. Directories are 0700 and files 0600. A lock file allows one server per directory.

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_FILE = 'server.lock';

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['BAOX_DATA_DIR'] || join(homedir(), '.baox-app');
}

export function databasePath(root: string): string {
  return join(root, 'baox.sqlite');
}

export function ensureDataDir(root: string): void {
  for (const dir of [root, join(root, 'files', 'sha256'), join(root, 'files', 'tmp'), join(root, 'backups')]) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

export class DataDirLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly holderPid: number | null,
  ) {
    super(`Data directory ${dataDir} is already used by another baox server${holderPid === null ? '' : ` (pid ${holderPid})`}`);
    this.name = 'DataDirLockedError';
  }
}

// Takes the directory lock and returns its release. A lock left by a process that no longer exists is stale
// (the server crashed) and is taken over; a lock held by a live process refuses.
export function acquireDataDirLock(root: string): () => void {
  const path = join(root, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', FILE_MODE);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(readFileSync(path, 'utf8'), 10);
      if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) throw new DataDirLockedError(root, holder);
      rmSync(path, { force: true });
    }
  }
  throw new DataDirLockedError(root, null);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function blobPath(root: string, sha256: string): string {
  return join(root, 'files', 'sha256', sha256.slice(0, 2), sha256);
}

// Stores bytes under their SHA-256, written temp → fsync → rename so a crash never leaves a partial blob under its
// final name. Bytes already stored are not written again: the same file uploaded twice shares one blob.
export function writeBlob(root: string, bytes: Uint8Array): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const target = blobPath(root, sha256);
  if (existsSync(target)) return sha256;
  mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
  const temp = join(root, 'files', 'tmp', `${sha256}.${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, 'wx', FILE_MODE);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  return sha256;
}
