import { type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import type { FillExecutor } from './erp/fill-jobs';
import { TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import { api, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// A 去报销 job's phase is derived from its persisted events: with no `result` event the task reads as `running` for
// ever and every mutation of it answers 409, until the process restarts. Two ways in: the executor returns without
// ever emitting its result, and recording the result throws after the executor emitted it. Either way the job must
// still be closed, following ADR-0014: after a durable attempt the write result is unknown (reconcile, never a
// replay), before any attempt nothing was written and 去报销 may be tried again.

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);

// Set per test, before the task starts its job.
let executor: FillExecutor = async () => {
  throw new Error('no executor for this test');
};

let server: TestServer;
let alice: TestClient;

beforeEach(async () => {
  server = await createTestServer({ projectCatalog: CATALOG, erpExecutor: (plan, channel, options) => executor(plan, channel, options) });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

// Hotel e-invoice + its 全季 folio: one accommodation line, confirmed on P-2307 → actions / choose_action.
async function confirmed(): Promise<TaskSnapshot> {
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  return client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
}

// Waits until the background job stopped running. Without the fallback result this never settles.
async function settledErp(taskId: string, timeoutMs = 10_000): Promise<TaskSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await client.current(taskId);
    if (snapshot.erp.status !== 'running') return snapshot;
    if (Date.now() > deadline) throw new Error('ERP job still running: it never got a result');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function start(snapshot: TaskSnapshot): Promise<TaskSnapshot> {
  await client.accepted(await client.act(snapshot, 'start-erp-write'));
  return settledErp(snapshot.task.taskId);
}

describe('a 去报销 job that ends without sending a result', () => {
  it('ends as aborted when nothing was written, and the task can go again', async () => {
    // The executor returns a result to the job runner but never emits it, so nothing is recorded.
    executor = async () => ({ type: 'result', status: 'aborted', code: 'never_emitted', message: null, billNo: null, capture: null });
    const stopped = await start(await confirmed());

    expect(stopped).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, confirmation: { status: 'confirmed' } });
    expect(stopped.erp.abortReason).toContain('没有给出结果');
    expect(server.erpLease.holder()).toBeNull();
    // Nothing was written, so the task is still fully editable.
    expect((await client.act(stopped, 'set-home-city', { homeCity: '上海' })).status).toBe(200);
  });

  it('ends as 写入结果未知 once an attempt is durable, even when the executor claims it saved', async () => {
    executor = async (plan, channel) => {
      await channel.emit({
        type: 'attempt_started',
        attemptId: `${plan.jobId}.import`,
        action: 'import',
        preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 1 },
        expectedPostconditions: {},
        compatibility: plan.compatibility,
        erpAccount: TEST_ERP_ACCOUNT,
      });
      // Claimed to the job runner but never emitted: an unrecorded claim of success is worth nothing (ADR-0014).
      return { type: 'result', status: 'saved', code: null, message: null, billNo: 'FYBX2026090001', capture: null };
    };
    const stopped = await start(await confirmed());

    expect(stopped).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', allowedActions: ['wait', 'hand_off'] } });
    expect(server.erpLease.holder()).toBeNull();
    // Frozen and not voidable: the invoices stay held until reconcile says otherwise.
    const voided = await alice.post(`/api/tasks/${stopped.task.taskId}/abandon`, {});
    expect(voided.status).toBe(400);
    expect(await voided.json()).toMatchObject({ error: { code: 'erp_started' } });
  });
});
