import { resolveDataDir } from './data-dir';
import { devExecutors } from './dev-executors';
import { run } from './run';

// The development entry (`pnpm dev`, run by tsx and never built). It is the production server with ERP jobs on the
// CDP executor and the dedicated Chromium, which #227 keeps for development; `main.ts` cannot reach that executor.
// `BAOX_DEV_ERP=paired` sends them to the paired 本地执行器 instead (`dev-executors.ts`).
await run(devExecutors(process.env['BAOX_DEV_ERP'], resolveDataDir()));
