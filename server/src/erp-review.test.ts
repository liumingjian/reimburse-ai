import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { join } from 'node:path';
import type { ExecutorEvent, ResultEvent } from '@baox/erp-executor/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FillExecutor } from './erp/fill-jobs';
import type { ReconcileExecutor } from './erp/reconcile-job';
import { draftMarkOf } from './erp/remote-executor';
import { abortBeforeAttempt, drafted, draftReadbackMismatch, uncertainDraft, type Script } from './erp/testing/fake-executor';
import { tempDataDir, testClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Where the employee reviews the bill 去报销 left in the 报销系统 (spec #406, ticket #407): the snapshot's `erp.review`
// carries the 报销系统 entry page and the 暂存单's 内码 when a 暂存单 exists for the task, and nothing otherwise. The
// address is the one the task's fill plan froze, never the server's current configuration.

const ENTRY = (origin: string) => `${origin}/k3cloud/html5/index.aspx`;

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer({ erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
});
afterEach(() => server.close());

describe('erp.review: where the employee checks the 暂存单', () => {
  it('points at the 报销系统 entry page and the 内码 when 去报销 ends at ERP 草稿已交接', async () => {
    const { reached } = await scenario(server).at('done', { erp: drafted });

    expect(reached.erp).toMatchObject({ outcome: 'drafted', review: { url: ENTRY(ERP_ORIGIN), draftId: '119946' } });
  });

  it('keeps the origin the fill plan froze when the server\'s 报销系统 address changed afterwards', async () => {
    const dir = tempDataDir();
    const database = join(dir, 'baox.sqlite');
    const before = 'https://erp-before.example.test';
    const first = await scenarioServer({ erpConfig: { origin: before, compatibility: COMPATIBILITY }, database, dataDir: dir });

    try {
      const scene = await scenario(first).at('done', { erp: drafted });
      const second = await scenarioServer({ erpConfig: { origin: 'https://erp-after.example.test', compatibility: COMPATIBILITY }, database, dataDir: dir });
      try {
        const again = await scenario(second, testClient(second.app, scene.client.account, scene.client.cookie)).of(scene.task.taskId);

        expect(again.reached.erp.review).toEqual({ url: ENTRY(before), draftId: '119946' });
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it('points at the 报销系统 and the 内码 when 写入结果不确定 after a 暂存 whose 回读 did not match', async () => {
    const { reached } = await scenario(server).at('reconcile', { erp: draftReadbackMismatch });

    expect(reached.erp.abortReason).toContain('写入报销系统的结果不确定');
    expect(reached.erp.review).toEqual({ url: ENTRY(ERP_ORIGIN), draftId: '119985' });
  });

  it('is absent when 写入结果不确定 and no 暂存单 内码 is known', async () => {
    const { reached } = await scenario(server).at('reconcile', { erp: uncertainDraft });

    expect(reached.erp.abortReason).toContain('写入报销系统的结果不确定');
    expect(reached.erp.review).toBeNull();
  });

  it('is absent when 去报销 stopped before writing anything', async () => {
    const scene = await scenario(server).at('actions', { erp: abortBeforeAttempt });

    const stopped = await scene.run('start-erp-write');

    expect(stopped.erp.abortReason).toContain('报销系统没有被改动');
    expect(stopped.erp.review).toBeNull();
  });

  it('is absent on a hand-over: the filled form was left open unsaved and nothing was 暂存ed', async () => {
    const { reached } = await scenario(server).at('done');

    expect(reached.erp).toMatchObject({ outcome: 'filled', review: null });
  });
});

// 对账 after 暂存 looks the draft up by the 暂存 job's ownership marker (`draft_lookup`). As on a 本地执行器, the fill
// job is given the marker; the 对账 executor answers with the drafts `found` returns for that marker.
describe('erp.review after 对账 by the ownership marker', () => {
  let found: (mark: string) => Extract<ExecutorEvent, { type: 'draft_lookup' }>;
  let fill: Script;
  let marked: ScenarioServer;
  const fillExecutor: FillExecutor = (plan, channel) => fill({ ...plan, draft: { mark: draftMarkOf(plan.jobId) } }, channel);
  const reconcileExecutor: ReconcileExecutor = async (plan, channel) => {
    await channel.emit(found(plan.draft!.mark));
    const event: ResultEvent = { type: 'result', status: 'read', code: null, message: null, billNo: null, capture: null };
    await channel.emit(event);
    return event;
  };
  beforeEach(async () => {
    marked = await scenarioServer({ erpExecutor: fillExecutor, reconcileExecutor, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  });
  afterEach(() => marked.close());

  it('is absent once 对账 finds the 暂存单 saved: it is a bill now, not a draft to check', async () => {
    fill = draftReadbackMismatch;
    found = (mark) => ({ type: 'draft_lookup', drafts: [{ mark, id: '119985', billNo: 'FYBX20261016000001', status: 'C' }], problems: [], failure: null });
    const scene = await scenario(marked).at('reconcile');
    expect(scene.reached.erp.review).toEqual({ url: ENTRY(ERP_ORIGIN), draftId: '119985' });

    const judged = await scene.run('reconcile');

    expect(judged.reconcile).toMatchObject({ bucket: '已保存' });
    expect(judged.erp.review).toBeNull();
  });

  it.each([
    ['does not match what the fill verified', ['事由与写入的不一致']],
    ['cannot be compared with anything', null],
  ])('points at the 内码 对账 found when the fill reported none and the task\'s one 暂存单 %s', async (_case, problems) => {
    fill = uncertainDraft;
    found = (mark) => ({ type: 'draft_lookup', drafts: [{ mark, id: '119990', billNo: null, status: 'Z' }], problems, failure: null });
    const scene = await scenario(marked).at('reconcile');
    expect(scene.reached.erp.review).toBeNull();

    const judged = await scene.run('reconcile');

    expect(judged.reconcile.action).toBe('转人工');
    expect(judged.erp.review).toEqual({ url: ENTRY(ERP_ORIGIN), draftId: '119990' });
  });
});
