import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './data-dir';
import { erpConfigFromEnv } from './erp/config';
import type { FillExecutor } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import type { ParseExecutor } from './parse/executor';
import { resolveLegacyHome } from './legacy/read';
import { readMaintenanceToken } from './maintenance-control';
import { startServer } from './server';

// Starting the server, shared by the production entry (`main.ts`), the development one (`dev-main.ts`) and the e2e-only
// one (`e2e-main.ts`).
// `BAOX_DATA_DIR` overrides `~/.baox-app/` (dev and tests only); `BAOX_PORT` overrides 4319 (0 = any free port).
// Serves `web/dist` same-origin when it has been built. The `listening on` line is what e2e waits for.
// `BAOX_HOME` overrides the legacy `~/.baox`, read (never written) once when the first admin is created.
// `BAOX_PUBLIC_ORIGIN` is the address colleagues reach the app at through the reverse proxy, e.g.
// `http://10.250.0.222:8888`; unset serves 127.0.0.1 only (`public-origin.ts`).
// `BAOX_MAINTENANCE_TOKEN_FILE` is the root/baox-owned host-local credential that enables the Unix maintenance
// control socket; `BAOX_MAINTENANCE_SOCKET_PATH` is reserved for an isolated recovery rehearsal. Production uses the
// data-directory default, while development and existing releases may leave the credential unset.
// ERP: `BAOX_ERP_ORIGIN`, `BAOX_ERP_BUILD`, `BAOX_ERP_FORM_ID` (`erp/config.ts`); `BAOX_CHROMIUM_CDP_PORT`,
// `BAOX_CHROME` and `BAOX_ERP_CHROMIUM=off` are read by the CDP executor only (`erp/cdp-executor.ts`), so they mean
// nothing to the production entry. Project numbers are checked against the ERP inside each 去报销 job, in the
// employee's own ERP tab (`checkCatalog`); the server holds no live catalog.
const DEFAULT_PORT = 4319;
// src/run.ts (dev, via tsx) and dist/main.mjs (built) both sit two levels below the repo root.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
// The extension template `pnpm build` leaves beside it; the download is assembled from it per request, so a template
// built after the server started is picked up without a restart.
const EXTENSION_TEMPLATE = fileURLToPath(new URL('../../extension/dist', import.meta.url));

// Where ERP jobs run. Absent, they run in each task owner's paired 浏览器扩展 (`erp/remote-executor.ts`), which is the
// only choice the production entry has: the CDP executor is passed in by the development and e2e entries alone, so it
// never reaches a bundle users run (`production-entry.test.ts`).
export type RunOverrides = { erpExecutor?: FillExecutor; reconcileExecutor?: ReconcileExecutor; parser?: ParseExecutor };

export async function run({ erpExecutor, reconcileExecutor, parser }: RunOverrides = {}): Promise<void> {
  const dataDir = resolveDataDir();
  const port = Number(process.env['BAOX_PORT'] ?? DEFAULT_PORT);
  try {
    const erpConfig = erpConfigFromEnv();
    const maintenanceTokenFile = process.env['BAOX_MAINTENANCE_TOKEN_FILE'];
    const maintenanceSocketPath = process.env['BAOX_MAINTENANCE_SOCKET_PATH'];
    const server = await startServer({
      dataDir,
      port,
      webDist: existsSync(WEB_DIST) ? WEB_DIST : null,
      legacyHome: resolveLegacyHome(),
      ...(erpExecutor ? { erpExecutor } : {}),
      ...(reconcileExecutor ? { reconcileExecutor } : {}),
      ...(parser ? { parser } : {}),
      erpConfig,
      publicOrigin: process.env['BAOX_PUBLIC_ORIGIN'] ?? null,
      extensionTemplate: EXTENSION_TEMPLATE,
      ...(maintenanceTokenFile ? {
        maintenanceToken: readMaintenanceToken(maintenanceTokenFile),
        ...(maintenanceSocketPath ? { maintenanceSocketPath } : {}),
      } : {}),
    });
    console.log(`baox server listening on ${server.url} (data ${dataDir})`);
    const stop = () => void server.close().then(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
