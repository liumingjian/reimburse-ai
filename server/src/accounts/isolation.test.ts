import { ERP_ACTION_ERRORS, TaskListSchema, TaskSnapshotSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';

// Per-account data (ADR-0018): an account sees only its own tasks, admins included. The ERP 自动化控制权 lease is
// per 应用账号 (app account) too (ADR-0019): it refuses that account's own second job and nobody else's.

let server: TestServer;
let admin: TestClient;
let alice: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  admin = await server.signIn('admin');
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

async function createTask(client: TestClient) {
  const response = await client.post('/api/tasks', { homeCity: '杭州' });
  expect(response.status).toBe(200);
  return TaskSnapshotSchema.parse(await response.json());
}

async function list(client: TestClient) {
  return TaskListSchema.parse(await (await client.request('/api/tasks')).json());
}

describe('task isolation between accounts', () => {
  it("lists only the signed-in account's own tasks", async () => {
    const mine = await createTask(alice);
    expect((await list(alice)).tasks.map((task) => task.taskId)).toEqual([mine.task.taskId]);
    expect((await list(admin)).tasks).toEqual([]);
  });

  it("answers 404 for another account's task, admin included, on every task route", async () => {
    const { task } = await createTask(alice);
    const form = new FormData();
    form.append('files', new File([Buffer.from('%PDF-1.4\n')], 'a.pdf', { type: 'application/pdf' }));
    for (const [path, init] of [
      [`/api/tasks/${task.taskId}`, {}],
      [`/api/tasks/${task.taskId}/events`, {}],
      [`/api/tasks/${task.taskId}/batches`, { method: 'POST', body: form }],
    ] as const) {
      const response = await admin.request(path, init);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'task_not_found' } });
    }
    // Nothing leaked into alice's task either.
    const snapshot = TaskSnapshotSchema.parse(await (await alice.request(`/api/tasks/${task.taskId}`)).json());
    expect(snapshot.materials).toEqual([]);
  });

  it("resets only the signed-in account's tasks", async () => {
    await createTask(admin);
    const kept = await createTask(alice);
    const reset = await admin.post('/api/reset', {});
    expect(TaskListSchema.parse(await reset.json()).tasks).toEqual([]);
    expect((await list(alice)).tasks.map((task) => task.taskId)).toEqual([kept.task.taskId]);
  });
});

describe('the per-account ERP lease', () => {
  it("leaves another account's start-erp-write alone, and lets both accounts hold the lease at once", async () => {
    const adminTask = await createTask(admin);
    const aliceTask = await createTask(alice);
    expect(server.erpLease.acquire({ accountId: admin.account.accountId, taskId: adminTask.task.taskId, jobId: 'admin-job' })).toBe(true);

    // Alice is refused only by her own task's state, never by the admin's running job: the instance is not a queue.
    const response = await alice.post(`/api/tasks/${aliceTask.task.taskId}/actions/start-erp-write`, { stepToken: aliceTask.step.stepToken });
    expect(response.status).not.toBe(409);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'not_ready' } });

    // And her account's own lease is free to take while the admin still holds his.
    expect(server.erpLease.acquire({ accountId: alice.account.accountId, taskId: aliceTask.task.taskId, jobId: 'alice-job' })).toBe(true);
    expect(server.erpLease.holder(admin.account.accountId)).toMatchObject({ jobId: 'admin-job' });
    expect(server.erpLease.holder(alice.account.accountId)).toMatchObject({ jobId: 'alice-job' });
  });

  it("gives start-erp-write 409 while another job of the same account holds the lease, naming no task", async () => {
    const other = await createTask(alice);
    // A job of hers that this task knows nothing about: 一个应用账号 owns one active 报销任务 at a time, so the
    // account's other job is reached through the lease rather than through a second task.
    expect(server.erpLease.acquire({ accountId: alice.account.accountId, taskId: 'her-other-job-task', jobId: 'alice-job' })).toBe(true);

    const response = await alice.post(`/api/tasks/${other.task.taskId}/actions/start-erp-write`, { stepToken: other.step.stepToken });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string }; snapshot: unknown };
    expect(body.error).toEqual({ code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse });
    expect(TaskSnapshotSchema.parse(body.snapshot).task.taskId).toBe(other.task.taskId);
    // The refusal names no task, not even one of her own.
    expect(JSON.stringify(body)).not.toContain('her-other-job-task');

    server.erpLease.release('alice-job');
    const free = await alice.post(`/api/tasks/${other.task.taskId}/actions/start-erp-write`, { stepToken: other.step.stepToken });
    expect(free.status).not.toBe(409);
  });
});
