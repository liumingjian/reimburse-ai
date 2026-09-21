import { stageInPage } from '@baox/erp-executor/invoice-files';
import { runFillJob } from '@baox/erp-executor/job';
import type { Pace } from '@baox/erp-executor/pace';
import { ExecutorError } from '@baox/erp-executor/page';
import type { BlobSource, ResultEvent } from '@baox/erp-executor/protocol';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { EXECUTOR_METHODS, FillRequestSchema, ReconcileRequestSchema, type FillRequest, type WireRequest } from '@baox/erp-executor/wire';
import type { ErpTab, TabChoice } from './erp-tab';
import { CHANNEL_CLOSED } from './messages';
import { createJobLink, type AttachedPage, type ChannelWatch, type Interruption, type JobLink } from './job-link';

export type { ChannelWatch, Interruption } from './job-link';

// The extension's end of #254's executor protocol (`@baox/erp-executor/wire`): `erp.fill` and `erp.reconcile` arrive
// as channel requests, the real executor runs them over the `chrome.debugger` adapter, and every executor event goes
// back as an `erp.event` request through the job's link, so `attempt_started` waits for its durable ack before the
// first mutation.
//
// Which tab a job runs in (user story 14): `start` — 去报销 — always opens a new one. `confirm_login` (我已登录，继续)
// and `refill` (重新去报销) go back to the tab this task's last run used, where the employee just logged in or where the
// abandoned form is, and open a new one only when that tab is gone. 对账 (reconcile) reads the form in that tab
// and nowhere else: a fresh tab would show a blank console and hand the server a confident answer about the wrong page.
//
// An interruption — the debugger detached, or the channel closed — is resumed inside the reconnection window by the
// job's link (`job-link.ts`, #257), in the same tab.
//
// Neither the tabs nor a running job survive Chrome stopping the service worker, and that is deliberate. The run is
// the executor's own call stack: where it stood, its staged invoices, the event it was waiting on, the child session
// it held. Persisting a jobId, a tab and the last observation would let a new worker send `erp.resume` and get
// `ok: true`, and then it could only end the job, which the window's expiry does too, with the same disposition from
// the server. A half-right reconstruction that carried on instead would vouch for a run nobody holds. So after a
// restart the window expires and the server decides: `aborted` in place without an attempt, 对账 with one.

export type ErpRunnerPorts = {
  /** The job's browser: in the extension, `dedicatedErpTab` for the plan's ERP origin and the tab choice. */
  browser(erpOrigin: string, choice: TabChoice): ErpTab;
  request: WireRequest;
  /** The channel's comings and goings: a running job stops when it goes and resumes once it is `ready` again. */
  connection: ChannelWatch;
  /** The invoice originals, from the app (`serverBlobs`). Without one, a fill stops before the page is touched. */
  blobs?: BlobSource;
  pace?: Pace;
  /**
   * The one path by which a running job learns it lost its footing: Chrome detached the debugger from its tab (the
   * banner's Cancel, the tab closed), or the channel to the app went away. The job's link resumes from here; this
   * only hears about it.
   */
  onInterrupted?: (jobId: string, interruption: Interruption) => void;
};

const choiceFor = (trigger: FillRequest['trigger'], known: number | undefined): TabChoice =>
  ({ reuse: trigger === 'start' ? null : known ?? null, openIfGone: true });

const NO_BLOBS: BlobSource = {
  read: () => Promise.reject(new ExecutorError('INVOICE_BLOB_UNAVAILABLE', '这个浏览器扩展拿不到发票原件。报销系统没有被改动。')),
};

export function createErpRunner(ports: ErpRunnerPorts): (method: string, payload: unknown) => Promise<ResultEvent> {
  const tabOfTask = new Map<string, number>();

  // Chrome's detach from a job's tab is that job's interruption.
  const watched = (link: JobLink, tab: ErpTab) => {
    tab.onDetached((reason) => link.interrupt({ kind: 'debugger_detached', reason }));
    return tab;
  };

  // The job's channel and browser, both held by its link, with both kinds of interruption funnelled into
  // `link.interrupt`. `settle` answers for a run the link ended with the link's own `aborted` result.
  const ready = (jobId: string, erpOrigin: string, choice: TabChoice) => {
    const link: JobLink = createJobLink({
      jobId, erpOrigin, request: ports.request, channel: ports.connection,
      onInterrupted: (interruption) => ports.onInterrupted?.(jobId, interruption),
      // The same tab or none: `openIfGone: false` never opens one.
      async reattach(): Promise<AttachedPage | null> {
        const tabId = tab.tabId();
        if (tabId === null) return null;
        const again = watched(link, ports.browser(erpOrigin, { reuse: tabId, openIfGone: false }));
        const [page] = await again.listPages().catch(() => []);
        const attached = page ? await again.attach(page).catch(() => null) : null;
        return attached ? { session: attached.session, targetId: String(attached.cdpTargetId) } : null;
      },
    });
    const tab = watched(link, ports.browser(erpOrigin, choice));
    const unwatch = ports.connection.onClosed(() => link.interrupt({ kind: 'channel_closed', reason: CHANNEL_CLOSED.message }));
    const browser: ErpTab = {
      ...tab,
      async attach(page) {
        const attached = await tab.attach(page);
        return { ...attached, session: link.adopt({ session: attached.session, targetId: String(attached.cdpTargetId) }) };
      },
    };
    const settle = async (run: Promise<ResultEvent>): Promise<ResultEvent> => {
      try {
        return await run;
      } catch (error) {
        const own = link.ownResult();
        if (own) return own;
        throw error;
      } finally {
        unwatch();
        link.close();
      }
    };
    return { channel: link.channel, browser, settle };
  };
  const remember = (taskId: string, browser: ErpTab) => {
    const tabId = browser.tabId();
    if (tabId !== null) tabOfTask.set(taskId, tabId);
  };

  return async (method, payload) => {
    if (method === EXECUTOR_METHODS.fill) {
      const { plan, trigger } = FillRequestSchema.parse(payload);
      const { channel, browser, settle } = ready(plan.jobId, plan.erpOrigin, choiceFor(trigger, tabOfTask.get(plan.taskId)));
      try {
        return await settle(runFillJob(plan, {
          // Invoices go into the page as bytes: the extension has no local path to give the file input (ADR-0021).
          browser, blobs: ports.blobs ?? NO_BLOBS, staging: stageInPage, channel,
          ...(ports.pace ? { pace: ports.pace } : {}),
          // As the server's own executor does: 我已登录，继续 probes the login once instead of waiting for it.
          probeWaitMs: trigger === 'confirm_login' ? 0 : 30_000,
        }));
      } finally {
        remember(plan.taskId, browser);
      }
    }
    if (method === EXECUTOR_METHODS.reconcile) {
      const { plan } = ReconcileRequestSchema.parse(payload);
      const { channel, browser, settle } = ready(plan.jobId, plan.erpOrigin, { reuse: tabOfTask.get(plan.taskId) ?? null, openIfGone: false });
      return settle(runReconcileJob(plan, { browser, channel, ...(ports.pace ? { pace: ports.pace } : {}) }));
    }
    throw new Error(`这个扩展不认识 ${method}。`);
  };
}
