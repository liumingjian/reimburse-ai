// Executor events stored before ADR-0037 (a login pause, a form handed over unsaved) stay in the append-only
// `erp_job_event` table: the task list and the task's 去报销 state still read them, in today's terms.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import { api } from '../test/api';
import { loadErp } from './fill-state';
import { createErpJobs } from './jobs';

let server: TestServer;
let alice: TestClient;
let accountId: string;
let tasks: ReturnType<typeof api>;

beforeEach(async () => {
  server = await createTestServer();
  alice = await server.signIn('alice');
  accountId = alice.account.accountId;
  tasks = api(() => alice);
});
afterEach(() => server.close());

const step = (name: string, status: string) => ({ type: 'step', step: name, status });
const result = (status: string, code: string | null, message: string | null) => ({ type: 'result', status, code, message, billNo: null, capture: null });

async function legacyJob(events: object[]): Promise<{ taskId: string; jobId: string }> {
  const { task } = await tasks.createTask('杭州');
  const jobId = `legacy-${task.taskId}`;
  const at = new Date().toISOString();
  await server.db.insertInto('erp_job').values({
    job_id: jobId, task_id: task.taskId, account_id: accountId, kind: 'fill', trigger: 'start', confirmation_digest: 'legacy', plan: JSON.stringify({ plan: {}, judge: { lines: [] } }), revision: 1, started_at: at,
  }).execute();
  await server.db.insertInto('erp_job_event').values(events.map((event, seq) => ({
    event_id: `${jobId}-${seq}`, job_id: jobId, task_id: task.taskId, seq, type: (event as { type: string }).type, payload: JSON.stringify(event), created_at: at,
  }))).execute();
  return { taskId: task.taskId, jobId };
}

describe('executor events stored before ADR-0037', () => {
  it('reads a login pause as a job that stopped before writing anything', async () => {
    const { taskId, jobId } = await legacyJob([
      step('chromium', 'running'), step('chromium', 'done'), step('login', 'running'),
      { type: 'waiting_login', hint: '请在打开的浏览器里登录报销系统' },
      result('waiting_login', null, '请在打开的浏览器里登录报销系统'),
    ]);

    const record = await loadErp(server.db, taskId);
    expect(record.facts?.phase).toBe('aborted');
    expect(record.result).toMatchObject({ status: 'aborted', code: 'erp_login', message: '请在打开的浏览器里登录报销系统' });
    expect((await createErpJobs(server.db).events(jobId)).map((event) => event.type)).toEqual(['step', 'step', 'step', 'result']);
  });

  it('reads a form handed over unsaved as a write result 对账 has to settle', async () => {
    const { taskId } = await legacyJob([step('handover', 'running'), step('handover', 'done'), result('handed_over', null, null)]);

    const record = await loadErp(server.db, taskId);
    expect(record.facts?.phase).toBe('unknown');
    expect(record.result).toMatchObject({ status: 'unknown', code: 'handed_over' });
  });

  it.each(['waiting_login', 'handed_over'])('keeps the task list and the task readable after a %s result', async (status) => {
    const { taskId } = await legacyJob([result(status, null, null)]);

    expect((await alice.request('/api/tasks')).status).toBe(200);
    await tasks.current(taskId);
  });
});
