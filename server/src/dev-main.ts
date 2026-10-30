import { resolveDataDir } from './data-dir';
import { devExecutors } from './dev-executors';
import { run } from './run';

// Development uses the paired local executor. BAOX_DEV_ERP=cdp explicitly selects the adapter debugging path.
await run(devExecutors(process.env['BAOX_DEV_ERP'], resolveDataDir()));
