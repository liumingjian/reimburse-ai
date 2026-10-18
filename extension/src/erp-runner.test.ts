// Seam 1 of spec #246: the extension's `chrome.debugger` adapter implements the executor's `CdpSession`, so the stateful
// fake ERP drives it with no new page tests. Here the real executor runs through the runner, the job-tab `BrowserPort`
// and the adapter, with `chrome.*` faked over the fake ERP, speaking #254's wire protocol. What is asserted is what the
// employee and the server can observe: which tabs were touched, which protocol events went out, what changed in ERP.
// (The full run to hand-over, through the same adapter, is `server/src/erp/parity.test.ts` against the kernel golden.)
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ExecutorEvent, type FillPlan, type ReconcilePlan } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErpOptions, type FakeInvoice } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS, JOB_REFUSALS, type FillRequest, type PageObservation, type ResumeVerdict } from '@baox/erp-executor/wire';
import { channelWatch } from '@baox/channel/connection';
import type { DebuggerApi } from './debugger-session';
import { createErpRunner, type Interruption } from './erp-runner';
import { dedicatedErpTab, type ErpTab } from './erp-tab';
import { DETACHED_MID_COMMAND } from '@baox/channel/job-link';
import { fakeChrome, type FakeChromeOptions } from './testing/fake-chrome';

const ERP_ORIGIN = 'http://erp.antute.com.cn';
const ENTRY = `${ERP_ORIGIN}/k3cloud/html5/index.aspx`;
const FAST_PACE = { quietMs: 2, pollMs: 1, settleMs: 2, longMs: 2000 };
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
  purpose: '客户支持',
};
const reconcilePlan: ReconcilePlan = { protocolVersion: PROTOCOL_VERSION, kind: 'reconcile', jobId: 'reconcile-1', taskId: 'task-1', erpOrigin: ERP_ORIGIN };

// An error as the channel client rejects a request with it.
const failure = (code: string, message = '和应用的连接断开了。') => Object.assign(new Error(message), { code });

type Hook = (event: ExecutorEvent) => 'drop' | void;

type WireEntry = { method: string; payload: { jobId: string; event?: ExecutorEvent; last?: PageObservation; now?: PageObservation } };

/**
 * The app at the other end of the channel, as far as one job goes. Like the server it records every `erp.event`,
 * acknowledges an attempt once it is on record and refuses read-backs, so a fill ends right after its import — past
 * the login probe, the 报销信息核对, the navigation and the piaozone child session, which is all the transport there
 * is. Like the server it refuses events with `resume_required` while the job is interrupted, and answers `erp.resume`
 * with how many events are on record when the two observations agree (or with `verdict`).
 *
 * `before` / `after` run around the record of each event; `'drop'` loses the socket there, so the event either never
 * reached the record or reached it and lost its answer. The socket comes back a moment later, as the client redials.
 */
