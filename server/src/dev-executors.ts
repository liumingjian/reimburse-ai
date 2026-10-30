import { cdpExecutors } from './erp/cdp-executor';
import type { RunOverrides } from './run';

// Development follows the production pairing by default. The in-process CDP adapter requires explicit debugging opt-in.
export function devExecutors(value: string | undefined, dataDir: string): RunOverrides {
  if (value === undefined || value === 'paired') return {};
  if (value === 'cdp') return cdpExecutors(dataDir);
  throw new Error(`BAOX_DEV_ERP=${value} is neither cdp nor paired`);
}
