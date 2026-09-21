// Seam 1 of spec #246: the extension's `chrome.debugger` adapter implements the executor's `CdpSession`, so the stateful
// fake ERP drives it with no new page tests. Here the real executor runs through the runner, the job-tab `BrowserPort`
// and the adapter, with `chrome.*` faked over the fake ERP, speaking #254's wire protocol. What is asserted is what the
// employee and the server can observe: which tabs were touched, which protocol events went out, what changed in ERP.
// (The full run to hand-over, through the same adapter, is `server/src/erp/parity.test.ts` against the kernel golden.)
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ExecutorEvent, type FillPlan, type ReconcilePlan } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErpOptions, type FakeInvoice } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS, type FillRequest } from '@baox/erp-executor/wire';
import { createErpRunner, type Interruption } from './erp-runner';
import { dedicatedErpTab, type ErpTab } from './erp-tab';
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

/**
 * The extension's runner over a fake ERP, with the server stubbed as the channel would answer: every attempt is
 * acknowledged and read-backs are refused, so a fill ends right after its import — past the login probe, the
 * 报销信息核对, the navigation and the piaozone child session, which is all the transport there is.
 */
async function extensionOver(erp: Partial<FakeErpOptions> = {}, chromeOptions: FakeChromeOptions = {}) {
  const fake = await createFakeErp({ origin: ERP_ORIGIN, invoices: [INVOICE], projects: PROJECTS, expenseItems: EXPENSE_ITEMS, ...erp });
  const chrome = fakeChrome(fake.session, chromeOptions);
  const events: ExecutorEvent[] = [];
  const requests: Array<{ method: string; jobId: unknown }> = [];
  const interruptions: Array<{ jobId: string } & Interruption> = [];
  const ports: ErpTab[] = [];
  const run = createErpRunner({
    browser: (erpOrigin, choice) => {
      const port = dedicatedErpTab({ erpOrigin, choice, tabs: chrome.tabs, windows: chrome.windows, debugger: chrome.debugger, pollMs: 1 });
      ports.push(port);
      return port;
    },
    request: async (method, payload) => {
      const { jobId, event } = payload as { jobId: string; event: ExecutorEvent };
      requests.push({ method, jobId });
      events.push(event);
      if (event.type === 'attempt_started') return { persisted: true };
      if (event.type === 'readback') return { ok: false, reasons: ['测试里的服务器不判定回读'] };
      return null;
    },
    blobs: { read: async () => INVOICE.bytes },
    pace: FAST_PACE,
    onInterrupted: (jobId, interruption) => interruptions.push({ jobId, ...interruption }),
  });
  return {
    fake, chrome, events, requests, interruptions, ports,
    fill: (trigger: FillRequest['trigger'] = 'start') => run(EXECUTOR_METHODS.fill, { plan, trigger }),
    reconcile: () => run(EXECUTOR_METHODS.reconcile, { plan: reconcilePlan }),
  };
}

const stepsDone = (events: ExecutorEvent[]) => events.flatMap((e) => (e.type === 'step' && e.status === 'done' ? [e.step] : []));
const inputCount = (fake: { commands: Array<{ method: string }> }) => fake.commands.filter((c) => c.method.startsWith('Input.')).length;

describe('a 去报销 run by the extension over chrome.debugger', () => {
  it('opens its own ERP tab, attaches to that tab only, and brings it to the front', async () => {
    const extension = await extensionOver({}, { employeeTabs: [ENTRY, 'https://example.com/'] });
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
    expect(new Set(extension.requests.map((r) => `${r.method} ${r.jobId}`))).toEqual(new Set([`${EXECUTOR_METHODS.event} job-1`]));
  });

  it('waits for the employee to log in, then continues in the same tab', async () => {
    const extension = await extensionOver({ loggedIn: false });

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
    const extension = await extensionOver({ projects: [{ code: '39163', name: '别的项目' }] });
    await extension.fill();
    const first = extension.chrome.jobTab()!.id;
    await extension.fill('start');

    expect(extension.chrome.jobTab()!.id).not.toBe(first);
  });

  it('stops on a master-data mismatch before anything is written', async () => {
    const extension = await extensionOver({ projects: [{ code: '39163', name: '别的项目' }] });
    const result = await extension.fill();

    expect(result.status).toBe('catalog_mismatch');
    expect(extension.events.find((e) => e.type === 'catalog_mismatch')).toMatchObject({ problems: [{ kind: 'project', code: '39163', verdict: 'name_mismatch' }] });
    expect(extension.fake.mutations).toEqual([]);
    expect(inputCount(extension.fake)).toBe(0);
  });

  it('carries on when the tab refuses focus emulation, and keeps the refusal', async () => {
    const extension = await extensionOver({}, { refuse: { 'Emulation.setFocusEmulationEnabled': "'Emulation.setFocusEmulationEnabled' wasn't found" } });
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

  it('reports a debugger detach through the same path as a lost channel, and fails the next command', async () => {
    const extension = await extensionOver();
    await extension.fill();
    // The job's tab, attached again and then cut off by the employee cancelling Chrome's debugger banner.
    const port = extension.ports[0]!;
    const [page] = await port.listPages();
    const { session } = await port.attach(page!);

    extension.chrome.detach('canceled_by_user');

    expect(extension.interruptions).toEqual([{ jobId: 'job-1', kind: 'debugger_detached', reason: 'canceled_by_user' }]);
    await expect(session.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow(/canceled_by_user/);
  });

  it('reports a channel lost under an event through the same path', async () => {
    const fake = await createFakeErp({ origin: ERP_ORIGIN, invoices: [INVOICE], projects: PROJECTS, expenseItems: EXPENSE_ITEMS });
    const chrome = fakeChrome(fake.session);
    const interruptions: Interruption[] = [];
    const lost = Object.assign(new Error('和应用的连接断开了。'), { code: 'channel_closed' });
    const run = createErpRunner({
      browser: (erpOrigin, choice) => dedicatedErpTab({ erpOrigin, choice, tabs: chrome.tabs, windows: chrome.windows, debugger: chrome.debugger, pollMs: 1 }),
      request: () => Promise.reject(lost),
      onInterrupted: (_jobId, interruption) => interruptions.push(interruption),
    });

    await expect(run(EXECUTOR_METHODS.fill, { plan, trigger: 'start' })).rejects.toBe(lost);
    expect(interruptions[0]).toEqual({ kind: 'channel_closed', reason: '和应用的连接断开了。' });
    expect(fake.mutations).toEqual([]);
  });
});
