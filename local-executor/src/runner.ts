// The local executor's end of the executor protocol (`@baox/erp-executor/wire`), the counterpart of the extension's
// `erp-runner.ts`: `erp.fill` and `erp.reconcile` arrive as channel requests, each runs in a headless Chromium of its
// own, and every executor event goes back through the job's link (`@baox/extension/job-link`), so `attempt_started`
// still waits for its durable ack and a dropped channel is resumed inside the reconnection window.
//
// What differs from the extension is the page's lifetime. Nobody sees this browser, so the job signs in with the
// employee's ERP 凭据 and, whatever happens, signs out and closes the browser at the end (ADR-0033). An unsaved form
// therefore never outlives its job: 对账 (reconcile) finds a fresh console, which is the truth about that form.
//
// The 凭据 arrive with each request (the app hosts them) and live only as long as it: nothing here writes them down.
// `erp.trySignIn` is the 试登录 after the employee saves them: sign in, sign out, close, and say how it went.

import type { CdpSession } from '@baox/erp-executor/cdp';
import { runFillJob, type BrowserPort } from '@baox/erp-executor/job';
import { waitFor, type Pace } from '@baox/erp-executor/pace';
import type { ChromiumPage } from '@baox/erp-executor/page';
import { sameOrigin } from '@baox/erp-executor/probe';
import { abortedResult, type BlobSource, type ResultEvent } from '@baox/erp-executor/protocol';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { navigationScene } from '@baox/erp-executor/scene';
import { signIn, signOut, type ErpCredentials, type SignInTiming } from '@baox/erp-executor/sign-in';
import { EXECUTOR_METHODS, FillRequestSchema, ReconcileRequestSchema, TrySignInRequestSchema, type TrySignInAnswer, type WireRequest } from '@baox/erp-executor/wire';
import { createJobLink, type AttachedPage, type ChannelWatch, type JobLink } from '@baox/extension/job-link';
import { CHANNEL_CLOSED } from '@baox/extension/messages';
import type { Headless } from './headless';

export type LocalRunnerPorts = {
  request: WireRequest;
  connection: ChannelWatch;
  blobs: BlobSource;
  /** A headless Chromium showing the ERP entry page. */
  launch(erpOrigin: string): Promise<Headless>;
  /** Parent of each job's invoice staging directory. */
  stagingRoot?: string;
  pace?: Pace;
  signInTiming?: SignInTiming;
  log?: (line: string) => void;
};

export const NO_CREDENTIALS = {
  code: 'erp_credentials_missing',
  message: '应用没有随这次任务发来报销系统账号密码，baox 本地执行器没有登录报销系统。报销系统没有被改动。',
} as const;
// A job that stopped on a navigation click leaves its page to be described before the browser goes: the employee
// cannot look at a headless page, and live 2026-10-12 one such stop (two visible 新增) left nothing to read.
const NAVIGATION_STOPS = new Set(['CHROMIUM_TARGET_NOT_FOUND', 'CHROMIUM_TARGET_NOT_UNIQUE', 'CHROMIUM_TARGET_OBSTRUCTED', 'ERP_NEW_FORM_NOT_OPENED']);

export const BUSY = { code: 'local_executor_busy', message: '这台电脑上的 baox 本地执行器正在运行另一次去报销。' } as const;

