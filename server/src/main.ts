import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogFromEnv } from './catalog/project-catalog';
import { resolveDataDir } from './data-dir';
import { startServer } from './server';

// Entry point. `BAOX_DATA_DIR` overrides `~/.baox-app/` (dev and tests only); `BAOX_PORT` overrides 4319 (0 = any free
// port). `BAOX_PROJECT_CATALOG_FIXTURE` swaps in the fixture project catalog (e2e only). Serves `web/dist` same-origin when it has been built. The `listening on` line is what e2e waits for.
const DEFAULT_PORT = 4319;
// Both src/main.ts (dev) and dist/main.mjs (built) sit two levels below the repo root.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const dataDir = resolveDataDir();
const port = Number(process.env['BAOX_PORT'] ?? DEFAULT_PORT);

try {
  const server = await startServer({ dataDir, port, webDist: existsSync(WEB_DIST) ? WEB_DIST : null, projectCatalog: catalogFromEnv() });
  console.log(`baox server listening on ${server.url} (data ${dataDir})`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