function appOver(fake: { commands: unknown[] }, { before, after, verdict }: { before?: Hook; after?: Hook; verdict?: ResumeVerdict | Error } = {}) {
  const connection = channelWatch();
  const ready = () => connection.status({ state: 'ready', accountId: 'account-1' });
  ready();
  const wire: WireEntry[] = [];
  const log: ExecutorEvent[] = [];
  const refused: string[] = [];
  const resumes: Array<{ last: PageObservation; now: PageObservation; commandsAt: number }> = [];
  let up = true;
  let interrupted = false;
  const drop = () => {
    up = false;
    interrupted = true;
    connection.status({ state: 'offline', retryInMs: 5 });
    setTimeout(() => {
      up = true;
      ready();
    }, 5);
    return failure('channel_closed');
  };
  const request = async (method: string, raw: unknown): Promise<unknown> => {
    if (!up) throw failure('channel_closed');
    const payload = raw as WireEntry['payload'];
    wire.push({ method, payload });
    if (method === EXECUTOR_METHODS.detached) {
      interrupted = true;
      return null;
    }
    if (method === EXECUTOR_METHODS.resume) {
      resumes.push({ last: payload.last!, now: payload.now!, commandsAt: fake.commands.length });
      if (verdict instanceof Error) throw verdict;
      const answer = verdict ?? (JSON.stringify(payload.last) === JSON.stringify(payload.now) ? { ok: true, recorded: log.length } : { ok: false, reasons: ['页面变了'] });
      if (answer.ok) interrupted = false;
      return answer;
    }
    const event = payload.event!;
    if (interrupted) {
      refused.push(event.type);
      throw failure(JOB_REFUSALS.resumeRequired, '要先恢复');
    }
    if (before?.(event) === 'drop') throw drop();
    log.push(event);
    if (after?.(event) === 'drop') throw drop();
    if (event.type === 'attempt_started') return { persisted: true };
    if (event.type === 'readback') return { ok: false, reasons: ['测试里的服务器不判定回读'] };
    return null;
  };
  // What reached the app, in order: an event by its type, anything else by its method.
  const said = () => wire.map((entry) => entry.payload.event?.type ?? entry.method);
  return { connection, request, wire, log, refused, resumes, said };
}

type Over = {
  erp?: Partial<FakeErpOptions>;
  chrome?: FakeChromeOptions;
  app?: Parameters<typeof appOver>[1];
  // Stands between the adapter and the fake `chrome.debugger`, to cut a command off.
  debugger?: (api: DebuggerApi) => DebuggerApi;
};

/** The extension's runner over a fake ERP, with `chrome.*` faked over it and the app as above. */
async function extensionOver(over: Over = {}) {
  const fake = await createFakeErp({ origin: ERP_ORIGIN, invoices: [INVOICE], projects: PROJECTS, expenseItems: EXPENSE_ITEMS, ...over.erp });
  const chrome = fakeChrome(fake.session, over.chrome);
  const debuggerApi = over.debugger ? over.debugger(chrome.debugger) : chrome.debugger;
  const app = appOver(fake, over.app);
  const interruptions: Array<{ jobId: string } & Interruption> = [];
  const ports: ErpTab[] = [];
  const run = createErpRunner({
    browser: (erpOrigin, choice) => {
      const port = dedicatedErpTab({ erpOrigin, choice, tabs: chrome.tabs, windows: chrome.windows, debugger: debuggerApi, pollMs: 1 });
      ports.push(port);
      return port;
    },
    request: app.request,
    connection: app.connection,
    blobs: { read: async () => INVOICE.bytes },
    pace: FAST_PACE,
    onInterrupted: (jobId, interruption) => interruptions.push({ jobId, ...interruption }),
  });
  return {
    fake, chrome, app, events: app.log, interruptions, ports,
    fill: (trigger: FillRequest['trigger'] = 'start') => run(EXECUTOR_METHODS.fill, { plan, trigger }),
    reconcile: () => run(EXECUTOR_METHODS.reconcile, { plan: reconcilePlan }),
  };
}

const stepsDone = (events: ExecutorEvent[]) => events.flatMap((e) => (e.type === 'step' && e.status === 'done' ? [e.step] : []));
const inputCount = (fake: { commands: Array<{ method: string }> }) => fake.commands.filter((c) => c.method.startsWith('Input.')).length;
// A job's log, told apart by what each event says rather than by ids minted per run.
const journal = (events: ExecutorEvent[]) => events.map((e) => (e.type === 'step' ? `${e.step} ${e.status}` : e.type === 'attempt_started' ? `attempt ${e.action}` : e.type));
const isStep = (step: string, status: string) => (event: ExecutorEvent) => event.type === 'step' && event.step === step && event.status === status;

