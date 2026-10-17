// 对账 after 暂存 (erp-headless-v1.md line 2 item 5), the executor's half: with `draft` in its plan the reconcile job
// reads no form. It looks the draft up by the ownership marker through WebAPI, reads the one it finds back by its 内码,
// and compares it with the read-back the fill verified before 暂存. It only reads, and it judges nothing.
import { describe, expect, it } from 'vitest';
import { runFillJob } from './job';
import { filledRows, markedPurpose, type ExecutorEvent, type ReadbackEvent } from './protocol';
import { runReconcileJob } from './reconcile-job';
import { createFakeErp, type FakeErpOptions } from './testing/fake-erp';
import { approvedPreview, blobSource, FAST_PACE, fakeErpOptions, fillPlan, reconcilePlan } from './testing/scenario';
import { stubServer } from './testing/stub-server';

const taskId = 'task-reconcile-draft';
const MARK = 'baox-k3m9q2x7v1';
const EARLIER = 'baox-0a1b2c3d4e';

/** A fill that 暂存s under MARK, then a 对账 by the marker on the same ERP, with what the fill verified as expected. */
async function draftThenReconcile(options: Partial<FakeErpOptions> = {}, earlier: string[] = []) {
  const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, ...options }));
  const fill = stubServer({ taskId });
  const filled = await runFillJob({ ...fillPlan(taskId), draft: { mark: MARK } }, { browser: fake.browser, blobs: blobSource(), channel: fill.channel, pace: FAST_PACE, probeWaitMs: 0 });
  const verified = fill.events.filter((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'before_hand_over').at(-1)!;
  const expected = { causa: markedPurpose(approvedPreview(taskId).purpose, MARK), receipts: filledRows(verified.readings.receiptsGrid), details: filledRows(verified.readings.detailGrid) };
  const commandsBefore = fake.commands.length;
  const mutationsBefore = fake.mutations.length;
  const server = stubServer({ taskId });
  const result = await runReconcileJob(reconcilePlan(taskId, { draft: { mark: MARK, earlier, expected } }), { browser: fake.browser, channel: server.channel, pace: FAST_PACE, probeWaitMs: 0 });
  const lookup = server.events.find((event): event is Extract<ExecutorEvent, { type: 'draft_lookup' }> => event.type === 'draft_lookup');
  return { filled, result, lookup, events: server.events, attempts: server.attempts, sent: fake.commands.slice(commandsBefore), newMutations: fake.mutations.slice(mutationsBefore) };
}

describe('对账 by the ownership marker', () => {
  it('finds the draft a 暂存 left behind with the tab still 新增, and reads it back equal to what the fill verified', async () => {
    const { filled, result, lookup, events } = await draftThenReconcile({ draftTabStays: true });
    expect(filled).toMatchObject({ status: 'unknown', code: 'draft_not_observed' });
    expect(result).toMatchObject({ type: 'result', status: 'read', code: null });
    expect(lookup).toEqual({ type: 'draft_lookup', drafts: [{ mark: MARK, id: '119946', billNo: null, status: 'Z' }], problems: [], failure: null });
    // It reads no form: there is nothing on the page that says anything about the draft.
    expect(events.some((event) => event.type === 'readback')).toBe(false);
  });

  it('only reads: no input, no ERP change, no attempt', async () => {
    const { sent, newMutations, attempts } = await draftThenReconcile({ draftTabStays: true });
    expect([...new Set(sent.map((command) => command.method))]).toEqual(['Runtime.evaluate']);
    expect(newMutations).toEqual([]);
    expect(attempts).toEqual([]);
  });

  it('reports no draft when 暂存 landed nothing', async () => {
    const { lookup } = await draftThenReconcile({ draftCommandDead: true });
    expect(lookup).toEqual({ type: 'draft_lookup', drafts: [], problems: null, failure: null });
  });

  it('reports every draft under an earlier job\'s mark, and compares none of them', async () => {
    const { lookup } = await draftThenReconcile({ draftTabStays: true, draftsBefore: [`出差 ${EARLIER}`] }, [EARLIER]);
    expect(lookup?.drafts.map((draft) => draft.mark)).toEqual([MARK, EARLIER]);
    expect(lookup?.problems).toBeNull();
  });

  it('names what ERP stored differently from what the fill verified', async () => {
    const { lookup } = await draftThenReconcile({ draftTabStays: true, draftStoresCausa: `被截断的事由 ${MARK}` });
    expect(lookup?.drafts).toHaveLength(1);
    expect(lookup?.problems).toEqual(['事由与写入的不一致']);
  });
});
