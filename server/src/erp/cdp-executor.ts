import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobPath } from '../data-dir';
import { cdpBrowser, ensureChromium } from '@baox/erp-executor/browser';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { runFillJob } from '@baox/erp-executor/job';
import { erpEntryOf } from '@baox/erp-executor/probe';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import type { FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { BlobSource } from '@baox/erp-executor/protocol';

// The v1 executor: in process, on the dedicated Chromium profile under the data directory (ADR-0016). Since #246 it is
// for development, e2e and `pnpm test:erp-live` only (#227): the production entry cannot reach this module, and runs
// every job in the task owner's 浏览器扩展 instead (`remote-executor.ts`, `production-entry.test.ts`).
// `BAOX_CHROMIUM_CDP_PORT` (default 9333) picks the CDP port; `BAOX_ERP_CHROMIUM=off` never starts a browser (e2e),
// so a job then finds none and stops before any attempt.

export function dataDirBlobs(dataDir: string): BlobSource {
  return { read: async (ref) => new Uint8Array(readFileSync(blobPath(dataDir, ref.sha256))) };
}

/** The read-only 对账 job on the same dedicated Chromium; it never starts the browser (nothing to reconcile without it). */
export function cdpReconcileExecutor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ReconcileExecutor {
  return (plan, channel) => runReconcileJob(plan, { browser: cdpBrowser(cdpPortOf(env)), channel, probeWaitMs: 0 });
}

export function cdpFillExecutor({ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): FillExecutor {
  return async (plan, channel, { trigger }) => {
    const port = cdpPortOf(env);
    let launchError: Error | null = null;
    if (env['BAOX_ERP_CHROMIUM'] !== 'off') {
      try {
        await ensureChromium({ port, profileDir: join(dataDir, 'chromium-profile'), openUrl: erpEntryOf(plan.erpOrigin), env });
      } catch (error) {
        launchError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // 我已登录，继续 probes once; the first start waits for a slow ERP first screen, never for a login.
    return runFillJob(plan, { browser: cdpBrowser(port, launchError), blobs: dataDirBlobs(dataDir), channel, probeWaitMs: trigger === 'confirm_login' ? 0 : 30_000 });
  };
}

/** Both CDP executors on the dedicated Chromium under `dataDir`: what the development and e2e entries run ERP jobs on. */
export const cdpExecutors = (dataDir: string) => ({ erpExecutor: cdpFillExecutor({ dataDir }), reconcileExecutor: cdpReconcileExecutor() });
