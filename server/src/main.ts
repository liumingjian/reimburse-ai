import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveProjectCatalog } from './catalog/live-catalog';
import { catalogFromEnv } from './catalog/project-catalog';
import { resolveDataDir } from './data-dir';
import { cdpFillExecutor } from './erp/cdp-executor';
import { erpConfigFromEnv } from './erp/config';
import { cdpBrowser } from './erp/executor/browser';
import { cdpPortOf } from './erp/executor/chromium';
import { resolveLegacyHome } from './legacy/read';
import { startServer } from './server';

// Entry point. `BAOX_DATA_DIR` overrides `~/.baox-app/` (dev and tests only); `BAOX_PORT` overrides 4319 (0 = any free
// port). `BAOX_PROJECT_CATALOG_FIXTURE` swaps in the fixture project catalog (e2e only); otherwise project numbers are
// checked live in the logged-in ERP tab of the dedicated Chromium. Serves `web/dist` same-origin when it has been built.
// The `listening on` line is what e2e waits for.
// `BAOX_HOME` overrides the legacy `~/.baox`, read (never written) once when the first admin is created.
// ERP: `BAOX_ERP_ORIGIN`, `BAOX_ERP_BUILD`, `BAOX_ERP_FORM_ID` (`erp/config.ts`), `BAOX_CHROMIUM_CDP_PORT` (9333),
// `BAOX_CHROME` (browser binary), `BAOX_ERP_CHROMIUM=off` (never start the dedicated browser).
const DEFAULT_PORT = 4319;
// Both src/main.ts (dev) and dist/main.mjs (built) sit two levels below the repo root.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const dataDir = resolveDataDir();
const port = Number(process.env['BAOX_PORT'] ?? DEFAULT_PORT);

try {
  const erpConfig = erpConfigFromEnv();
  const projectCatalog = catalogFromEnv(process.env, () => liveProjectCatalog({ browser: cdpBrowser(cdpPortOf()), origin: erpConfig.origin }));
  const server = await startServer({ dataDir, port, webDist: existsSync(WEB_DIST) ? WEB_DIST : null, projectCatalog, legacyHome: resolveLegacyHome(), erpExecutor: cdpFillExecutor({ dataDir }), erpConfig });
  console.log(`baox server listening on ${server.url} (data ${dataDir})`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
