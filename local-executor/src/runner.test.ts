// The local executor's runner over the fake ERP: the real executor runs through it, the fake stands in for the headless
// browser, and a small app at the other end records the wire. What is asserted is what the app and the employee's PC
// can observe: which events went out, how the job ended, and that the browser never outlives the job.
import type { ErpBrowserMode } from '@baox/contract';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ExecutorEvent, type FillPlan } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErpOptions, type FakeInvoice } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS } from '@baox/erp-executor/wire';
import { channelWatch } from '@baox/channel/connection';
import { BUSY, NO_CREDENTIALS, createLocalRunner } from './runner';

const ERP_ORIGIN = 'http://erp.antute.com.cn';
const FAST_PACE = { quietMs: 2, pollMs: 1, settleMs: 2, longMs: 2000 };
const FAST_SIGN_IN = { formMs: 30, readyMs: 30, quietMs: 1, consoleMs: 30, noEffectMs: 10, stuckMs: 5, pollMs: 1 };
const PROJECTS = [{ code: '39163', name: '中国农业发展银行河南省分行-20-2614' }];
const EXPENSE_ITEMS = [{ code: 'FY010003', name: '长途交通' }];
const INVOICE: FakeInvoice & { fileName: string } = {
  fileName: '铁路电子客票.pdf', bytes: new TextEncoder().encode('%PDF-1.4\n% fake rail e-ticket 26427000000640558021\n%%EOF\n'),
  invoiceNumber: '26427000000640558021', receiptNumber: 'SPD202609040022', seller: '中国铁路广州局集团有限公司', issueDate: '2026-09-04',
  net: '644.95', tax: '58.05', gross: '703.00', category: '电子铁路客票',
};
const plan: FillPlan = {
  protocolVersion: PROTOCOL_VERSION, kind: 'fill', jobId: 'job-1', taskId: 'task-1', erpOrigin: ERP_ORIGIN,
  compatibility: { erpBuild: '8.2.830.9', formId: 'ER_ExpReimbursement' },
  catalog: { projects: PROJECTS, expenseItems: EXPENSE_ITEMS },
  invoices: [{ sha256: createHash('sha256').update(INVOICE.bytes).digest('hex'), fileName: INVOICE.fileName, mime: 'application/pdf' }],
  purpose: '客户支持', draft: { mark: 'baox-k3m9q2x7v1' },
};

/** The app: records each `erp.event`, acknowledges attempts and refuses read-backs, so a fill ends right after import. */
function app(onResult: () => void = () => {}) {
  const connection = channelWatch();
  connection.status({ state: 'ready', accountId: 'account-1' });
  const log: ExecutorEvent[] = [];
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    if (method !== EXECUTOR_METHODS.event) return null;
    const event = (raw as { event: ExecutorEvent }).event;
    log.push(event);
    if (event.type === 'attempt_started') return { persisted: true };
    if (event.type === 'readback') return { ok: false, reasons: ['测试里的应用不判定回读'] };
    if (event.type === 'result') onResult();
    return null;
  };
  return { connection, request, log };
}

type LocalOptions = {
  erp?: Partial<FakeErpOptions>;
  credentials?: { account: string; password: string } | null;
  /** What the app does on a job's result, the way the server starts an 自动重新去报销 on it. */
  onResult?: () => void;
  /** How long closing a browser takes; a sign-out and close is never instant. */
  closeMs?: number;
  closingWaitMs?: number;
};

