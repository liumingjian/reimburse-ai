import { runFillJob } from '@baox/erp-executor/job';
import type { Pace } from '@baox/erp-executor/pace';
import { ExecutorError } from '@baox/erp-executor/page';
import type { BlobSource, ResultEvent } from '@baox/erp-executor/protocol';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { EXECUTOR_METHODS, FillRequestSchema, ReconcileRequestSchema, wireChannel, type FillRequest, type WireRequest } from '@baox/erp-executor/wire';
import type { ErpTab, TabChoice } from './erp-tab';

// The extension's end of #254's executor protocol (`@baox/erp-executor/wire`): `erp.fill` and `erp.reconcile` arrive
// as channel requests, the real executor runs them over the `chrome.debugger` adapter, and every executor event goes
// back as an `erp.event` request through `wireChannel`, so `attempt_started` waits for its durable ack before the
// first mutation.
//
// Which tab a job runs in (user story 14): `start` — 去报销 — always opens a new one. `confirm_login` (我已登录，继续)
// and `refill` (重新去报销) go back to the tab this task's last run used, where the employee just logged in or where the
// abandoned form is, and open a new one only when that tab is gone. 对账 (reconcile) reads the form in that tab
// and nowhere else: a fresh tab would show a blank console and hand the server a confident answer about the wrong page.
// The memory of those tabs is this worker's; it does not survive Chrome stopping the service worker (#257's to keep).

export type Interruption = { kind: 'debugger_detached' | 'channel_closed'; reason: string };

export type ErpRunnerPorts = {
  /** The job's browser: in the extension, `dedicatedErpTab` for the plan's ERP origin and the tab choice. */
  browser(erpOrigin: string, choice: TabChoice): ErpTab;
  request: WireRequest;
  blobs?: BlobSource;
  pace?: Pace;
  /**
   * The one path by which a running job learns it lost its footing: Chrome detached the debugger from its tab (the
   * banner's Cancel, the tab closed), or the channel to the app went away under an event. #257 resumes from here.
   */
  onInterrupted?: (jobId: string, interruption: Interruption) => void;
};

// Invoice bytes are #256's (a blob endpoint and an in-page `DataTransfer`). Until then the browser build stops at
// staging before it would ask for any, so nothing reaches this.
const NO_BLOBS: BlobSource = {
  read: () => Promise.reject(new ExecutorError('INVOICE_BLOBS_UNAVAILABLE', '这个版本的浏览器扩展还拿不到发票原件')),
};

const choiceFor = (trigger: FillRequest['trigger'], known: number | undefined): TabChoice =>
  ({ reuse: trigger === 'start' ? null : known ?? null, openIfGone: true });

export function createErpRunner(ports: ErpRunnerPorts): (method: string, payload: unknown) => Promise<ResultEvent> {
  const tabOfTask = new Map<string, number>();

  // The job's channel and browser, with both kinds of interruption funnelled into `onInterrupted`.
  const ready = (jobId: string, erpOrigin: string, choice: TabChoice) => {
    const interrupted = (interruption: Interruption) => ports.onInterrupted?.(jobId, interruption);
    const request: WireRequest = (method, body) => ports.request(method, body).catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'channel_closed') interrupted({ kind: 'channel_closed', reason: String((error as Error).message) });
      throw error;
    });
    const browser = ports.browser(erpOrigin, choice);
    browser.onDetached((reason) => interrupted({ kind: 'debugger_detached', reason }));
    return { channel: wireChannel(jobId, request), browser };
  };
  const remember = (taskId: string, browser: ErpTab) => {
    const tabId = browser.tabId();
    if (tabId !== null) tabOfTask.set(taskId, tabId);
  };

  return async (method, payload) => {
    if (method === EXECUTOR_METHODS.fill) {
      const { plan, trigger } = FillRequestSchema.parse(payload);
      const { channel, browser } = ready(plan.jobId, plan.erpOrigin, choiceFor(trigger, tabOfTask.get(plan.taskId)));
      try {
        return await runFillJob(plan, {
          browser, blobs: ports.blobs ?? NO_BLOBS, channel,
          ...(ports.pace ? { pace: ports.pace } : {}),
          // As the server's own executor does: 我已登录，继续 probes the login once instead of waiting for it.
          probeWaitMs: trigger === 'confirm_login' ? 0 : 30_000,
        });
      } finally {
        remember(plan.taskId, browser);
      }
    }
    if (method === EXECUTOR_METHODS.reconcile) {
      const { plan } = ReconcileRequestSchema.parse(payload);
      const { channel, browser } = ready(plan.jobId, plan.erpOrigin, { reuse: tabOfTask.get(plan.taskId) ?? null, openIfGone: false });
      return runReconcileJob(plan, { browser, channel, ...(ports.pace ? { pace: ports.pace } : {}) });
    }
    throw new Error(`这个扩展不认识 ${method}。`);
  };
}
