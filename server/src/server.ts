import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { acquireDataDirLock, databasePath, ensureDataDir } from './data-dir';
import { openDatabase, type Db } from './db/database';

// Startup order: take the data directory, lock it, migrate, then listen. The server binds 127.0.0.1 only.
export const HOST = '127.0.0.1';

export type StartOptions = {
  dataDir: string;
  // 0 picks a free port (tests and e2e).
  port: number;
  webDist?: string | null;
};

export type RunningServer = { url: string; port: number; close: () => Promise<void> };

export async function startServer({ dataDir, port, webDist = null }: StartOptions): Promise<RunningServer> {
  ensureDataDir(dataDir);
  const release = acquireDataDirLock(dataDir);
  let db: Db;
  try {
    db = await openDatabase(databasePath(dataDir));
  } catch (error) {
    release();
    throw error;
  }
  const app = createApp({ db, dataDir, webDist });
  const { server, info } = await new Promise<{ server: ReturnType<typeof serve>; info: AddressInfo }>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: HOST, port }, (address) => resolve({ server: s, info: address }));
  });
  return {
    url: `http://${HOST}:${info.port}`,
    port: info.port,
    async close() {
      // Open SSE streams would keep the server alive forever.
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
      await db.destroy();
      release();
    },
  };
}