async function localOver({ erp, credentials = { account: 'tester', password: 'secret' }, onResult, closeMs = 0, closingWaitMs }: LocalOptions = {}) {
  const fake = await createFakeErp({ origin: ERP_ORIGIN, invoices: [INVOICE], projects: PROJECTS, expenseItems: EXPENSE_ITEMS, ...erp });
  const the = app(onResult);
  const browsers = { launched: 0, closed: 0 };
  const order: string[] = [];
  const modes: ErpBrowserMode[] = [];
  const lines: string[] = [];
  const run = createLocalRunner({
    request: the.request,
    connection: the.connection,
    blobs: { read: async () => INVOICE.bytes },
    launch: async (_origin, mode) => {
      modes.push(mode);
      browsers.launched += 1;
      order.push('launched');
      return {
        port: 0, browser: fake.browser,
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, closeMs));
          browsers.closed += 1;
          order.push('closed');
        },
      };
    },
    ...(closingWaitMs === undefined ? {} : { closingWaitMs }),
    pace: FAST_PACE,
    signInTiming: FAST_SIGN_IN,
    log: (line) => lines.push(line),
  });
  const sent = credentials ? { credentials } : {};
  return {
    fake, events: the.log, browsers, order, modes, lines, run,
    fill: (browserMode?: unknown) => run(EXECUTOR_METHODS.fill, { plan, trigger: 'start', ...sent, ...(browserMode === undefined ? {} : { browserMode }) }),
    reconcile: (browserMode?: unknown) => run(EXECUTOR_METHODS.reconcile, { plan: { protocolVersion: PROTOCOL_VERSION, kind: 'reconcile', jobId: 'reconcile-1', taskId: 'task-1', erpOrigin: ERP_ORIGIN }, ...sent, ...(browserMode === undefined ? {} : { browserMode }) }),
    trySignIn: (browserMode?: unknown) => run(EXECUTOR_METHODS.trySignIn, { erpOrigin: ERP_ORIGIN, credentials: credentials ?? { account: 'tester', password: 'secret' }, ...(browserMode === undefined ? {} : { browserMode }) }),
  };
}

describe('the local executor runs a 去报销 in a headless browser of its own', () => {
  // Live 2026-10-12 round 9 stopped on two visible 新增 and the browser closed with nothing to read.
  it('describes the page in its own log when a navigation click stops the job, then still signs out and closes', async () => {
    const local = await localOver({ erp: { newFormClickDead: true } });
    const result = await local.fill();
    expect(result).toMatchObject({ type: 'result', status: 'aborted', code: 'ERP_NEW_FORM_NOT_OPENED' });
    const scene = local.lines.find((line) => line.startsWith('job job-1 scene: '));
    expect(JSON.parse(scene!.slice('job job-1 scene: '.length))).toMatchObject({ captions: { 新增: { visible: 1 } } });
    expect(scene).not.toContain(INVOICE.invoiceNumber);
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });

  it('runs the job in a browser it launched, then signs out and closes it', async () => {
    const local = await localOver();
    const result = await local.fill();
    // The app here refuses the read-back after import, so the job ends there, as 写入结果未知 — past the login probe,
    // the catalog check, the navigation and the import attempt, which is all this seam carries.
    expect(result).toMatchObject({ type: 'result', status: 'unknown', code: 'receipt_readback' });
    expect(local.events.filter((e) => e.type === 'attempt_started').map((e) => e.type === 'attempt_started' && e.action)).toEqual(['import']);
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
    expect(local.lines.some((line) => line.startsWith('signed out'))).toBe(true);
  });

  it('signs in on the login page and ends with the sign-in\'s own reason when it cannot, before any attempt', async () => {
    const local = await localOver({ erp: { loggedIn: false } });
    const result = await local.fill();
    expect(result).toMatchObject({ status: 'aborted', code: expect.stringMatching(/^erp_sign_in_/) });
    expect(local.events.some((e) => e.type === 'attempt_started')).toBe(false);
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });

  it('launches nothing when the app sent no ERP 凭据 with the job', async () => {
    const local = await localOver({ credentials: null });
    expect(await local.fill()).toMatchObject({ status: 'aborted', code: NO_CREDENTIALS.code });
    expect(local.browsers.launched).toBe(0);
  });

  it('runs one job at a time', async () => {
    const local = await localOver();
    const [first, second] = await Promise.all([local.fill(), local.fill()]);
    expect(first).not.toMatchObject({ code: BUSY.code });
    expect(second).toMatchObject({ status: 'aborted', code: BUSY.code });
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });

  // QA 2026-10-19: a fill ended 写入结果未知, the app started its 自动重新去报销 67 ms later, and the runner -- still
  // signing out and closing the first browser -- turned it away as busy.
  it('takes a job that arrives while the last one is only signing out, once its browser has closed', async () => {
    let next: Promise<unknown> | null = null;
    const local: Awaited<ReturnType<typeof localOver>> = await localOver({ closeMs: 50, onResult: () => { next ??= local.fill(); } });
    await local.fill();
    const rerun = await next!;
    expect(rerun).not.toMatchObject({ code: BUSY.code });
    expect(local.order).toEqual(['launched', 'closed', 'launched', 'closed']);
  });

  it('is still busy for a job that arrives while the last one\'s browser takes too long to close', async () => {
    let next: Promise<unknown> | null = null;
    const local: Awaited<ReturnType<typeof localOver>> = await localOver({ closeMs: 200, closingWaitMs: 20, onResult: () => { next ??= local.fill(); } });
    await local.fill();
    expect(await next!).toMatchObject({ status: 'aborted', code: BUSY.code });
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });

  it('reads a fresh console for 对账, because the fill\'s form closed with its browser', async () => {
    const local = await localOver();
    const result = await local.reconcile();
    expect(result).toMatchObject({ type: 'result', status: 'read' });
    expect(local.events.find((e) => e.type === 'readback')).toMatchObject({ stage: 'reconcile' });
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });
});

