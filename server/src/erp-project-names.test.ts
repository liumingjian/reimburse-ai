import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectBookSchema } from '@baox/contract';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { bookChange } from './test/project-book';
import { drafted, readbackMismatch, type Script } from './erp/testing/fake-executor';
import type { FrozenJob } from './erp/fill-plan';
import { loadErp } from './erp/fill-state';
import { judgeInputs } from './erp/fill-plan';
import { writeEvent } from './erp/jobs';

let server: ScenarioServer;
beforeEach(async () => { server = await scenarioServer(); });
afterEach(() => server.close());
const canonical = 'ERP 中的完整正式项目名称';
const renamed: Script = async (plan, channel) => {
  await channel.emit({ type: 'catalog_confirmed', projects: plan.catalog.projects.map(project => ({ code: project.code, name: canonical })) });
  return drafted(plan, channel);
};

describe('ERP project names', () => {
  it('refreshes the selected personal book and frozen task without invalidating confirmation or changing another owner', async () => {
    const alice = await server.signIn('alice');
    const bob = await server.signIn('bob');
    await bookChange(alice, '/api/project-book/intake', { number: 'P-2307', name: '简名', deadlineOn: '2027-12-31' });
    await bookChange(bob, '/api/project-book/intake', { number: 'P-2307', name: '他人的简名' });
    const stopped: Script = async (plan, channel) => {
      await channel.emit({ type: 'catalog_confirmed', projects: plan.catalog.projects.map(project => ({ code: project.code, name: canonical })) });
      return readbackMismatch(plan, channel);
    };
    const scene = await scenario(server, alice).at('actions', { projectBook: 'as_is', erp: stopped });
    const before = scene.reached;
    await scene.accept('start-erp-write');
    const after = await scene.settled();
    expect(after.confirmation.status).toBe('confirmed');
    expect(after.confirmation.digest).toBe(before.confirmation.digest);
    expect(after.lines.every(line => line.projectName === canonical)).toBe(true);
    expect(after.projectAssignment.assignments.every(pin => pin.projectName === canonical)).toBe(true);
    const book = ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json());
    expect(book.projects).toContainEqual(expect.objectContaining({ number: 'P-2307', name: canonical, deadlineOn: '2027-12-31', active: true }));
    const other = ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json());
    expect(other.projects[0]?.name).toBe('他人的简名');
    const frozen = (await loadErp(server.db, scene.task.taskId)).frozen as FrozenJob;
    expect(frozen.judge.lines.every(line => line.projectName === canonical)).toBe(true);
    expect(frozen.plan.catalog.projects[0]?.name).toBe(canonical);
    expect(judgeInputs(frozen.judge, null).lines?.every(line => line.projectName === canonical)).toBe(true);
    const originalJob = (await loadErp(server.db, scene.task.taskId)).job!;
    const jobId = 'project-name-recovery';
    await server.db.insertInto('erp_job').values({ ...originalJob, job_id: jobId, trigger: 'rerun', revision: after.revision + 1, plan: JSON.stringify(frozen) }).execute();
    await writeEvent(server.db, jobId, scene.task.taskId, { type: 'result', status: 'aborted', code: 'erp_login', message: '登录前停止', billNo: null, capture: null }, new Date().toISOString());
    const recovery = await scene.snapshot();
    expect(recovery.lines.every(line => line.projectName === canonical)).toBe(true);
    expect(recovery.confirmation.status).toBe('confirmed');
  });

  it('refreshes a selected public book as an ERP fact for a non-admin employee', async () => {
    const admin = await server.signIn('admin');
    const alice = await server.signIn('alice');
    await bookChange(admin, '/api/public-project-book/intake', { number: 'P-2307', name: '公共简名', deadlineOn: '2027-12-31' });
    const scene = await scenario(server, alice).at('actions', { projectBook: 'as_is', erp: renamed });
    await scene.accept('start-erp-write');
    const after = await scene.settled();
    expect(after.confirmation.status).toBe('confirmed');
    const book = ProjectBookSchema.parse(await (await admin.request('/api/public-project-book')).json());
    expect(book.projects).toContainEqual(expect.objectContaining({ number: 'P-2307', name: canonical, deadlineOn: '2027-12-31' }));
    expect((await alice.post('/api/public-project-book/edit', { originalNumber: 'P-2307', number: 'P-2307', name: '任意人工修改' })).status).toBe(403);
  });
});
