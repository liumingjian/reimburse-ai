// The executor seam for 对账 (reconcile): the read-only job driven through the protocol on the fake ERP, with the
// real server channel persisting its events on SQLite `:memory:`. Parity: for each recorded draft state
// (testing/reconcile-states.ts) the job reads what the kernel reads and lands in the kernel's bucket; the golden
// was recorded by running 50931a3:kernel/src/erpreconcile.mjs readReconciliation (with erp-cdp-read.mjs readers) and
// classifyReconciliation against the same fake ERP states, see its `_origin`.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/database';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runReconcileJob } from './executor/reconcile-job';
import { createFakeErp, type FakeErp } from './executor/testing/fake-erp';
import { createErpJobs } from './jobs';
import type { ApprovedPreview, ReadbackEvent } from './protocol';
import { reconcileFromEvents, runReconcile } from './reconcile-job';
import { driveTo, RECONCILE_STATES } from './testing/reconcile-states';
import { FAST_PACE, fakeErpOptions, reconcilePlan, withoutLayout } from './testing/scenario';

const golden = JSON.parse(readFileSync(new URL('./testing/reconcile-parity.golden.json', import.meta.url), 'utf8'));

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

/** Run one reconcile job on the fake as it stands, and return the CDP commands the job itself sent. */
async function reconcile(fake: FakeErp, expectedPreview: ApprovedPreview | null) {
  const commandsBefore = fake.commands.length;
  const mutationsBefore = fake.mutations.length;
  const run = await runReconcile({
    db, plan: reconcilePlan(taskId), expectedPreview,
    execute: (plan, channel) => runReconcileJob(plan, { browser: fake.browser, channel, pace: FAST_PACE, probeWaitMs: 0 }),
  });
  return { ...run, sent: fake.commands.slice(commandsBefore), newMutations: fake.mutations.slice(mutationsBefore) };
}

describe('reconcile job on the fake ERP', () => {
  it.each(RECONCILE_STATES)('%s: reads what the kernel reads and yields the kernel bucket', async (state) => {
    const expected = golden.states[state];
    const { fake, preview } = await driveTo(state);
    const { result, events, attempts, reconcile: judged } = await reconcile(fake, preview);

    expect(result).toMatchObject({ type: 'result', status: 'read', code: null, capture: null });
    const readback = events.find((event): event is ReadbackEvent => event.type === 'readback');
    expect(withoutLayout(readback!.readings)).toEqual(expected.readings);
    expect(judged!.verdict).toEqual(expected.verdict);
    expect(attempts).toEqual([]);
  });

  it('the recorded states cover all six buckets', () => {
    const buckets = new Set(RECONCILE_STATES.map((state) => golden.states[state].verdict.bucket));
    expect([...buckets].sort()).toEqual(['不自洽', '已保存', '未保存·导入前', '未保存·已导入未写明细', '未保存·就绪待保存', '未知'].sort());
  });

  it('issues no mutating CDP call in any state: only Runtime.evaluate, no ERP change, no attempt', async () => {
    for (const state of RECONCILE_STATES) {
      const { fake, preview } = await driveTo(state);
      const { sent, newMutations, attempts } = await reconcile(fake, preview);
      expect(sent.length, state).toBeGreaterThan(0);
      expect([...new Set(sent.map((command) => command.method))], state).toEqual(['Runtime.evaluate']);
      expect(newMutations, state).toEqual([]);
      expect(attempts, state).toEqual([]);
    }
  });

  it('pauses for login on the login page, without a read-back or any input', async () => {
    const fake = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    const { result, events, reconcile: judged, sent } = await reconcile(fake, null);
    expect(result).toMatchObject({ status: 'waiting_login', code: 'erp_login' });
    expect(events.some((event) => event.type === 'waiting_login')).toBe(true);
    expect(judged).toBeNull();
    expect(sent.every((command) => command.method === 'Runtime.evaluate')).toBe(true);
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
