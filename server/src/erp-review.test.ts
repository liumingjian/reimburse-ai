import { COMPATIBILITY, ERP_ORIGIN } from '@baox/erp-executor/testing/scenario';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortBeforeAttempt, drafted, savedDraft } from './erp/testing/fake-executor';
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
    const scene = await scenario(first).at('done', { erp: drafted });

    const second = await scenarioServer({ erpConfig: { origin: 'https://erp-after.example.test', compatibility: COMPATIBILITY }, database, dataDir: dir });
    const again = await scenario(second, testClient(second.app, scene.client.account, scene.client.cookie)).of(scene.task.taskId);

    expect(again.reached.erp.review).toEqual({ url: ENTRY(before), draftId: '119946' });
    await second.close();
    await first.close().catch(() => undefined);
  });

  it('is absent when 去报销 stopped before writing anything', async () => {
    const scene = await scenario(server).at('actions', { erp: abortBeforeAttempt });

    const stopped = await scene.run('start-erp-write');

    expect(stopped.erp.abortReason).toContain('报销系统没有被改动');
    expect(stopped.erp.review).toBeNull();
  });

  it('is absent once the bill is saved: it is no draft any more', async () => {
    const { reached } = await scenario(server).at('done', { erp: savedDraft });

    expect(reached.erp).toMatchObject({ outcome: 'saved', review: null });
  });

  it('is absent on a 浏览器扩展 hand-over: the filled form is already open in the employee\'s own tab', async () => {
    const { reached } = await scenario(server).at('done');

    expect(reached.erp).toMatchObject({ outcome: 'filled', review: null });
  });
});
