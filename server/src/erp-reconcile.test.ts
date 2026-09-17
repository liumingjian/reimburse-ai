import { HUMAN_REVIEW_NOTICE, TaskListSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { dataDirBlobs } from './erp/cdp-executor';
import { runFillJob } from './erp/executor/job';
import { runReconcileJob } from './erp/executor/reconcile-job';
import { createFakeErp, type FakeErp, type FakeErpOptions } from './erp/executor/testing/fake-erp';
import type { FillExecutor } from './erp/fill-jobs';
import type { ExecutorChannel, ExecutorEvent, Mutation } from './erp/protocol';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { COMPATIBILITY, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './erp/testing/scenario';
import { noFormOpen, savedDraft, scripted, TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import { api, sample } from './test/api';
import { createTestServer, tempDataDir, testClient, type TestClient, type TestServer } from './test/harness';
import { join } from 'node:path';

// Slice 13 (#192): any loss after `attempt_started` lands in reconcile, never in a replay. Faults are injected into
// the real executor on the fake ERP at each mutation point (import, fill, save): the attempt is durable, then the job
// dies. The read-only reconcile job then reads the same fake ERP and the server places it in one 对账中断点.

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);
const RECEIPT_NUMBER = 'SPD202609150001';

// Where the fill job dies: right after the attempt of that mutation is durable (before ERP changes), or after the
// save went through, while its strict read-back runs.
type Fault = Mutation | 'after_save';

let server: TestServer;
let alice: TestClient;
let fakeOptions: FakeErpOptions;
let fake: FakeErp | null = null;
let fault: Fault | null = null;
let fillRuns = 0;

// The channel as the executor sees it, with the crash injected after the server has persisted the event.
function faulty(channel: ExecutorChannel): ExecutorChannel {
  const emit = async (event: ExecutorEvent) => {
    const reply = await (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);
    if (event.type === 'attempt_started' && event.action === fault) throw new Error(`injected fault at ${event.action}`);
    if (event.type === 'readback' && event.stage === 'after_save' && fault === 'after_save') throw new Error('injected fault after save');
    return reply;
  };
  return { emit: emit as ExecutorChannel['emit'] };
}

const fillExecutor: FillExecutor = async (plan, channel) => {
  fillRuns += 1;
  fake = await createFakeErp(fakeOptions);
  return runFillJob(plan, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel: faulty(channel), pace: FAST_PACE, probeWaitMs: 0 });
};
// The reconcile job reads whatever the fill left on the same fake ERP.
const reconcileExecutor: ReconcileExecutor = async (plan, channel) => runReconcileJob(plan, { browser: fake!.browser, channel, pace: FAST_PACE, probeWaitMs: 0 });

beforeEach(async () => {
  fake = null;
  fault = null;
  fillRuns = 0;
  server = await createTestServer({ projectCatalog: CATALOG, erpExecutor: fillExecutor, reconcileExecutor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

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

// Waits until neither the fill job nor a reconcile job runs.
async function settled(taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running' && snapshot.step.kind !== 'none') return snapshot;
    if (snapshot.stage !== 'erp' && snapshot.stage !== 'reconcile') return snapshot;
    if (Date.now() > deadline) throw new Error(`ERP job still running: ${JSON.stringify(snapshot.reconcile)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function crashAt(point: Fault): Promise<TaskSnapshot> {
  fault = point;
  const ready = await confirmed();
  await client.accepted(await client.act(ready, 'start-erp-write'));
  return settled(ready.task.taskId);
}

async function reconcile(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
  await client.accepted(await client.act(snapshot, 'reconcile'));
  return settled(snapshot.task.taskId);
}

const taskList = async () => TaskListSchema.parse(await (await alice.request('/api/tasks')).json());

describe('fault injection at each ERP mutation point', () => {
  it.each([
    // The fake ERP's blank form keeps one empty detail row, which reads as unreadable: 未知 (unverified on a real ERP).
    ['import', '未知', ['wait', 'hand_off']],
    ['fill', '未保存·已导入未写明细', ['hand_off']],
    ['save', '未保存·就绪待保存', ['wait', 'hand_off']],
  ] as const)('a fault at %s stops in reconcile, and the reconcile job lands in %s', async (point, bucket, allowed) => {
    const stopped = await crashAt(point);
    // Write result unknown: reconcile before any read, offering only 开始对账 and 转人工.
    expect(stopped).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', bucket: null, allowedActions: ['wait', 'hand_off'] } });
    expect(stopped.erp.abortReason).toContain(`injected fault at ${point}`);
    expect(server.erpLease.holder()).toBeNull();
    const mutationsBefore = fake!.mutations.length;

    const judged = await reconcile(stopped);
    expect(judged).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, reconcile: { bucket, allowedActions: allowed } });
    expect(judged.reconcile.reasons.length).toBeGreaterThan(0);
    // Read-only: nothing changed in ERP, the fill job never ran again, the lease is free again.
    expect(fake!.mutations.length).toBe(mutationsBefore);
    expect(fillRuns).toBe(1);
    expect(server.erpLease.holder()).toBeNull();
  });

  it('已导入未写明细 always goes to 转人工: reconcile is refused, hand-off is terminal', async () => {
    const judged = await reconcile(await crashAt('fill'));
    expect(judged.reconcile).toMatchObject({ bucket: '未保存·已导入未写明细', action: '转人工', actionCode: 'hand_off', allowedActions: ['hand_off'], humanReview: true });
    const refused = await client.act(judged, 'reconcile');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('action_not_allowed');

    const handedOff = await client.accepted(await client.act(judged, 'hand-off'));
    expect(handedOff).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off', bucket: '未保存·已导入未写明细', allowedActions: [], humanReview: true, banner: HUMAN_REVIEW_NOTICE } });
    expect((await taskList()).tasks[0]).toMatchObject({ stage: 'reconcile', erpOutcome: 'handed_off', abandonable: false });
    const again = await client.act(handedOff, 'hand-off');
    expect(again.status).toBe(400);
    // 去打印 never needs ERP (stories 57 and 63): 转人工 hands the ERP draft to a person, and that person still
    // wants the paper bundle, so print stays open on a handed-off task.
    expect((await alice.post(`/api/tasks/${handedOff.task.taskId}/actions/generate-print-sheet`, {})).status).toBe(200);
    expect((await client.current(handedOff.task.taskId)).printSheet.status).toBe('generated');
    // Handed off is terminal: the account may start its next task; the handed-off task still holds its invoices.
    expect((await alice.post('/api/tasks', { homeCity: '杭州' })).status).toBe(200);
  }, 120_000);

  it('a save that went through before the fault reconciles to 已保存 and, matching the approved preview line by line, is done', async () => {
    const stopped = await crashAt('after_save');
    expect(stopped.stage).toBe('reconcile');
    const judged = await reconcile(stopped);
    expect(judged).toMatchObject({ stage: 'done', erp: { status: 'done' }, readback: { status: 'matched' } });
    expect(judged.erp.draftNo).toEqual(expect.any(String));
  });

  it('a form under another instance UUID than the attempt\'s is never judged: 未知', async () => {
    const stopped = await crashAt('save');
    fake!.replaceFormInstance();
    const judged = await reconcile(stopped);
    expect(judged.reconcile).toMatchObject({ bucket: '未知', allowedActions: ['wait', 'hand_off'] });
    expect(judged.reconcile.reasons.join('')).toContain('表单实例');
  });

  it('hands off before any reconcile, straight from the abort', async () => {
    const stopped = await crashAt('import');
    const handedOff = await client.accepted(await client.act(stopped, 'hand-off'));
    expect(handedOff).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off', humanReview: true } });
    const voided = await alice.post(`/api/tasks/${stopped.task.taskId}/abandon`, {});
    expect(voided.status).toBe(400);
  });

  it('holds the ERP lease while reconcile reads: 409 erp_in_use for another task, the lease is freed on the result', async () => {
    const stopped = await crashAt('save');
    server.erpLease.acquire({ accountId: 'someone', taskId: 'another-task', jobId: 'another-job' });
    const blocked = await client.act(stopped, 'reconcile');
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('erp_in_use');
    server.erpLease.release('another-job');
    await reconcile(stopped);
    expect(server.erpLease.holder()).toBeNull();
  });
});

describe('crash recovery', () => {
  it('a restart mid-job comes back in reconcile, and no mutation is replayed', async () => {
    const dir = tempDataDir();
    const database = join(dir, 'baox.sqlite');
    // The first process: the fill job persists its import attempt, then the process dies before any result.
    let hang!: (error: Error) => void;
    const dead = new Promise<never>((_resolve, reject) => { hang = reject; });
    const dying: FillExecutor = async (plan, channel) => {
      await channel.emit({
        type: 'attempt_started', attemptId: `${plan.jobId}.import`, action: 'import',
        preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 1 },
        expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT,
      });
      return dead;
    };
    const first = await createTestServer({ projectCatalog: CATALOG, erpExecutor: dying, database, dataDir: dir });
    const owner = await first.signIn('alice');
    expect((await owner.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
    const firstClient = api(() => owner);
    const { task } = await firstClient.createTask('杭州');
    const uploaded = await firstClient.upload(task.taskId, [sample('m01'), sample('m02')]);
    await firstClient.accepted(await firstClient.act(uploaded, 'start-inventory'));
    const done = await firstClient.withoutStayGaps(await firstClient.settled(task.taskId));
    const review = await firstClient.accepted(await firstClient.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
    const ready = await firstClient.accepted(await firstClient.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    await firstClient.accepted(await firstClient.act(ready, 'start-erp-write'));
    await expect.poll(async () => (await first.db.selectFrom('erp_attempt').select('attempt_id').execute()).length).toBe(1);
    const running = await firstClient.current(task.taskId);
    expect(running).toMatchObject({ stage: 'erp', erp: { status: 'running' } });

    // The second process on the same data: the job gets its result before any request is served.
    const neverRun = scripted(savedDraft());
    const second = await createTestServer({ projectCatalog: CATALOG, erpExecutor: neverRun, reconcileExecutor: noFormOpen, database, dataDir: dir });
    const again = api(() => testClient(second.app, owner.account, owner.cookie));
    const back = await again.current(task.taskId);
    expect(back).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', allowedActions: ['wait', 'hand_off'] } });
    expect(back.erp.abortReason).toContain('不会重放');
    await refusedWith(await again.act(back, 'start-erp-write'), 400, 'erp_started');
    await refusedWith(await testClient(second.app, owner.account, owner.cookie).post(`/api/tasks/${task.taskId}/abandon`, {}), 400, 'erp_started');

    // Reconcile only reads; the fill job is never run again and no attempt is added.
    await again.accepted(await again.act(back, 'reconcile'));
    await expect.poll(async () => (await again.current(task.taskId)).reconcile.bucket).toBe('未知');
    const handedOff = await again.accepted(await again.act(await again.current(task.taskId), 'hand-off'));
    expect(handedOff).toMatchObject({ stage: 'reconcile', reconcile: { status: 'handed_off' } });
    expect(neverRun.runs()).toEqual([]);
    expect(await second.db.selectFrom('erp_attempt').select('attempt_id').execute()).toHaveLength(1);

    await second.close();
    hang(new Error('process died'));
    await first.close().catch(() => undefined);
  });
});

async function refusedWith(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}
