import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../app';
import { ensureDataDir } from '../data-dir';
import { openDatabase } from '../db/database';
import type { ParseExecutor } from '../parse/executor';

// The primary test seam: the Hono app on SQLite `:memory:`, with a throwaway data directory for blobs. The parser job
// runs in the real parse worker unless a test injects another executor.
export type TestServer = { app: App; dataDir: string; close: () => Promise<void> };

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baox-test-'));
  ensureDataDir(dir);
  return dir;
}

export async function createTestServer({ parser }: { parser?: ParseExecutor } = {}): Promise<TestServer> {
  const dataDir = tempDataDir();
  const db = await openDatabase(':memory:');
  const app = createApp({ db, dataDir, ...(parser ? { parser } : {}) });
  return {
    app,
    dataDir,
    async close() {
      await app.close();
      await db.destroy();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
