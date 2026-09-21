import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, type TaskSnapshot } from '@baox/contract';
import { stageInPage } from '@baox/erp-executor/invoice-files';
import { runFillJob } from '@baox/erp-executor/job';
import type { ExecutorChannel, ExecutorEvent, FillPlan, ResultEvent } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErp, type FakeErpOptions } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS, RECONNECT_WINDOW_MS, type PageObservation } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { serverBlobs } from '@baox/extension/blobs';
import { catalogMismatch, loginWall, noFormOpen, TEST_ERP_ACCOUNT, uncertainSave } from './erp/testing/fake-executor';
import { fakeExtension, type FakeExtension, type FillRunner, type ReconcileRunner } from './erp/testing/fake-extension';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './erp/testing/scenario';
import { api, sample } from './test/api';
import { BACKSTOP_MS } from './test/deadlines';
import { createTestServer, type TestClient, type TestServer } from './test/harness';
import { manualTimers } from './test/timers';

// #254: the server drives an executor in the 应用账号's paired 浏览器扩展 over its channel (spec #246 seam 2). No
// executor is passed to the app, so every job goes to the extension, as in production; a fake extension client runs the
// executor on its side of the wire. The judgement, the attempt discipline and the lease stay the server's.

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);
const RECEIPT_NUMBER = 'SPD202609150001';
const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';

let server: TestServer;
let alice: TestClient;
let fakeOptions: FakeErpOptions;
let fake: FakeErp | null = null;
let timers: ReturnType<typeof manualTimers>;


