import { TaskListSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginWall } from './erp/testing/fake-executor';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// The snapshot's `allowedActions` and the list's 可作废 come from the task policy (`task-policy.ts`, where the rules
// are table-tested); these check that the HTTP snapshot and the task list carry its answer.

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer();
});
afterEach(() => server.close());

describe('allowed actions in the snapshot', () => {
  it('confirmed: 去报销 and the changes before it are on offer, and the task can be voided', async () => {
    const scene = await scenario(server).at('actions');
    expect(scene.reached.allowedActions).toEqual([
      'upload',
      'reopen_upload',
      'exclude_material',
      'answer_pending',
      'set_home_city',
      'assign_project_lines',
      'submit_project_assignment',
      'start_erp_write',
      'print',
      'void_task',
    ]);
  });

  it('the login pause offers only its own two writes; the list will not void a task mid-write', async () => {
    const scene = await scenario(server).at('erp', { erp: loginWall });
    expect(scene.reached.allowedActions).toEqual(['confirm_login', 'cancel_erp_write']);
    const list = TaskListSchema.parse(await (await scene.client.request('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === scene.task.taskId)).toMatchObject({ abandonable: false });

    const cancelled = await scene.accept('cancel-erp-write');
    expect(cancelled.allowedActions).toContain('start_erp_write');
    expect(cancelled.allowedActions).toContain('void_task');
  });
});