describe('a 去报销 run by the extension over chrome.debugger', () => {
  it('opens its own ERP tab, attaches to that tab only, and brings it to the front', async () => {
    const extension = await extensionOver({ chrome: { employeeTabs: [ENTRY, 'https://example.com/'] } });
    const result = await extension.fill();

    expect(result.code).toBe('receipt_readback');
    const job = extension.chrome.jobTab()!;
    expect(job).toMatchObject({ id: 3, url: ENTRY, active: true });
    expect(extension.chrome.attached).toEqual([{ tabId: job.id }]);
    expect(extension.chrome.focusedWindows).toEqual([job.windowId]);
    // The debugger is let go when the job ends; the tab stays for the employee.
    await expect(extension.chrome.debugger.sendCommand({ tabId: job.id }, 'Runtime.evaluate', {})).rejects.toThrow(/not attached/);
  });

  it('refuses to attach to any tab but its own', async () => {
    const fake = await createFakeErp({ origin: ERP_ORIGIN, invoices: [INVOICE], projects: PROJECTS, expenseItems: EXPENSE_ITEMS });
    const chrome = fakeChrome(fake.session, { employeeTabs: [ENTRY] });
    const port = dedicatedErpTab({ erpOrigin: ERP_ORIGIN, tabs: chrome.tabs, windows: chrome.windows, debugger: chrome.debugger, pollMs: 1 });
    const [page] = await port.listPages();

    await expect(port.attach({ ...page!, tabId: '1', cdpTargetId: 'tab-1' })).rejects.toMatchObject({ code: 'ERP_TAB_NOT_OURS' });
    expect(chrome.attached).toEqual([]);
  });

  it('runs the login probe and the master-data check, then reaches the piaozone frame as a child session', async () => {
    const extension = await extensionOver();
    const result = await extension.fill();

    expect(stepsDone(extension.events)).toEqual(['chromium', 'login', 'catalog', 'compatibility', 'navigate', 'import']);
    expect(extension.events.find((e) => e.type === 'attempt_started')).toMatchObject({ action: 'import', erpAccount: { account: 'luo.liu', tenant: 'tenant-a' } });
    expect(result).toMatchObject({ type: 'result', status: 'unknown', code: 'receipt_readback' });
    // The upload and the import both happened inside the assistant's own session, addressed through the adapter.
    expect(extension.fake.commands.some((c) => c.sessionId === 'piaozone-session-1' && c.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(extension.fake.mutations.map((m) => m.kind)).toEqual(['import']);
    expect(extension.ports[0]!.focusEmulation()).toEqual({ ok: true });
    // Every event went back as an `erp.event` request for this job.
    expect(new Set(extension.app.wire.map((r) => `${r.method} ${r.payload.jobId}`))).toEqual(new Set([`${EXECUTOR_METHODS.event} job-1`]));
  });

  it('waits for the employee to log in, then continues in the same tab', async () => {
    const extension = await extensionOver({ erp: { loggedIn: false } });

    expect(await extension.fill()).toMatchObject({ status: 'waiting_login', code: 'erp_login' });
    expect(extension.events.some((e) => e.type === 'attempt_started')).toBe(false);
    const loginTab = extension.chrome.jobTab()!.id;

    await extension.fake.login();
    await extension.fill('confirm_login');

    expect(extension.chrome.jobTab()!.id).toBe(loginTab);
    expect(extension.chrome.attached).toEqual([{ tabId: loginTab }, { tabId: loginTab }]);
    expect(stepsDone(extension.events)).toContain('catalog');
  });

  it('opens a fresh tab for every new 去报销', async () => {
    const extension = await extensionOver({ erp: { projects: [{ code: '39163', name: '别的项目' }] } });
    await extension.fill();
    const first = extension.chrome.jobTab()!.id;
    await extension.fill('start');

    expect(extension.chrome.jobTab()!.id).not.toBe(first);
  });

  it('stops on a master-data mismatch before anything is written', async () => {
    const extension = await extensionOver({ erp: { projects: [{ code: '39163', name: '别的项目' }] } });
    const result = await extension.fill();

    expect(result.status).toBe('catalog_mismatch');
    expect(extension.events.find((e) => e.type === 'catalog_mismatch')).toMatchObject({ problems: [{ kind: 'project', code: '39163', verdict: 'name_mismatch' }] });
    expect(extension.fake.mutations).toEqual([]);
    expect(inputCount(extension.fake)).toBe(0);
  });

  it('carries on when the tab refuses focus emulation, and keeps the refusal', async () => {
    const extension = await extensionOver({ chrome: { refuse: { 'Emulation.setFocusEmulationEnabled': "'Emulation.setFocusEmulationEnabled' wasn't found" } } });
    await extension.fill();

    expect(extension.ports[0]!.focusEmulation()).toMatchObject({ ok: false });
    expect(stepsDone(extension.events)).toContain('import');
  });

  it('reconciles by reading the tab the fill left, and never opens one to read', async () => {
    const extension = await extensionOver();
    expect(await extension.reconcile()).toMatchObject({ status: 'aborted', code: 'ERP_TAB_GONE' });
    expect(extension.chrome.jobTab()).toBeNull();

    await extension.fill();
    const fillTab = extension.chrome.jobTab()!.id;
    const inputsBefore = inputCount(extension.fake);

    expect(await extension.reconcile()).toMatchObject({ status: 'read' });
    expect(extension.chrome.attached.at(-1)).toEqual({ tabId: fillTab });
    expect(extension.events.find((e) => e.type === 'readback' && e.stage === 'reconcile')).toMatchObject({ form: { formInstanceId: 'a1b2c3d4e5f6' } });
    expect(inputCount(extension.fake)).toBe(inputsBefore);
  });
});

// #257, ADR-0020: a reconnect restores the channel, not the page. Each case breaks one run at one point and asserts
// what the app received and what happened to the page.
describe('an interrupted 去报销 resumes inside the window, or stops without touching the page', () => {
  // Between the break and the app's verdict the page is only read: the re-observation, and focus emulation on a
  // re-attached tab. Nothing clicks, types, or opens a child session.
  const onlyReadsBetween = (fake: { commands: Array<{ method: string }> }, from: number, to: number) =>
    fake.commands.slice(from, to).every((c) => c.method === 'Runtime.evaluate' || c.method === 'Emulation.setFocusEmulationEnabled');

  it('on a detach, says erp.detached first, re-attaches the same tab, re-observes, resumes, and replays nothing', async () => {
    const baseline = await extensionOver();
    const expected = await baseline.fill();
    let brokeAt = -1;
    const extension = await extensionOver({
      app: {
        after: (event) => {
          if (!isStep('catalog', 'running')(event)) return;
          brokeAt = extension.fake.commands.length;
          extension.chrome.detach('canceled_by_user');
        },
      },
    });

    const result = await extension.fill();

    expect(extension.interruptions).toEqual([{ jobId: 'job-1', kind: 'debugger_detached', reason: 'canceled_by_user' }]);
    // Rule 4: the detach is told before any further event, then the resume, then the job carries on.
    const said = extension.app.said();
    const at = said.indexOf(EXECUTOR_METHODS.detached);
    expect(said.slice(at - 1, at + 3)).toEqual(['step', EXECUTOR_METHODS.detached, EXECUTOR_METHODS.resume, 'step']);
    // Rule 2: nothing was sent while interrupted (the app never had to refuse), and the page was only read.
    expect(extension.app.refused).toEqual([]);
    const [resume] = extension.app.resumes;
    expect(onlyReadsBetween(extension.fake, brokeAt, resume!.commandsAt)).toBe(true);
    expect(resume!.last).toMatchObject({ erpAccount: { account: 'luo.liu', tenant: 'tenant-a' }, form: null, assistant: 'closed' });
    expect(resume!.now).toEqual(resume!.last);
    // Rule 1: the same log an unbroken run writes, every event sent once.
    expect(journal(extension.events)).toEqual(journal(baseline.events));
    expect(extension.app.wire.filter((entry) => entry.method === EXECUTOR_METHODS.event)).toHaveLength(extension.events.length);
    expect(result).toMatchObject({ status: expected.status, code: expected.code });
    // The same tab, attached again; no other tab opened.
    const tab = extension.chrome.jobTab()!.id;
    expect(extension.chrome.attached).toEqual([{ tabId: tab }, { tabId: tab }]);
    expect(extension.chrome.tabCount()).toBe(1);
  });

  it('on a closed channel, sends no erp.detached and counts an attempt on record as acknowledged', async () => {
    let brokeAt = -1;
    const extension = await extensionOver({
      app: {
        after: (event) => {
          if (event.type !== 'attempt_started') return;
          brokeAt = extension.fake.commands.length;
          return 'drop';
        },
      },
    });

    const result = await extension.fill();

    expect(extension.interruptions).toEqual([{ jobId: 'job-1', kind: 'channel_closed', reason: '和应用的连接断开了。' }]);
    expect(extension.app.said()).not.toContain(EXECUTOR_METHODS.detached);
    expect(extension.app.refused).toEqual([]);
    const [resume] = extension.app.resumes;
    expect(onlyReadsBetween(extension.fake, brokeAt, resume!.commandsAt)).toBe(true);
    expect(resume!.last).toMatchObject({ form: { targetId: 'tab-1', formMode: 'new', billNo: null }, assistant: 'open' });
    // Rule 1: the attempt went out once; its lost answer was the record's, and the import ran after it.
    expect(extension.app.said().filter((type) => type === 'attempt_started')).toHaveLength(1);
    expect(extension.fake.mutations.map((m) => m.kind)).toEqual(['import']);
    expect(result).toMatchObject({ status: 'unknown', code: 'receipt_readback' });
  });

  it('sends the event the break cut off before it reached the record, once', async () => {
    let dropped = false;
    const extension = await extensionOver({
      app: {
        before: (event) => {
          if (event.type !== 'attempt_started' || dropped) return;
          dropped = true;
          return 'drop';
        },
      },
    });

    const result = await extension.fill();

    // Twice on the wire, once on record: the first never arrived, so the second is its first time.
    expect(extension.app.said().filter((type) => type === 'attempt_started')).toHaveLength(2);
    expect(extension.events.filter((e) => e.type === 'attempt_started')).toHaveLength(1);
    expect(extension.fake.mutations.map((m) => m.kind)).toEqual(['import']);
    expect(result).toMatchObject({ status: 'unknown', code: 'receipt_readback' });
  });

  it.each([
    ['a refused resume', { ok: false, reasons: ['打开的报销单和中断前不是同一张'] } as ResumeVerdict],
    ['an unknown job', failure(JOB_REFUSALS.unknownJob, '这次任务不在这个浏览器扩展里运行。')],
  ])('stops on %s without touching the page again', async (_case, verdict) => {
    const extension = await extensionOver({ app: { after: (event) => (event.type === 'attempt_started' ? 'drop' : undefined), verdict } });

    await expect(extension.fill()).rejects.toThrow();

    // Rule 3: not one command after the verdict, and nothing sent after the resume.
    const [resume] = extension.app.resumes;
    expect(extension.fake.commands).toHaveLength(resume!.commandsAt);
    expect(extension.app.said().at(-1)).toBe(EXECUTOR_METHODS.resume);
    expect(extension.fake.mutations).toEqual([]);
  });

  it('ends the job when a read-back on record lost its verdict, and does not act on it', async () => {
    const extension = await extensionOver({ app: { after: (event) => (event.type === 'readback' ? 'drop' : undefined) } });

    const result = await extension.fill();

    // Rules 1 and 5: the read-back is not sent again; the job ends on an `aborted` result, the next event on record.
    expect(result).toMatchObject({ type: 'result', status: 'aborted', code: 'readback_verdict_lost' });
    expect(journal(extension.events).slice(-2)).toEqual(['readback', 'result']);
    expect(extension.app.said().filter((type) => type === 'readback')).toHaveLength(1);
    expect(extension.fake.commands).toHaveLength(extension.app.resumes[0]!.commandsAt);
  });

  it('does not resume when the job tab is gone, and opens no other', async () => {
    const extension = await extensionOver({ app: { after: (event) => (isStep('catalog', 'running')(event) ? void extension.chrome.closeJobTab() : undefined) } });

    await expect(extension.fill()).rejects.toThrow();

    expect(extension.app.said()).toContain(EXECUTOR_METHODS.detached);
    expect(extension.app.said()).not.toContain(EXECUTOR_METHODS.resume);
    expect(journal(extension.events).at(-1)).toBe('catalog running');
    expect(extension.chrome.tabCount()).toBe(0);
    expect(extension.chrome.attached).toHaveLength(1);
  });

  it('ends the job with an aborted result when the detach cut off a command under way', async () => {
    let armed = false;
    const extension = await extensionOver({
      app: {
        after: (event) => {
          if (event.type === 'attempt_started') armed = true;
        },
      },
      // The employee cancels the debugger banner while the import click is on its way.
      debugger: (api) => ({
        ...api,
        async sendCommand(target, method, params) {
          if (!armed || method !== 'Input.dispatchMouseEvent') return api.sendCommand(target, method, params);
          armed = false;
          extension.chrome.detach('canceled_by_user');
          throw new Error('Detached while handling command.');
        },
      }),
    });

    const result = await extension.fill();

    // Rule 5: resumed on the same page, and still the extension does not carry on or pick a disposition: `aborted`,
    // which the server makes 对账 because an attempt is on record.
    expect(extension.app.resumes[0]!.now).toEqual(extension.app.resumes[0]!.last);
    expect(result).toMatchObject({ type: 'result', status: 'aborted', code: 'debugger_detached_mid_command' });
    expect(extension.app.said().slice(-4)).toEqual(['attempt_started', EXECUTOR_METHODS.detached, EXECUTOR_METHODS.resume, 'result']);
    expect(extension.events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(extension.fake.mutations).toEqual([]);
  });

  // Real Chrome's order (measured in extension/e2e/regression.spec.ts): the cut-off command fails first, and
  // `onDetach` comes later. The failure alone must already be the detach, or the executor ends the job on Chrome's
  // English error instead.
  it.each([
    ["in Chrome's detach words", {}],
    ['in other words, with the detach reported after it', { error: 'Internal error' }],
  ])('treats a command Chrome fails %s as the same detach, and ends the job the designed way', async (_case, cut) => {
    let armed = false;
    const extension = await extensionOver({
      app: {
        after: (event) => {
          if (event.type === 'attempt_started') armed = true;
        },
      },
    });
    extension.chrome.detachDuring('Input.dispatchMouseEvent', { ...cut, when: () => armed });

    const result = await extension.fill();

    expect(extension.interruptions.map((interruption) => interruption.kind)).toEqual(['debugger_detached']);
    expect(result).toMatchObject({ type: 'result', status: 'aborted', ...DETACHED_MID_COMMAND });
    expect(extension.app.said().slice(-4)).toEqual(['attempt_started', EXECUTOR_METHODS.detached, EXECUTOR_METHODS.resume, 'result']);
    expect(extension.events.filter((e) => e.type === 'result')).toEqual([result]);
    // Nothing in Chrome's words reached the app, and so nothing reaches the employee.
    expect(JSON.stringify(extension.events)).not.toMatch(/Detached|Internal error/);
    expect(extension.fake.mutations).toEqual([]);
    // Re-attached to the same tab once, and the late `onDetach` of the old attachment did not interrupt the new one.
    const tab = extension.chrome.jobTab()!.id;
    expect(extension.chrome.attached).toEqual([{ tabId: tab }, { tabId: tab }]);
  });
});