beforeEach(async () => {
  fake = null;
  timers = manualTimers();
  server = await createTestServer({ projectCatalog: CATALOG, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, schedule: timers.schedule });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307', name: '华东客户交付' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

async function pair(owner: TestClient): Promise<string> {
  const issued = ExtensionPairingSchema.parse(await (await owner.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: issued.code, browser: 'Chrome 142 Windows', version: EXTENSION_VERSION }),
  });
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

async function connected(token: string, runners: { fill?: FillRunner; reconcile?: ReconcileRunner }): Promise<FakeExtension> {
  const extension = fakeExtension(server.app.extensionChannel, token, runners);
  await extension.connect();
  return extension;
}

// The executor on the fake ERP, run inside the extension as the extension runs it: the invoices fetched from the app's
// blob route with the extension's token, and put into the assistant as bytes built in the page (#256).
const realExecutor = (token: string): FillRunner => async (plan, channel) => {
  fake = await createFakeErp(fakeOptions);
  const blobs = serverBlobs({ origin: 'http://localhost', token: async () => token, fetch: async (url, init) => server.app.request(url, init) });
  return runFillJob(plan, { browser: fake.browser, blobs, staging: stageInPage, channel, pace: FAST_PACE, probeWaitMs: 0 });
};

// Hotel e-invoice + folio on P-2307, confirmed; the fake ERP knows the invoice by its bytes and face amounts.
async function confirmed(): Promise<TaskSnapshot> {
  const invoice = sample('m01');
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [invoice, sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  const ready = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
  const [line] = ready.lines;
  if (!line) throw new Error('expected one line');
  const face = Object.fromEntries(ready.materials.find((m) => m.materialId === line.voucherMaterialId)!.fields.map((field) => [field.key, field.value]));
  fakeOptions = fakeErpOptions({
    invoices: [{ bytes: new Uint8Array(invoice.bytes), invoiceNumber: face['invoiceNumber']!, receiptNumber: RECEIPT_NUMBER, seller: face['sellerName'] ?? '全季酒店', issueDate: face['issueDate'] ?? line.date, net: line.netAmount, tax: line.taxAmount, gross: line.grossAmount, category: '全电普通发票' }],
    projects: [{ code: 'P-2307', name: '华东客户交付' }],
    expenseItems: [{ code: 'FY010001', name: '住宿' }],
    assumeReceiptLink: true,
  });
  return ready;
}

// Waits until no ERP job of the task runs.
async function settled(taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + BACKSTOP_MS;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running' && snapshot.step.kind !== 'none') return snapshot;
    if (snapshot.stage !== 'erp' && snapshot.stage !== 'reconcile') return snapshot;
    if (Date.now() > deadline) throw new Error('ERP job still running');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
  await client.accepted(await client.act(snapshot, 'start-erp-write'));
  return settled(snapshot.task.taskId);
}

// Waits until the running job is interrupted: its reconnection window is open.
async function interrupted(): Promise<void> {
  const deadline = Date.now() + BACKSTOP_MS;
  while (timers.pending(RECONNECT_WINDOW_MS) === 0) {
    if (Date.now() > deadline) throw new Error('no job was interrupted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const windowCloses = () => timers.elapse(RECONNECT_WINDOW_MS);

const journal = async (taskId: string) =>
  (await server.db.selectFrom('erp_job_event').select(['type', 'payload']).where('task_id', '=', taskId).orderBy('created_at').orderBy('seq').execute()).map((row) => JSON.parse(row.payload) as ExecutorEvent);
const resultsOf = async (taskId: string) => (await journal(taskId)).filter((event): event is ResultEvent => event.type === 'result');
const attemptsOf = async (taskId: string) => server.db.selectFrom('erp_attempt').select('action').where('task_id', '=', taskId).execute();

// The page the jobs below were on when they were interrupted, as the extension re-observes it: the form and identity
// `attemptStarted` records, the 发票助手 open.
const PAGE: PageObservation = { erpAccount: TEST_ERP_ACCOUNT, form: { targetId: 'erp-page-1', formInstanceId: 'form-1', formMode: 'new', billNo: null }, assistant: 'open' };

const attemptStarted = (plan: FillPlan): Extract<ExecutorEvent, { type: 'attempt_started' }> => ({
  type: 'attempt_started', attemptId: `${plan.jobId}.import`, action: 'import',
  preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 1 },
  expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT,
});

describe('去报销 in the paired 浏览器扩展', () => {
  it('hands the plan down, takes every event back in order, and hands the filled form over', async () => {
    // At each ack, what the extension can observe: is the attempt already durable, and has ERP been touched yet?
    const acks: Array<{ action: string; durable: boolean; mutationsBefore: string[] }> = [];
    const watched = (channel: ExecutorChannel): ExecutorChannel => ({
      emit: (async (event: ExecutorEvent) => {
        const reply = await (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);
        if (event.type === 'attempt_started') {
          const row = await server.db.selectFrom('erp_attempt').select('attempt_id').where('attempt_id', '=', event.attemptId).executeTakeFirst();
          acks.push({ action: event.action, durable: row !== undefined, mutationsBefore: fake!.mutations.map((mutation) => mutation.kind) });
        }
        return reply;
      }) as ExecutorChannel['emit'],
    });
    const token = await pair(alice);
    const extension = await connected(token, { fill: (plan, channel, trigger) => realExecutor(token)(plan, watched(channel), trigger) });
    const ready = await confirmed();

    const done = await start(ready);

    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', erpAccount: ERP_ACCOUNT }, readback: { status: 'matched' } });
    expect(extension.asked()).toEqual([{ method: EXECUTOR_METHODS.fill, payload: { trigger: 'start', plan: expect.objectContaining({ kind: 'fill', taskId: ready.task.taskId }) } }]);
    // Every event the extension sent is on the job's record, in the order sent; the verdicts it acted on were the server's.
    expect((await journal(ready.task.taskId)).map((event) => event.type)).toEqual(extension.sent().map((event) => event.type));
    expect(new Set(extension.sent().map((event) => event.type))).toEqual(new Set(['step', 'attempt_started', 'readback', 'result']));
    // `attempt_started` was durable before its ack reached the extension, and the ack came before that action's write.
    expect(acks).toEqual([
      { action: 'import', durable: true, mutationsBefore: [] },
      { action: 'fill', durable: true, mutationsBefore: ['import'] },
    ]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it.each([
    ['pauses for the ERP login', loginWall, 'waiting_login', 'waiting_login'],
    ['stops on a 报销信息核对 mismatch', catalogMismatch, 'catalog_mismatch', 'catalog_mismatch'],
  ] as const)('%s with the event the extension sent', async (_name, script, event, status) => {
    const extension = await connected(await pair(alice), { fill: (plan, channel) => script(plan, channel) });
    const ready = await confirmed();

    await start(ready);

    expect(extension.sent().map((sent) => sent.type)).toContain(event);
    expect((await journal(ready.task.taskId)).map((logged) => logged.type)).toEqual(extension.sent().map((sent) => sent.type));
    expect((await resultsOf(ready.task.taskId)).map((result) => result.status)).toEqual([status]);
    expect(await attemptsOf(ready.task.taskId)).toEqual([]);
  });

  it('runs the read-only 对账 in the extension too', async () => {
    const extension = await connected(await pair(alice), { fill: (plan, channel) => uncertainSave(plan, channel), reconcile: noFormOpen });
    const unknown = await start(await confirmed());
    expect(unknown).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });

    await client.accepted(await client.act(unknown, 'reconcile'));
    const judged = await settled(unknown.task.taskId);

    expect(extension.asked().map((asked) => asked.method)).toEqual([EXECUTOR_METHODS.fill, EXECUTOR_METHODS.reconcile]);
    expect(judged).toMatchObject({ stage: 'reconcile', reconcile: { bucket: '未知' } });
  });

  it('stops before anything is written when the owner has no extension connected', async () => {
    const ready = await confirmed();

    const stopped = await start(ready);

    expect(stopped.erp.abortReason).toContain('浏览器扩展');
    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_offline' }]);
    expect(await attemptsOf(ready.task.taskId)).toEqual([]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it("refuses another account's extension speaking for a running job", async () => {
    let release!: () => void;
    let entered!: (jobId: string) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<string>((resolve) => {
      entered = resolve;
    });
    await connected(await pair(alice), {
      fill: async (plan, channel) => {
        entered(plan.jobId);
        await gate;
        return loginWall(plan, channel);
      },
    });
    const bob = await server.signIn('bob');
    const mallory = await connected(await pair(bob), {});
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const jobId = await running;

    const spoken = mallory.request(EXECUTOR_METHODS.event, { jobId, event: { type: 'step', step: 'chromium', status: 'running' } });

    await expect(spoken).rejects.toMatchObject({ code: 'unknown_job' });
    expect(await journal(ready.task.taskId)).toEqual([]);
    release();
    await settled(ready.task.taskId);
  });
});

// #257, ADR-0020: a reconnect restores the channel, not the page. A lost socket or a detached debugger interrupts the
// job; within the window the extension resumes it by `jobId` with what it re-observed, and past it the server decides
// the job's end by whether an attempt is on record.
describe('an interrupted 去报销', () => {
  // A fill that sends one step, then loses its socket; the job it ran in is handed to the test.
  function droppedAfterOneStep(token: string) {
    let started!: (plan: FillPlan) => void;
    const plan = new Promise<FillPlan>((resolve) => {
      started = resolve;
    });
    const extension = fakeExtension(server.app.extensionChannel, token, {
      fill: async (fillPlan, channel) => {
        started(fillPlan);
        await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
        extension.disconnect();
        await channel.emit({ type: 'step', step: 'chromium', status: 'done' });
        throw new Error('unreachable: the channel is gone');
      },
    });
    return { extension, plan };
  }

  it('resumes by jobId inside the window, over the new socket, and carries the job to its end', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const { jobId } = await plan;
    await interrupted();

    const back = await connected(token, {});
    expect(await back.resume(jobId, PAGE, PAGE)).toEqual({ ok: true, recorded: 1 });
    const wire = back.channel(jobId);
    await wire.emit({ type: 'step', step: 'chromium', status: 'done' });
    await wire.emit({ type: 'waiting_login', hint: '请登录报销系统' });
    await wire.emit({ type: 'result', status: 'waiting_login', code: 'erp_login', message: '请登录报销系统', billNo: null, capture: null });
    const paused = await settled(ready.task.taskId);

    expect(paused.erp.status).toBe('waiting_login');
    expect((await journal(ready.task.taskId)).map((event) => event.type)).toEqual(['step', 'step', 'waiting_login', 'result']);
    // The plan went down once, to the first socket; the window closed with the resume.
    expect(back.asked()).toEqual([]);
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('holds the lease through the window, then aborts in place past it and says plainly that nothing was written', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const { jobId } = await plan;
    await interrupted();

    // Mid-window the job still holds its account's lease, so the account's other 去报销 cannot start. That other job
    // is staged on the lease: one account owns one active task (#249).
    const other = { accountId: alice.account.accountId, taskId: 'her-other-task', jobId: 'her-other-job' };
    expect(server.erpLease.holder(alice.account.accountId)).toMatchObject({ jobId });
    expect(server.erpLease.acquire(other)).toBe(false);
    expect((await client.current(ready.task.taskId)).erp.status).toBe('running');

    windowCloses();
    const stopped = await settled(ready.task.taskId);

    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_reconnect_expired' }]);
    expect(await attemptsOf(ready.task.taskId)).toEqual([]);
    expect(stopped.erp.status).toBe('idle');
    expect(stopped.erp.abortReason).toBe('上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：浏览器扩展和报销系统页面之间的连接中断了，两分钟内没有恢复。');
    expect(server.erpLease.acquire(other)).toBe(true);
    server.erpLease.release(other.jobId);
    // Too late to resume: the job reads like no job at all.
    const late = await connected(token, {});
    await expect(late.resume(jobId, PAGE, PAGE)).rejects.toMatchObject({ code: 'unknown_job' });
  });

  it('goes to 对账 past the window when an attempt is on record, and never mutates or replays', async () => {
    const token = await pair(alice);
    let mutated = false;
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        await channel.emit({ type: 'step', step: 'import', status: 'running' });
        const ack = channel.emit(attemptStarted(plan));
        // The socket goes with the attempt in flight: the server may make it durable, but no ack reaches the executor.
        extension.disconnect();
        await ack;
        mutated = true;
        throw new Error('unreachable: an unacknowledged attempt is never followed by a write');
      },
    });
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    await interrupted();

    windowCloses();
    const stopped = await settled(ready.task.taskId);

    expect(mutated).toBe(false);
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await attemptsOf(ready.task.taskId)).toEqual([{ action: 'import' }]);
    // The result follows the attempt on record, and the server's guard made it 写入结果未知.
    expect((await journal(ready.task.taskId)).map((event) => event.type)).toEqual(['step', 'attempt_started', 'result']);
    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'unknown', code: 'extension_reconnect_expired' }]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();

    // The extension comes back: nothing is re-sent to it.
    const back = await connected(token, { fill: realExecutor(token) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back.asked()).toEqual([]);
    expect(extension.asked()).toHaveLength(1);
  });

  it('takes nothing from a resumed extension before its re-observation, and ends the job when the page is not the one it left', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    const { jobId } = await plan;
    await interrupted();
    const back = await connected(token, {});

    // Acting first: refused, and nothing lands on the record.
    await expect(back.channel(jobId).emit({ type: 'step', step: 'navigate', status: 'running' })).rejects.toMatchObject({ code: 'resume_required' });
    expect(await journal(ready.task.taskId)).toHaveLength(1);

    // The 发票助手 was closed during the gap: it is one-shot, so the stream coming back says nothing about the page.
    const verdict = await back.resume(jobId, PAGE, { ...PAGE, assistant: 'closed' });
    const stopped = await settled(ready.task.taskId);

    expect(verdict).toEqual({ ok: false, reasons: ['发票助手的状态和中断前不一样'] });
    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'aborted', code: 'reobservation_mismatch' }]);
    expect(stopped.erp.abortReason).toContain('报销系统没有被改动，可以再去报销');
    await expect(back.channel(jobId).emit({ type: 'step', step: 'navigate', status: 'running' })).rejects.toMatchObject({ code: 'unknown_job' });
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('sends a job whose re-observed form is not the attempted one to 对账', async () => {
    const token = await pair(alice);
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        await channel.emit(attemptStarted(plan));
        extension.disconnect();
        throw new Error('the channel is gone');
      },
    });
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    await interrupted();
    const [attempt] = await server.db.selectFrom('erp_attempt').select('job_id').where('task_id', '=', ready.task.taskId).execute();

    // Consistent before and after, but not the form the attempt was made on.
    const elsewhere: PageObservation = { ...PAGE, form: { ...PAGE.form!, formInstanceId: 'form-2' } };
    const back = await connected(token, {});
    const verdict = await back.resume(attempt!.job_id, elsewhere, elsewhere);
    const stopped = await settled(ready.task.taskId);

    expect(verdict).toEqual({ ok: false, reasons: ['打开的报销单不是这次写入的那一张'] });
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'unknown', code: 'reobservation_mismatch' }]);
  });

  it('replays nothing across a resume: every event is on record once, and the plan is never asked again', async () => {
    const token = await pair(alice);
    let jobPlan!: FillPlan;
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        jobPlan = plan;
        await channel.emit({ type: 'step', step: 'import', status: 'running' });
        const ack = channel.emit(attemptStarted(plan));
        extension.disconnect();
        await ack;
        throw new Error('unreachable: the ack went with the socket');
      },
    });
    const ready = await confirmed();
    await client.accepted(await client.act(ready, 'start-erp-write'));
    await interrupted();

    const back = await connected(token, {});
    const verdict = await back.resume(jobPlan.jobId, PAGE, PAGE);
    // The attempt whose ack was lost is on record, and so counts as acknowledged: the extension does not send it again.
    expect(verdict).toEqual({ ok: true, recorded: 2 });
    const wire = back.channel(jobPlan.jobId);
    // An extension that re-sent it anyway gets no second acknowledgement, so it could never write twice.
    await expect(wire.emit(attemptStarted(jobPlan))).rejects.toBeDefined();
    await wire.emit({ type: 'step', step: 'import', status: 'done' });
    await wire.emit({ type: 'result', status: 'aborted', code: 'test_stop', message: '测试到此为止', billNo: null, capture: null });
    await settled(ready.task.taskId);

    expect((await journal(ready.task.taskId)).map((event) => event.type)).toEqual(['step', 'attempt_started', 'step', 'result']);
    expect(await attemptsOf(ready.task.taskId)).toEqual([{ action: 'import' }]);
    expect(extension.asked().map((asked) => asked.method)).toEqual([EXECUTOR_METHODS.fill]);
    expect(back.asked()).toEqual([]);
  });

  describe('a chrome.debugger detach is the same event as a disconnect', () => {
    it('resumes on the same socket once the page is re-observed', async () => {
      const token = await pair(alice);
      const extension: FakeExtension = await connected(token, {
        fill: async (plan, channel) => {
          await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
          await extension.detached(plan.jobId);
          await expect(channel.emit({ type: 'step', step: 'chromium', status: 'done' })).rejects.toMatchObject({ code: 'resume_required' });
          expect(await extension.resume(plan.jobId, PAGE, PAGE)).toEqual({ ok: true, recorded: 1 });
          return loginWall(plan, channel);
        },
      });
      const ready = await confirmed();

      const paused = await start(ready);

      expect(paused.erp.status).toBe('waiting_login');
      expect((await journal(ready.task.taskId)).map((event) => event.type)).toEqual(['step', ...extension.sent().slice(2).map((event) => event.type)]);
      expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    });

    it('ends past the window exactly as a lost socket does, and ignores the executor’s late answer', async () => {
      const token = await pair(alice);
      const extension: FakeExtension = await connected(token, {
        fill: async (plan, channel) => {
          await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
          await extension.detached(plan.jobId);
          // The executor's own run fails with the page gone; that answer describes nothing the server may act on.
          throw new Error('Debugger is not attached to the tab');
        },
      });
      const ready = await confirmed();
      await client.accepted(await client.act(ready, 'start-erp-write'));
      await interrupted();
      expect(server.erpLease.holder(alice.account.accountId)).not.toBeNull();

      windowCloses();
      const stopped = await settled(ready.task.taskId);

      expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_reconnect_expired' }]);
      expect(stopped.erp.abortReason).toContain('报销系统没有被改动，可以再去报销');
      expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    });
  });
});
