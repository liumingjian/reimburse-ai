import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, type TaskSnapshot } from '@baox/contract';
import { runFillJob } from '@baox/erp-executor/job';
import type { ExecutorChannel, ExecutorEvent, FillPlan, ResultEvent } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErp, type FakeErpOptions } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { dataDirBlobs } from './erp/cdp-executor';
import { catalogMismatch, loginWall, noFormOpen, TEST_ERP_ACCOUNT, uncertainSave } from './erp/testing/fake-executor';
import { fakeExtension, type FakeExtension, type FillRunner, type ReconcileRunner } from './erp/testing/fake-extension';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './erp/testing/scenario';
import { api, sample } from './test/api';
import { BACKSTOP_MS } from './test/deadlines';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

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

beforeEach(async () => {
  fake = null;
  server = await createTestServer({ projectCatalog: CATALOG, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
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

// The in-process executor on the fake ERP, run inside the extension. The invoice bytes come from the data directory
// here; the real extension fetches them over HTTP (#256).
const realExecutor: FillRunner = async (plan, channel) => {
  fake = await createFakeErp(fakeOptions);
  return runFillJob(plan, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel, pace: FAST_PACE, probeWaitMs: 0 });
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

const journal = async (taskId: string) =>
  (await server.db.selectFrom('erp_job_event').select(['type', 'payload']).where('task_id', '=', taskId).orderBy('created_at').orderBy('seq').execute()).map((row) => JSON.parse(row.payload) as ExecutorEvent);
const resultsOf = async (taskId: string) => (await journal(taskId)).filter((event): event is ResultEvent => event.type === 'result');
const attemptsOf = async (taskId: string) => server.db.selectFrom('erp_attempt').select('action').where('task_id', '=', taskId).execute();

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
    const extension = await connected(await pair(alice), { fill: (plan, channel, trigger) => realExecutor(plan, watched(channel), trigger) });
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

  it('ends a job whose channel went before any attempt as aborted, with the channel loss as its code', async () => {
    const token = await pair(alice);
    const extension: FakeExtension = await connected(token, {
      fill: async (_plan, channel) => {
        await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
        extension.disconnect();
        await channel.emit({ type: 'step', step: 'chromium', status: 'done' });
        throw new Error('unreachable: the channel is gone');
      },
    });
    const ready = await confirmed();

    await start(ready);

    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_connection_lost' }]);
    expect(await attemptsOf(ready.task.taskId)).toEqual([]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('goes to 对账 when the channel drops while an attempt is being recorded, and never mutates or replays', async () => {
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

    const stopped = await start(ready);

    expect(mutated).toBe(false);
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await attemptsOf(ready.task.taskId)).toEqual([{ action: 'import' }]);
    // The result follows the attempt on record, and the server's guard made it 写入结果未知.
    const log = await journal(ready.task.taskId);
    expect(log.map((event) => event.type).slice(-2)).toEqual(['attempt_started', 'result']);
    expect(await resultsOf(ready.task.taskId)).toMatchObject([{ status: 'unknown', code: 'extension_connection_lost' }]);

    // The extension comes back: nothing is re-sent to it.
    const back = await connected(token, { fill: realExecutor });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back.asked()).toEqual([]);
    expect(extension.asked()).toHaveLength(1);
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
