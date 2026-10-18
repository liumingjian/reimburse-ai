import { cdpExecutors } from './erp/cdp-executor';
import type { RunOverrides } from './run';

// Where the development entry runs ERP jobs, by `BAOX_DEV_ERP`. Unset or `cdp`: the CDP executor on the dedicated,
// headed Chromium (#227), signing in with the account's saved ERP 凭据 and ending at 暂存 like production (ADR-0037).
// `paired`: nowhere of its own, so the server sends each job to the task owner's paired 本地执行器 exactly as the
// production entry does (`erp/remote-executor.ts`).
export function devExecutors(value: string | undefined, dataDir: string): RunOverrides {
  if (value === undefined || value === 'cdp') return cdpExecutors(dataDir);
  if (value === 'paired') return {};
  throw new Error(`BAOX_DEV_ERP=${value} is neither cdp nor paired`);
}
