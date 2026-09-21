import { resolveDataDir } from './data-dir';
import { cdpExecutors } from './erp/cdp-executor';
import { run } from './run';

// The development entry (`pnpm dev`, run by tsx and never built). It is the production server with ERP jobs on the
// CDP executor and the dedicated Chromium, which #227 keeps for development; `main.ts` cannot reach that executor.
await run(cdpExecutors(resolveDataDir()));
