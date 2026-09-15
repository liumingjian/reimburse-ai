import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../app';
import { ensureDataDir } from '../data-dir';
import { openDatabase } from '../db/database';

// The primary test seam: the Hono app on SQLite `:memory:`, with a throwaway data directory for blobs.
export type TestServer = { app: Hono; dataDir: string; close: () => Promise<void> };

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baox-test-'));
  ensureDataDir(dir);
  return dir;
}

export async function createTestServer(): Promise<TestServer> {
  const dataDir = tempDataDir();
  const db = await openDatabase(':memory:');
  return {
    app: createApp({ db, dataDir }),
    dataDir,
    async close() {
      await db.destroy();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
