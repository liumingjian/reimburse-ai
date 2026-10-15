import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFillJob } from '@baox/erp-executor/job';
import type { ReconcilePlan, ResultEvent } from '@baox/erp-executor/protocol';
import { runReconcileJob } from '@baox/erp-executor/reconcile-job';
import { createFakeErp, type FakeErp, type FakeErpOptions } from '@baox/erp-executor/testing/fake-erp';
import { COMPATIBILITY, ERP_ORIGIN, FAST_PACE } from '@baox/erp-executor/testing/scenario';
import { dataDirBlobs } from './erp/cdp-executor';
import type { FillExecutor } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { draftMarkOf } from './erp/remote-executor';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type Scene, type ScenarioServer } from './test/scenario';
import { fakeErpFor } from './test/scene-erp';

// 对账 after 暂存 (erp-headless-v1.md line 2 item 5): the fill pressed 暂存 under its ownership marker and could not
// tell whether a draft landed. 对账 looks the draft up by that marker through WebAPI, never by reading a page: one
// draft, still 暂存, equal to what the fill verified, is ERP 草稿已交接; no answer offers 对账 again; anything else is
// 转人工. Real executor on the fake ERP, both jobs, as on a 本地执行器 (the in-process path adds the marker itself).

let server: ScenarioServer;
let alice: TestClient;
let fakeOptions: Partial<FakeErpOptions>;
let fake: FakeErp | null = null;
let reconcilePlans: ReconcilePlan[] = [];
let lookupFails = false;
const fillExecutor: FillExecutor = async (plan, channel) => {
  const mark = draftMarkOf(plan.jobId);
  // A 事由 ERP stored differently still ends in the marker, or the lookup would find nothing rather than a mismatch.
  const stored = fakeOptions.draftStoresCausa ? { draftStoresCausa: `${fakeOptions.draftStoresCausa} ${mark}` } : {};
  fake = await createFakeErp(fakeErpFor(reached!, { assumeReceiptLink: true, ...fakeOptions, ...stored }));
  return runFillJob({ ...plan, draft: { mark } }, { browser: fake.browser, blobs: dataDirBlobs(server.dataDir), channel, pace: FAST_PACE, probeWaitMs: 0 });
};
const reconcileExecutor: ReconcileExecutor = async (plan, channel) => {
  reconcilePlans.push(plan);
  if (!lookupFails) return runReconcileJob(plan, { browser: fake!.browser, channel, pace: FAST_PACE, probeWaitMs: 0 });
  await channel.emit({ type: 'draft_lookup', drafts: [], problems: null, failure: '按归属标记查暂存单没有成功：服务器忙' });
  const event: ResultEvent = { type: 'result', status: 'read', code: null, message: null, billNo: null, capture: null };
  await channel.emit(event);
  return event;
};

// The task at 去报销, which the fake ERP is built for.
let reached: Scene['reached'] | null = null;
beforeEach(async () => {
  fakeOptions = {};
  fake = null;
  reached = null;
  reconcilePlans = [];
  lookupFails = false;
  server = await scenarioServer({ erpExecutor: fillExecutor, reconcileExecutor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

/** The default scene's 去报销, on a fake ERP set up by `options`: it stops in 对账 after 暂存. */
async function stoppedAfterDraft(options: Partial<FakeErpOptions>) {
  fakeOptions = options;
  const at = await scenario(server, alice).at('actions');
  reached = at.reached;
  return { scene: at, stopped: await at.run('start-erp-write') };
}

describe('对账 by the ownership marker after 暂存', () => {
  it('offers 对账 and 转人工 while the draft is unlooked-for, and never 重新去报销', async () => {
    const { stopped } = await stoppedAfterDraft({ draftTabStays: true });
    expect(stopped.erp.abortReason).toContain('暂存');
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending', allowedActions: ['wait', 'hand_off'] } });
    expect(stopped.reconcile.banner).toContain('归属标记');
  });

  it('ends at ERP 草稿已交接 when it finds the one draft, equal to what the fill verified', async () => {
    const { scene: at } = await stoppedAfterDraft({ draftTabStays: true });
    const mutations = fake!.mutations.length;

    const done = await at.run('reconcile');

    expect(done, JSON.stringify(done.reconcile)).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted', draftNo: null } });
    const fill = (await server.db.selectFrom('erp_job').select('job_id').where('kind', '=', 'fill').executeTakeFirstOrThrow()).job_id;
    expect(reconcilePlans[0]!.draft).toMatchObject({ mark: draftMarkOf(fill), earlier: [] });
    expect(reconcilePlans[0]!.draft!.expected!.causa).toMatch(new RegExp(` ${draftMarkOf(fill)}$`));
    expect(reconcilePlans[0]!.draft!.expected!.details.length).toBeGreaterThan(0);
    expect(fake!.mutations.length).toBe(mutations);
  });

  it('hands off when no draft carries the marker: whether 暂存 landed cannot be told', async () => {
    const { scene: at } = await stoppedAfterDraft({ draftCommandDead: true });

    const judged = await at.run('reconcile');

    expect(judged).toMatchObject({ stage: 'reconcile', reconcile: { bucket: '未知', action: '转人工', allowedActions: ['hand_off'] } });
    expect(judged.reconcile.banner).toContain('没有找到暂存单');
    expect(judged.reconcile.banner).not.toMatch(/ERP|重试|[–—]/);
  });

  it('hands off when the draft is not what the fill verified', async () => {
    const { scene: at, stopped } = await stoppedAfterDraft({ draftTabStays: true, draftStoresCausa: '被截断的事由' });
    expect(stopped.stage).toBe('reconcile');

    const judged = await at.run('reconcile');

    expect(judged).toMatchObject({ stage: 'reconcile', reconcile: { bucket: '不自洽', allowedActions: ['hand_off'] } });
    expect(judged.reconcile.reasons).toEqual(['事由与写入的不一致']);
  });

  it('offers 对账 again when the lookup got no answer', async () => {
    const { scene: at } = await stoppedAfterDraft({ draftTabStays: true });
    lookupFails = true;

    const judged = await at.run('reconcile');

    expect(judged).toMatchObject({ stage: 'reconcile', reconcile: { bucket: '未知', allowedActions: ['wait', 'hand_off'] } });
    expect(judged.reconcile.banner).toContain('再对账一次');
  });
});
