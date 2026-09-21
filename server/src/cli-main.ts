import { runCli } from './cli';
import { resolveDataDir } from './data-dir';

// Entry point of the `baox` command (`pnpm --filter @baox/server baox admin emergency-reset <username>`, or the built
// dist/baox.mjs). `BAOX_DATA_DIR` selects the data directory like the server's.
process.exitCode = await runCli(process.argv.slice(2), { dataDir: resolveDataDir(), out: (line) => console.log(line), err: (line) => console.error(line) });
