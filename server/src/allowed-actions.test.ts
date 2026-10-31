import { TASK_ACTIONS, TaskListSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drafted, gated } from './erp/testing/fake-executor';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// The snapshot's `allowedActions` and the list's 可作废 come from the task policy (`task-policy.ts`, where the rules
// are table-tested); these check that the HTTP snapshot and the task list carry its answer.

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer();
});
afterEach(() => server.close());

describe('allowed actions in the snapshot', () => {
  it('confirmed: 去报销 is on offer, in contract order, and the task can be voided', async () => {
    const scene = await scenario(server).at('actions');
    const allowed = scene.reached.allowedActions;
    // The full set per state is the policy table's (`task-policy.test.ts`); this checks the snapshot carries it.
    expect(allowed).toEqual(expect.arrayContaining(['start_erp_write', 'print', 'void_task']));
    expect(allowed).not.toContain('confirm_review');
    expect(allowed).toEqual(TASK_ACTIONS.filter((action) => allowed.includes(action)));
  });

  it('a running 去报销 offers nothing at all, and the list will not void a task mid-write; ERP 草稿已交接 leaves print and 作废', async () => {
    const gate = gated(drafted);
    const scene = await scenario(server).at('actions', { erp: gate.script });
    await scene.accept('start-erp-write');
    await gate.running;
    const running = await scene.snapshot();
    expect(running).toMatchObject({ stage: 'erp', step: { kind: 'none' }, erp: { status: 'running' } });
    expect(running.allowedActions).toEqual([]);
    const list = TaskListSchema.parse(await (await scene.client.request('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === scene.task.taskId)).toMatchObject({ abandonable: false });

    gate.release();
    const done = await scene.settled();
    expect(done).toMatchObject({ stage: 'done', erp: { outcome: 'drafted' } });
    expect(done.allowedActions).toEqual(['print', 'summary', 'void_task']);
  });
});
