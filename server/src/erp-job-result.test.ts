import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FillExecutor } from './erp/fill-jobs';
import { TEST_ERP_ACCOUNT } from './erp/testing/fake-executor';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// A 去报销 job's phase is derived from its persisted events: with no `result` event the task reads as `running` for
// ever and every mutation of it answers 409, until the process restarts. Two ways in: the executor returns without
// ever emitting its result, and recording the result throws after the executor emitted it. Either way the job must
// still be closed, following ADR-0014: after a durable attempt the write result is unknown (reconcile, never a
// replay), before any attempt nothing was written and 去报销 may be tried again.

// Set per test, before the task starts its job.
let executor: FillExecutor = async () => {
  throw new Error('no executor for this test');
};

let server: ScenarioServer;
let alice: TestClient;

beforeEach(async () => {
  server = await scenarioServer({ erpExecutor: (plan, channel, options) => executor(plan, channel, options) });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

// Hotel e-invoice + its 全季 folio confirmed on P-2307, then 去报销 until the job stopped running (without the
// fallback result it never does).
async function started() {
  const scene = await scenario(server, alice).at('actions');
  return { scene, stopped: await scene.run('start-erp-write') };
}

describe('a 去报销 job that ends without sending a result', () => {
  it('ends as aborted when nothing was written, and the task can go again', async () => {
    // The executor returns a result to the job runner but never emits it, so nothing is recorded.
    executor = async () => ({ type: 'result', status: 'aborted', code: 'never_emitted', message: null, billNo: null, capture: null });
    const { scene, stopped } = await started();

    expect(stopped).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, confirmation: { status: 'confirmed' } });
    expect(stopped.erp.abortReason).toContain('没有给出结果');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    // Nothing was written, so the task is still fully editable.
    expect((await scene.act('set-home-city', { homeCity: '上海' })).status).toBe(200);
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
    const { stopped } = await started();

    expect(stopped).toMatchObject({ stage: 'reconcile', step: { kind: 'reconcile' }, erp: { status: 'aborted' }, reconcile: { status: 'pending', allowedActions: ['wait', 'hand_off'] } });
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    // The facts are frozen, but the task can still be retired: ADR-0030 voids any state, ERP 写入结果未知 included.
    const voided = await alice.post(`/api/tasks/${stopped.task.taskId}/abandon`, {});
    expect(voided.status).toBe(200);
  });
});
