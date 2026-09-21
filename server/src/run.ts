import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveProjectCatalog } from './catalog/live-catalog';
import { catalogFromEnv } from './catalog/project-catalog';
import { resolveDataDir } from './data-dir';
import { erpConfigFromEnv } from './erp/config';
import type { FillExecutor } from './erp/fill-jobs';
import { cdpBrowser } from '@baox/erp-executor/browser';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { resolveLegacyHome } from './legacy/read';
import { startServer } from './server';

// Starting the server, shared by the production entry (`main.ts`), the development one (`dev-main.ts`) and the e2e-only
// one (`e2e-main.ts`).
// `BAOX_DATA_DIR` overrides `~/.baox-app/` (dev and tests only); `BAOX_PORT` overrides 4319 (0 = any free port).
// `BAOX_PROJECT_CATALOG_FIXTURE` swaps in the fixture project catalog (e2e only); otherwise project numbers are
// checked live in the logged-in ERP tab of the dedicated Chromium. Serves `web/dist` same-origin when it has been
// built. The `listening on` line is what e2e waits for.
// `BAOX_HOME` overrides the legacy `~/.baox`, read (never written) once when the first admin is created.
// `BAOX_PUBLIC_ORIGIN` is the address colleagues reach the app at through the reverse proxy, e.g.
// `http://10.250.0.222`; unset serves 127.0.0.1 only (`public-origin.ts`).
// ERP: `BAOX_ERP_ORIGIN`, `BAOX_ERP_BUILD`, `BAOX_ERP_FORM_ID` (`erp/config.ts`), `BAOX_CHROMIUM_CDP_PORT` (9333, the
// live catalog and the CDP executor), `BAOX_CHROME` and `BAOX_ERP_CHROMIUM=off` (the CDP executor only).
const DEFAULT_PORT = 4319;
// src/run.ts (dev, via tsx) and dist/main.mjs (built) both sit two levels below the repo root.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
// The extension template `pnpm build` leaves beside it; the download is assembled from it per request, so a template
// built after the server started is picked up without a restart.
const EXTENSION_TEMPLATE = fileURLToPath(new URL('../../extension/dist', import.meta.url));

// Where ERP jobs run. Absent, they run in each task owner's paired 浏览器扩展 (`erp/remote-executor.ts`), which is the
// only choice the production entry has: the CDP executor is passed in by the development and e2e entries alone, so it
// never reaches a bundle users run (`production-entry.test.ts`).
export type RunOverrides = { erpExecutor?: FillExecutor; reconcileExecutor?: ReconcileExecutor };

export async function run({ erpExecutor, reconcileExecutor }: RunOverrides = {}): Promise<void> {
  const dataDir = resolveDataDir();
  const port = Number(process.env['BAOX_PORT'] ?? DEFAULT_PORT);
  try {
    const erpConfig = erpConfigFromEnv();
    const projectCatalog = catalogFromEnv(process.env, () => liveProjectCatalog({ browser: cdpBrowser(cdpPortOf()), origin: erpConfig.origin }));
    const server = await startServer({
      dataDir,
      port,
      webDist: existsSync(WEB_DIST) ? WEB_DIST : null,
      projectCatalog,
      legacyHome: resolveLegacyHome(),
      ...(erpExecutor ? { erpExecutor } : {}),
      ...(reconcileExecutor ? { reconcileExecutor } : {}),
      erpConfig,
      publicOrigin: process.env['BAOX_PUBLIC_ORIGIN'] ?? null,
      extensionTemplate: EXTENSION_TEMPLATE,
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
