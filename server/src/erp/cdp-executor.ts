import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobPath } from '../data-dir';
import { cdpBrowser, ensureChromium } from './executor/browser';
import { cdpPortOf } from './executor/chromium';
import { runFillJob } from './executor/job';
import { erpEntryOf } from './executor/probe';
import { runReconcileJob } from './executor/reconcile-job';
import type { FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { BlobSource } from './protocol';

// The v1 executor: in process, on the dedicated Chromium profile under the data directory (ADR-0016).
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
