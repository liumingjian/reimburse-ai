// The reconcile (对账) job's own behaviour on the fake ERP: it only reads. Each recorded draft state
// (testing/reconcile-states.ts) is read through a stubbed server end; what the server makes of the reading is
// tested in server/src/erp/reconcile-job.test.ts.
import { describe, expect, it } from 'vitest';
import { runReconcileJob } from './reconcile-job';
import { createFakeErp, type FakeErp } from './testing/fake-erp';
import { driveTo, RECONCILE_STATES } from './testing/reconcile-states';
import { FAST_PACE, fakeErpOptions, reconcilePlan } from './testing/scenario';
import { stubServer } from './testing/stub-server';

const taskId = 'task-reconcile';

/** Run one reconcile job on the fake as it stands, and return what the job itself sent and changed. */
async function reconcile(fake: FakeErp) {
  const commandsBefore = fake.commands.length;
  const mutationsBefore = fake.mutations.length;
  const server = stubServer({ taskId });
  const result = await runReconcileJob(reconcilePlan(taskId), { browser: fake.browser, channel: server.channel, pace: FAST_PACE, probeWaitMs: 0 });
  return { result, events: server.events, attempts: server.attempts,
    sent: fake.commands.slice(commandsBefore), newMutations: fake.mutations.slice(mutationsBefore) };
}

describe('reconcile job on the fake ERP', () => {
  // One state per test: driving all seven through a full fill and reconcile job inside a single 5s timeout made this
  // flake. Each state now gets its own timeout, and a failure names the state that broke.
  it.each(RECONCILE_STATES)('%s: issues no mutating CDP call, only Runtime.evaluate, no ERP change, no attempt', async (state) => {
    const { fake } = await driveTo(state, taskId);
    const { result, events, sent, newMutations, attempts } = await reconcile(fake);
    expect(result).toMatchObject({ type: 'result', status: 'read', code: null, capture: null });
    expect(events.filter((event) => event.type === 'readback').map((event) => (event as { stage: string }).stage)).toEqual(['reconcile']);
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent.map((command) => command.method))]).toEqual(['Runtime.evaluate']);
    expect(newMutations).toEqual([]);
    expect(attempts).toEqual([]);
  });

  it('reports a missing ERP page without claiming the saved credentials are missing', async () => {
    const server = stubServer({ taskId });
    const result = await runReconcileJob(reconcilePlan(taskId), {
      browser: { listPages: async () => [], attach: async () => { throw new Error('no page to attach'); } },
      channel: server.channel, pace: FAST_PACE, probeWaitMs: 0,
    });
    expect(result).toMatchObject({ status: 'aborted', code: 'erp_no_tab' });
    expect(result.message).not.toContain('设置页');
    expect(server.attempts).toEqual([]);
  });

  it('stops on the login page when there is nothing to sign in with, without a read-back or any input', async () => {
    const fake = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    const { result, events, sent } = await reconcile(fake);
    expect(result).toMatchObject({ status: 'aborted', code: 'erp_login' });
    expect(events.some((event) => event.type === 'readback')).toBe(false);
    expect(sent.every((command) => command.method === 'Runtime.evaluate')).toBe(true);
  });

  it('signs in on the login page when given a way to, then reads (headless, ADR-0033)', async () => {
    const fake = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    const server = stubServer({ taskId });
    const result = await runReconcileJob(reconcilePlan(taskId), {
      browser: fake.browser, channel: server.channel, pace: FAST_PACE, probeWaitMs: 0,
      signIn: async () => { await fake.login(); return { ok: true }; },
    });
    expect(result).toMatchObject({ status: 'read', code: null });
    expect(server.events.filter((event) => event.type === 'readback')).toHaveLength(1);
    expect(server.attempts).toEqual([]);
  });
});
