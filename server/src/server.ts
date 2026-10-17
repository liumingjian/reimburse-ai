import type { AddressInfo } from 'node:net';
import type { LocalExecutorDist } from './local-executor/release';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import type { ErpConfig } from './erp/config';
import type { FillExecutor } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import type { ParseExecutor } from './parse/executor';
import { acquireDataDirLock, databasePath, ensureDataDir } from './data-dir';
import { openDatabase, type Db } from './db/database';
import { attachExtensionChannel } from './extension/websocket';
import { maintenanceSocketPath as defaultMaintenanceSocketPath, startMaintenanceControl, type MaintenanceControl } from './maintenance-control';
import { parsePublicOrigin } from './public-origin';

// Startup order: read the public origin, take the data directory, lock it, migrate, then listen.
// Node binds 127.0.0.1 in every deployment; colleagues reach it through the reverse proxy in front of it, and
// `publicOrigin` is the address they use (`public-origin.ts`).
export const HOST = '127.0.0.1';

export type StartOptions = {
  dataDir: string;
  // 0 picks a free port (tests and e2e).
  port: number;
  webDist?: string | null;
  // The legacy `~/.baox` to import on first-admin creation; null or absent imports nothing.
  legacyHome?: string | null;
  erpExecutor?: FillExecutor;
  reconcileExecutor?: ReconcileExecutor;
  parser?: ParseExecutor;
  erpConfig?: ErpConfig;
  // `BAOX_PUBLIC_ORIGIN` as written, e.g. `http://10.250.0.222:8888`; absent or empty serves 127.0.0.1 only. An origin
  // this refuses (`public-origin.ts`) stops the server before it listens.
  publicOrigin?: string | null;
  // The built extension template (`extension/dist`) the settings page's download is assembled from; null serves none.
  extensionTemplate?: string | null;
  localExecutor?: LocalExecutorDist | null;
  // A host-local credential enables the Unix-socket maintenance controller. Production loads it from a root/baox-owned
  // file; tests pass a value directly. Without it, an older release remains observable as lacking a maintenance gate.
  maintenanceToken?: string | null;
  maintenanceSocketPath?: string | null;
  // The key the hosted ERP 凭据 are sealed with (`erp/credential-vault.ts`); null disables them.
  erpCredentialKey?: Buffer | null;
};

export type RunningServer = { url: string; port: number; maintenanceSocketPath: string | null; close: () => Promise<void> };

export async function startServer({ dataDir, port, webDist = null, legacyHome = null, erpExecutor, reconcileExecutor, parser, erpConfig, publicOrigin = null, extensionTemplate = null, localExecutor = null, maintenanceToken = null, maintenanceSocketPath = null, erpCredentialKey = null }: StartOptions): Promise<RunningServer> {
  // First, so a misconfigured address never gets as far as the data directory lock.
  const served = publicOrigin ? parsePublicOrigin(publicOrigin) : null;
  ensureDataDir(dataDir);
  const release = acquireDataDirLock(dataDir);
  let db: Db;
  try {
    db = await openDatabase(databasePath(dataDir));
  } catch (error) {
    release();
    throw error;
  }
  const app = createApp({ db, dataDir, webDist, legacyHome, publicOrigin: served, extensionTemplate, localExecutor, erpCredentialKey, ...(erpExecutor ? { erpExecutor } : {}), ...(reconcileExecutor ? { reconcileExecutor } : {}), ...(parser ? { parser } : {}), ...(erpConfig ? { erpConfig } : {}) });
  let control: MaintenanceControl | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let info: AddressInfo | null = null;
  const socketPath = maintenanceToken ? maintenanceSocketPath ?? defaultMaintenanceSocketPath(dataDir) : null;
  try {
    await app.ready;
    if (maintenanceToken && socketPath) control = await startMaintenanceControl({ gate: app.maintenance, path: socketPath, token: maintenanceToken });
    ({ server, info } = await new Promise<{ server: ReturnType<typeof serve>; info: AddressInfo }>((resolve) => {
      const listening = serve({ fetch: app.fetch, hostname: HOST, port }, (address) => resolve({ server: listening, info: address }));
    }));
  } catch (error) {
    await control?.close().catch(() => undefined);
    await app.close();
    await db.destroy();
    release();
    throw error;
  }
  // The 浏览器扩展 channel shares this listening socket: Hono answers the requests, `ws` answers the upgrades
  // (`extension/websocket.ts`). Attached after listening so nothing can upgrade before the app exists.
  const detachExtensionChannel = attachExtensionChannel(server!, app.extensionChannel, served);
  return {
    url: `http://${HOST}:${info!.port}`,
    port: info!.port,
    maintenanceSocketPath: socketPath,
    async close() {
      await control?.close();
      detachExtensionChannel();
      // Open SSE streams would keep the server alive forever.
      if ('closeAllConnections' in server!) server!.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      await app.close();
      await db.destroy();
      release();
    },
  };
}
