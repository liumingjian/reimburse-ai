import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobPath } from '../data-dir';
import { cdpBrowser, ensureChromium } from '@baox/erp-executor/browser';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import type { CdpSession } from '@baox/erp-executor/cdp';
import { runFillJob } from '@baox/erp-executor/job';
import { erpEntryOf } from '@baox/erp-executor/probe';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { signIn, type ErpCredentials } from '@baox/erp-executor/sign-in';
import type { FillExecutor } from './fill-jobs';
import type { ReconcileExecutor } from './reconcile-job';
import type { BlobSource } from '@baox/erp-executor/protocol';

// The v1 executor: in process, on the dedicated Chromium profile under the data directory (ADR-0016). Since #246 it is
// for development, e2e and `pnpm test:erp-live` only (#227): the production entry cannot reach this module, and runs
// every job in the task owner's paired 本地执行器 instead (`remote-executor.ts`, `production-entry.test.ts`).
// It runs the production path (ADR-0037): it signs in with the account's hosted ERP 凭据, as the 本地执行器 does, and
// every fill ends at 暂存 (the plan's `draft`). Its Chromium stays headed, so a developer sees what it does.
// `BAOX_CHROMIUM_CDP_PORT` (default 9333) picks the CDP port; `BAOX_ERP_CHROMIUM=off` never starts a browser (e2e),
// so a job then finds none and stops before any attempt.

export function dataDirBlobs(dataDir: string): BlobSource {
  return { read: async (ref) => new Uint8Array(readFileSync(blobPath(dataDir, ref.sha256))) };
}

/** Sign in on the ERP login page with the account's 凭据, as the 本地执行器 does; nothing to sign in with, no port. */
function signInWith(erpOrigin: string, credentials: ErpCredentials | null) {
  if (!credentials) return {};
  return {
    signIn: async (session: CdpSession) => {
      const outcome = await signIn(session, { origin: erpOrigin, credentials });
      return outcome.ok ? { ok: true as const } : { ok: false as const, code: outcome.code, message: outcome.message };
    },
  };
}

/** The read-only 对账 job on the same dedicated Chromium; it never starts the browser (nothing to reconcile without it). */
export function cdpReconcileExecutor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ReconcileExecutor {
  return (plan, channel, options) => runReconcileJob(plan, { browser: cdpBrowser(cdpPortOf(env)), channel, probeWaitMs: 0, ...signInWith(plan.erpOrigin, options?.credentials ?? null) });
}

export function cdpFillExecutor({ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }): FillExecutor {
  return async (plan, channel, { credentials }) => {
    const port = cdpPortOf(env);
    let launchError: Error | null = null;
    if (env['BAOX_ERP_CHROMIUM'] !== 'off') {
      try {
        await ensureChromium({ port, profileDir: join(dataDir, 'chromium-profile'), openUrl: erpEntryOf(plan.erpOrigin), env });
      } catch (error) {
        launchError = error instanceof Error ? error : new Error(String(error));
      }
    }
    // The probe waits for a slow ERP first screen, never for a login: the job signs in itself.
    return runFillJob(plan, { browser: cdpBrowser(port, launchError), blobs: dataDirBlobs(dataDir), channel, probeWaitMs: 30_000, ...signInWith(plan.erpOrigin, credentials) });
  };
}

/** Both CDP executors on the dedicated Chromium under `dataDir`: what the development and e2e entries run ERP jobs on. */
export const cdpExecutors = (dataDir: string) => ({ erpExecutor: cdpFillExecutor({ dataDir }), reconcileExecutor: cdpReconcileExecutor() });