describe('试登录', () => {
  it('answers with the sign-in\'s own reason in a browser of its own, then closes it', async () => {
    const local = await localOver({ erp: { loggedIn: false } });
    expect(await local.trySignIn()).toMatchObject({ ok: false, code: expect.stringMatching(/^erp_sign_in_/) });
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
    expect(local.events).toEqual([]);
  });

  it('is turned away while a job runs, without a second browser', async () => {
    const local = await localOver();
    const [, trial] = await Promise.all([local.fill(), local.trySignIn()]);
    expect(trial).toEqual({ ok: false, code: BUSY.code, message: BUSY.message });
    expect(local.browsers).toEqual({ launched: 1, closed: 1 });
  });
});


describe('request browser mode', () => {
  for (const method of ['fill', 'reconcile', 'trySignIn'] as const) {
    it.each([undefined, 'headless', 'headed'] as const)(`${method} launches %s and always closes without logging credentials`, async (mode) => {
      const local = await localOver();
      await local[method](mode);
      expect(local.modes).toEqual([mode ?? 'headless']);
      expect(local.browsers).toEqual({ launched: 1, closed: 1 });
      expect(local.lines.join('\n')).not.toContain('secret');
      expect(local.lines.join('\n')).not.toContain('tester');
      expect(local.run.busy()).toBe(false);
    });

    it(`${method} rejects an unsupported mode before opening a browser`, async () => {
      const local = await localOver();
      await expect(local[method]('visible')).rejects.toThrow();
      expect(local.browsers).toEqual({ launched: 0, closed: 0 });
      expect(local.run.busy()).toBe(false);
    });
  }

  it('captures the request mode before waiting for the previous browser to close', async () => {
    const payload = { plan, trigger: 'start', credentials: { account: 'tester', password: 'secret' }, browserMode: 'headed' };
    let next: Promise<unknown> | undefined;
    const local: Awaited<ReturnType<typeof localOver>> = await localOver({ closeMs: 50, onResult: () => {
      if (next) return;
      next = local.run(EXECUTOR_METHODS.fill, payload);
      payload.browserMode = 'headless';
    } });
    await local.fill();
    await next;
    expect(local.modes).toEqual(['headless', 'headed']);
    expect(local.order).toEqual(['launched', 'closed', 'launched', 'closed']);
  });
});