export function createLocalRunner(ports: LocalRunnerPorts): (method: string, payload: unknown) => Promise<ResultEvent | TrySignInAnswer> {
  const log = ports.log ?? (() => {});
  let busy = false;

  // One job: its browser, its link, and the end that always signs out and closes.
  async function inBrowser(jobId: string, erpOrigin: string, credentials: ErpCredentials | undefined, run: (job: { link: JobLink; headless: Headless; credentials: ErpCredentials; browser: BrowserPort }) => Promise<ResultEvent>): Promise<ResultEvent> {
    if (!credentials) return abortedResult(NO_CREDENTIALS.code, NO_CREDENTIALS.message);
    const headless = await ports.launch(erpOrigin);
    let current: AttachedPage | null = null;
    const link = createJobLink({
      jobId, erpOrigin, request: ports.request, channel: ports.connection,
      onInterrupted: ({ kind, reason }) => log(`job ${jobId} interrupted: ${kind} (${reason})`),
      // Only the channel can drop here: the browser is this process's own. The same page, never a new one.
      async reattach() {
        if (!current) return null;
        const targetId = current.targetId;
        const page = (await headless.browser.listPages().catch(() => [])).find((p) => String(p.cdpTargetId) === targetId);
        const attached = page ? await headless.browser.attach(page).catch(() => null) : null;
        return attached ? (current = { session: attached.session, targetId }) : null;
      },
    });
    const unwatch = ports.connection.onClosed(() => link.interrupt({ kind: 'channel_closed', reason: CHANNEL_CLOSED.message }));
    try {
      // The browser port as the job sees it: every session it attaches goes through the link, and the last one is
      // the page a reconnect goes back to.
      const browser: BrowserPort = {
        listPages: () => headless.browser.listPages(),
        async attach(page: ChromiumPage) {
          const attached = await headless.browser.attach(page);
          current = { session: attached.session, targetId: String(attached.cdpTargetId) };
          return { ...attached, session: link.adopt(current) };
        },
      };
      const result = await run({ link, headless, credentials, browser });
      if (result.status === 'aborted' && NAVIGATION_STOPS.has(result.code ?? '')) await describe(headless, erpOrigin, jobId);
      return result;
    } catch (error) {
      const own = link.ownResult();
      if (own) return own;
      throw error;
    } finally {
      unwatch();
      link.close();
      await leave(headless, erpOrigin);
    }
  }

  // The ERP page's navigation scene, into this PC's log only. ERP's own captions and counts, never business text.
  async function describe(headless: Headless, erpOrigin: string, jobId: string) {
    try {
      const page = (await headless.browser.listPages()).find((p) => sameOrigin(p.url, erpOrigin));
      if (!page) return log(`job ${jobId} scene: no ERP page`);
      const { session } = await headless.browser.attach(page);
      try { log(`job ${jobId} scene: ${JSON.stringify(await navigationScene(session))}`); } finally { session.close(); }
    } catch (error) {
      log(`job ${jobId} scene failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  // Sign out on the ERP page, then close. Neither may stop the other, and neither changes the job's result.
  async function leave(headless: Headless, erpOrigin: string) {
    try {
      const page = (await headless.browser.listPages()).find((p) => sameOrigin(p.url, erpOrigin));
      if (page) {
        const { session } = await headless.browser.attach(page);
        const out = await signOut(session, { origin: erpOrigin, verify: false });
        log(`signed out (HTTP ${out.httpStatus ?? 'none'})`);
        session.close();
      }
    } catch (error) {
      log(`sign-out failed: ${(error as Error)?.message ?? String(error)}`);
    }
    await headless.close().catch((error: unknown) => log(`closing the browser failed: ${String(error)}`));
  }

  const signInPort = (erpOrigin: string, credentials: ErpCredentials) => async (session: CdpSession) => {
    const outcome = await signIn(session, { origin: erpOrigin, credentials, ...(ports.signInTiming ? { timing: ports.signInTiming } : {}) });
    log(outcome.ok ? `signed in (${outcome.ms} ms)` : `sign-in failed: ${outcome.code}`);
    return outcome.ok ? { ok: true as const, submitted: outcome.submitted } : { ok: false as const, code: outcome.code, message: outcome.message };
  };

  // 试登录: a browser of its own, signed in and straight out again. A profile still signed in from before proves
  // nothing about these 凭据, so it is signed out first and the login is made with them.
  async function trySignIn(erpOrigin: string, credentials: ErpCredentials): Promise<TrySignInAnswer> {
    const headless = await ports.launch(erpOrigin);
    try {
      const page = await waitFor(async () => (await headless.browser.listPages()).find((p) => sameOrigin(p.url, erpOrigin)) ?? null, Boolean, 30_000, 500);
      if (!page) return { ok: false, code: 'erp_sign_in_no_form', message: 'baox 本地执行器的浏览器没有打开报销系统的页面。' };
      const { session } = await headless.browser.attach(page);
      try {
        let outcome = await signInPort(erpOrigin, credentials)(session);
        if (outcome.ok && !outcome.submitted) {
          await signOut(session, { origin: erpOrigin, verify: true });
          outcome = await signInPort(erpOrigin, credentials)(session);
        }
        return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, message: outcome.message };
      } finally {
        session.close();
      }
    } finally {
      await leave(headless, erpOrigin);
    }
  }

  return async (method, payload) => {
    if (method !== EXECUTOR_METHODS.fill && method !== EXECUTOR_METHODS.reconcile && method !== EXECUTOR_METHODS.trySignIn) throw new Error(`baox 本地执行器不认识 ${method}。`);
    if (busy) return method === EXECUTOR_METHODS.trySignIn ? { ok: false, code: BUSY.code, message: BUSY.message } : abortedResult(BUSY.code, BUSY.message);
    busy = true;
    try {
      if (method === EXECUTOR_METHODS.trySignIn) {
        const { erpOrigin, credentials } = TrySignInRequestSchema.parse(payload);
        log('试登录');
        return await trySignIn(erpOrigin, credentials);
      }
      if (method === EXECUTOR_METHODS.fill) {
        const { plan, credentials } = FillRequestSchema.parse(payload);
        log(`fill ${plan.jobId} for task ${plan.taskId}`);
        return await inBrowser(plan.jobId, plan.erpOrigin, credentials, ({ link, credentials, browser }) =>
          runFillJob(plan, {
            browser, blobs: ports.blobs, channel: link.channel, probeWaitMs: 30_000,
            signIn: signInPort(plan.erpOrigin, credentials),
            ...(ports.stagingRoot ? { stagingRoot: ports.stagingRoot } : {}),
            ...(ports.pace ? { pace: ports.pace } : {}),
          }));
      }
      const { plan, credentials } = ReconcileRequestSchema.parse(payload);
      log(`reconcile ${plan.jobId} for task ${plan.taskId}`);
      // The form a fill left behind closed with its browser: what is read now is a fresh console after sign-in.
      return await inBrowser(plan.jobId, plan.erpOrigin, credentials, ({ link, credentials, browser }) =>
        runReconcileJob(plan, {
          browser, channel: link.channel, signIn: signInPort(plan.erpOrigin, credentials),
          ...(ports.pace ? { pace: ports.pace } : {}),
        }));
    } finally {
      busy = false;
    }
  };
}
