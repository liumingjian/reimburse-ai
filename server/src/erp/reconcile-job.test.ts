// The server's end of reconcile (对账): the read-only job driven through the protocol on the fake ERP, with the
// real server channel persisting its events on SQLite `:memory:` and the server classifying what was read. The job's
// own behaviour (read-only, login wall) is tested in erp-executor/src/reconcile-job.test.ts. Parity: for each
// recorded draft state (@baox/erp-executor/testing/reconcile-states) the job reads what the kernel reads and lands in the kernel's bucket; the golden
// was recorded by running 50931a3:kernel/src/erpreconcile.mjs readReconciliation (with erp-cdp-read.mjs readers) and
// classifyReconciliation against the same fake ERP states, see its `_origin`.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/database';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { createFakeErp, type FakeErp } from '@baox/erp-executor/testing/fake-erp';
import { createErpJobs, serverChannel } from './jobs';
import { ReconcilePlanSchema, type ApprovedPreview, type ReadbackEvent } from '@baox/erp-executor/protocol';
import { reconcileFromEvents, type ReconcileExecutor } from './reconcile-job';
import { driveTo, RECONCILE_STATES, type ReconcileState } from '@baox/erp-executor/testing/reconcile-states';
import { FAST_PACE, fakeErpOptions, reconcilePlan, withoutLayout } from '@baox/erp-executor/testing/scenario';

const golden = JSON.parse(readFileSync(new URL('./testing/reconcile-parity.golden.json', import.meta.url), 'utf8'));

// ONE STATE DIVERGES FROM THE KERNEL, BY DECISION. In 「不生成费用明细」 mode ERP leaves 收票单号 empty on every
// 费用明细行; the kernel's strict per-line match could not bind a single row and called the form 不自洽. The owner
// decided 2026-09-20 that a form is judged on its totals, so the very same reading is now 未保存·就绪待保存 — the
// bill adds up to the task and is waiting for the employee to save it. The golden file is left as it was: it is a
// recording of what the kernel did, not a target, and falsifying it would lose the only evidence of the change.
// The 不自洽 bucket itself is still exercised — by a drifted amount in `erp-reconcile.test.ts` and by a
// new/modify contradiction in `reconcile.test.ts`.
const DIVERGES_FROM_KERNEL: Partial<Record<ReconcileState, { bucket: string; action: string; reasons: string[] }>> = {
  filled_unlinked: { bucket: '未保存·就绪待保存', action: '原地等待', reasons: ['两边都是 75463 分，按分相等，差保存这一下'] },
};

// ADR-0040 changes the generated detail rows, while the original kernel recording remains historical evidence.
// The fake's optional receipt-link assumption used net amounts; the gross/zero flow leaves that column empty.
function currentReadings(recorded: typeof golden.states.filled.readings, state: ReconcileState) {
  const readings = structuredClone(recorded);
  if (state === 'filled' || state === 'filled_unlinked' || state === 'saved') {
    for (const row of readings.detailGrid.rows) if (row.kind === 'data') {
      row.values['费用金额'] = row.values['申请报销金额'];
      row.values['税额'] = '¥0.00';
      row.values['收票单号'] = '';
    }
  }
  return readings;
}

let server: TestServer;
let db: Db;
let taskId: string;
beforeEach(async () => {
  server = await createTestServer();
  db = server.db;
  const { account } = await server.signIn('alice');
  taskId = (await createTaskService(db, server.dataDir, account.accountId).create('合肥')).task.taskId;
});
afterEach(() => server.close());

/** Drive one reconcile job through an executor and classify its read-back. A reconcile read-back is acknowledged, never judged live. */
async function runReconcile({ plan: rawPlan, expectedPreview, execute }: { plan: unknown; expectedPreview: unknown; execute: ReconcileExecutor }) {
  const plan = ReconcilePlanSchema.parse(rawPlan);
  const jobs = createErpJobs(db);
  const result = await execute(plan, serverChannel({ jobs, jobId: plan.jobId, taskId: plan.taskId, judge: () => ({ ok: true }) }));
  const events = await jobs.events(plan.jobId);
  return { result, events, attempts: await jobs.attempts(plan.jobId), reconcile: reconcileFromEvents(events, expectedPreview) };
}

/** Run one reconcile job on the fake as it stands. */
const reconcile = (fake: FakeErp, expectedPreview: ApprovedPreview | null) => runReconcile({
  plan: reconcilePlan(taskId), expectedPreview,
  execute: (plan, channel) => runReconcileJob(plan, { browser: fake.browser, channel, pace: FAST_PACE, probeWaitMs: 0 }),
});

describe('reconcile job on the fake ERP', () => {
  it.each(RECONCILE_STATES)('%s: reads what the kernel reads and yields the kernel bucket', async (state) => {
    const recorded = golden.states[state];
    const expected = { ...recorded, verdict: { ...recorded.verdict, ...(DIVERGES_FROM_KERNEL[state] ?? {}) } };
    const { fake, preview } = await driveTo(state);
    const { result, events, attempts, reconcile: judged } = await reconcile(fake, preview);

    expect(result).toMatchObject({ type: 'result', status: 'read', code: null, capture: null });
    const readback = events.find((event): event is ReadbackEvent => event.type === 'readback');
    expect(withoutLayout(readback!.readings)).toEqual(currentReadings(expected.readings, state));
    expect(judged!.verdict).toEqual(expected.verdict);
    expect(attempts).toEqual([]);
  });

  it('the recorded kernel states cover all six buckets', () => {
    const buckets = new Set(RECONCILE_STATES.map((state) => golden.states[state].verdict.bucket));
    expect([...buckets].sort()).toEqual(['不自洽', '已保存', '未保存·导入前', '未保存·已导入未写明细', '未保存·就绪待保存', '未知'].sort());
  });

  it('records no verdict when the job cannot log in', async () => {
    const fake = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    const { result, events, reconcile: judged } = await reconcile(fake, null);
    expect(result).toMatchObject({ status: 'aborted', code: 'erp_login' });
    expect(events.some((event) => event.type === 'readback')).toBe(false);
    expect(judged).toBeNull();
  });

  it('re-derives the same bucket from the persisted event log (restart-safe)', async () => {
    const { fake, preview } = await driveTo('imported');
    const { reconcile: judged } = await reconcile(fake, preview);
    const again = reconcileFromEvents(await createErpJobs(db).events(`reconcile-${taskId}`), preview);
    expect(again!.verdict).toEqual(judged!.verdict);
    expect(again!.verdict).toMatchObject({ bucket: '未保存·已导入未写明细', action: '转人工' });
    expect(again!.record).toMatchObject({ kind: 'erp-reconcile', bucket: '未保存·已导入未写明细', readings: { receipts: { rowCount: 2 } } });
  });
});
