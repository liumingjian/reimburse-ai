import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// QA on the intranet host after #436: jobs recorded before it still carry the attended path's `waiting_login` notice
// and `handed_over` / `waiting_login` results (`erp_job_event` is append-only), and one such job failed the whole task
// list with HTTP 500. No executor sends them any more, so they are appended here as the host holds them.

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer();
});
afterEach(() => server.close());

async function appendLegacy(taskId: string, events: Record<string, unknown>[]) {
  const last = await server.db.selectFrom('erp_job_event').select(['job_id', 'seq']).where('task_id', '=', taskId).orderBy('seq', 'desc').executeTakeFirstOrThrow();
  for (const [i, event] of events.entries()) {
    await server.db.insertInto('erp_job_event').values({
      event_id: randomUUID(), job_id: last.job_id, task_id: taskId, seq: last.seq + 1 + i,
      type: event.type as string, payload: JSON.stringify(event), created_at: new Date().toISOString(),
    }).execute();
  }
}

describe('a job recorded before #436', () => {
  it('lists the tasks, and keeps a handed_over task closed', async () => {
    const scene = await scenario(server).at('done');
    await appendLegacy(scene.task.taskId, [
      { type: 'waiting_login', hint: '请在为这次报销打开的报销系统标签页中登录' },
      { type: 'result', status: 'handed_over', code: null, message: null, billNo: null, capture: null },
    ]);

    expect((await scene.client.request('/api/tasks')).status).toBe(200);
    expect(await scene.snapshot()).toMatchObject({ stage: 'done', erp: { status: 'done' } });
  });
});
