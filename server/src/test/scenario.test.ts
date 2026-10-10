import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginWall } from '../erp/testing/fake-executor';
import { scenario, scenarioServer, type ScenarioServer } from './scenario';

// The scenario builder's own promises: a stage the ladder passes by throws naming where the task ended up, and a
// scene's ERP scripts play for its own task only.

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer();
});
afterEach(() => server.close());

describe('scenario builder', () => {
  it('names the stage a task stopped in when a later stage was asked for', async () => {
    await expect(scenario(server).at('review', { materials: ['m01', 'm12'] })).rejects.toThrow(
      /asked for stage review, but after answering the 住宿 trio the task is at pending \/ answer_pending \(open items: /,
    );
  });

  it("keeps a scene's ERP scripts to its own task, even when the scene stopped before fill ERP (去报销)", async () => {
    // Another invoice than the later scene's default one: a second task may not hold the same invoice (invoice occupancy, 发票占用).
    const early = await scenario(server).at('review', { materials: ['m07'], erp: loginWall });
    const later = await scenario(server).at('done');
    expect(later.reached.stage).toBe('done');

    // The early scene's task still plays its own script once it gets there.
    await early.accept('confirm-review', { digest: early.reached.confirmation.digest });
    expect((await early.run('start-erp-write')).step.kind).toBe('erp_login');
  });
});
