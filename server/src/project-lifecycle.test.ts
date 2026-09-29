import { ProjectBookResultSchema, ProjectBookSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { databasePath } from './data-dir';
import { api } from './test/api';
import { createTestServer, tempDataDir, testClient, type TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { bookChange, INVENTORIED } from './test/project-book';

// Lifecycle facts use the same authenticated HTTP boundary as intake. The fixture starts with an administrator and a
// regular member so public authorization is exercised without exposing another member's data.

let server: ScenarioServer;
let admin: TestClient;
let member: TestClient;

const CATALOG = fixtureCatalog([{ number: 'TASK-LIFE', name: '任务生命周期项目', audited: true, forbidden: false }]);

beforeEach(async () => {
  server = await scenarioServer({ projectCatalog: CATALOG });
  admin = await server.signIn('admin');
  member = await server.signIn('member');
});

afterEach(async () => {
  await server.close();
});

const book = (client: TestClient, path: string, input: { number: string; name?: string }) => bookChange(client, path, input);

const memberApi = api(() => member);

describe('personal project lifecycle', () => {
  it('keeps the entry, rejects duplicate intake, and appends distinct deactivation and restoration facts', async () => {
    expect((await book(member, '/api/project-book/intake', { number: 'LIFE-1', name: '生命周期项目' })).status).toBe('admitted');

    const deactivated = await book(member, '/api/project-book/deactivate', { number: 'LIFE-1' });
    expect(deactivated).toMatchObject({
      status: 'deactivated',
      book: { projects: [expect.objectContaining({ number: 'LIFE-1', name: '生命周期项目', active: false, selectable: false, statusLabel: '已停用' })] },
    });

    const duplicate = await book(member, '/api/project-book/intake', { number: 'LIFE-1', name: '不应覆盖' });
    expect(duplicate).toMatchObject({ status: 'rejected', book: { projects: [expect.objectContaining({ name: '生命周期项目', active: false })] } });

    const [first, second] = await Promise.all([
      member.post('/api/project-book/restore', { number: 'LIFE-1' }),
      member.post('/api/project-book/restore', { number: 'LIFE-1' }),
    ]);
    const restored = await Promise.all([first.json(), second.json()]).then((bodies) => bodies.map((body) => ProjectBookResultSchema.parse(body)));
    expect(restored.map((result) => result.status).sort()).toEqual(['rejected', 'restored']);
    expect(restored.find((result) => result.status === 'restored')).toMatchObject({
      book: { projects: [expect.objectContaining({ number: 'LIFE-1', name: '生命周期项目', active: true, selectable: true })] },
    });

    expect(
      await server.db.selectFrom('project_book_event').select(['action', 'maintenance_action']).where('number', '=', 'LIFE-1').orderBy('seq').execute(),
    ).toEqual([
      { action: 'admitted', maintenance_action: null },
      { action: 'removed', maintenance_action: 'deactivated' },
      { action: 'admitted', maintenance_action: 'restored' },
    ]);
  });

  it('deletes an inactive personal entry, scopes the action, and permits reintake', async () => {
    await book(member, '/api/project-book/intake', { number: 'DELETE-1', name: '待删除项目' });
    expect(await book(admin, '/api/project-book/delete', { number: 'DELETE-1' })).toMatchObject({ status: 'rejected', book: { projects: [] } });
    await book(member, '/api/project-book/deactivate', { number: 'DELETE-1' });

    const responses = await Promise.all([
      member.post('/api/project-book/delete', { number: 'DELETE-1' }),
      member.post('/api/project-book/delete', { number: 'DELETE-1' }),
    ]);
    const results = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      return ProjectBookResultSchema.parse(await response.json());
    }));
    expect(results.map((result) => result.status).sort()).toEqual(['deleted', 'rejected']);
    expect(results.find((result) => result.status === 'deleted')).toMatchObject({ book: { projects: [] } });

    expect(
      await server.db.selectFrom('project_book_event').select(['action', 'maintenance_action']).where('number', '=', 'DELETE-1').orderBy('seq').execute(),
    ).toEqual([
      { action: 'admitted', maintenance_action: null },
      { action: 'removed', maintenance_action: 'deactivated' },
      { action: 'removed', maintenance_action: null },
    ]);

    expect(await book(member, '/api/project-book/intake', { number: 'DELETE-1', name: '重新录入项目' })).toMatchObject({
      status: 'admitted',
      book: { projects: [expect.objectContaining({ number: 'DELETE-1', name: '重新录入项目', active: true, selectable: true })] },
    });
  });

  it.each(['deactivate', 'delete'] as const)('refreshes open assignment work, refuses fresh inactive assignments, and preserves submitted pins after %s', async (action) => {
    await book(member, '/api/project-book/intake', { number: 'TASK-LIFE', name: '任务生命周期项目' });
    const start = (await scenario(server, member).at('project', INVENTORIED)).reached;
    const [first] = start.lines;
    if (!first) throw new Error('expected an inventoried line');

    const drafted = await memberApi.accepted(
      await memberApi.act(start, 'assign-project-lines', { lineIds: [first.lineId], projectNumber: 'TASK-LIFE', onlyUnassigned: false }),
    );
    expect(drafted.projectAssignment.working).toEqual([expect.objectContaining({ lineId: first.lineId, projectNumber: 'TASK-LIFE', projectSource: 'personal' })]);

    await book(member, '/api/project-book/deactivate', { number: 'TASK-LIFE' });
    const inactive = await memberApi.current(start.task.taskId);
    expect(inactive.projectAssignment.projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ number: 'TASK-LIFE' })]));
    expect(inactive.projectAssignment.working).toEqual([]);
    expect(inactive.projectAssignment.reselect).toEqual([expect.objectContaining({ lineId: first.lineId, projectNumber: 'TASK-LIFE', projectName: '任务生命周期项目', projectSource: 'personal' })]);

    const refused = await memberApi.act(inactive, 'assign-project-lines', { lineIds: [first.lineId], projectNumber: 'TASK-LIFE', onlyUnassigned: false });
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'not_ready' } });

    await book(member, '/api/project-book/restore', { number: 'TASK-LIFE' });
    const revived = await memberApi.current(start.task.taskId);
    expect(revived.projectAssignment.working).toEqual([expect.objectContaining({ lineId: first.lineId, projectNumber: 'TASK-LIFE' })]);

    const projects = Object.fromEntries(revived.lines.map((line) => [line.lineId, 'TASK-LIFE']));
    const submitted = await memberApi.accepted(await memberApi.act(revived, 'submit-project-assignment', { purpose: '杭州出差', projects }));
    expect(submitted.projectAssignment.status).toBe('submitted');

    expect((await book(member, `/api/project-book/${action}`, { number: 'TASK-LIFE' })).status).toBe(action === 'delete' ? 'deleted' : 'deactivated');
    const after = await memberApi.current(start.task.taskId);
    expect(after.projectAssignment.projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ number: 'TASK-LIFE' })]));
    expect(after.projectAssignment.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ lineId: first.lineId, projectNumber: 'TASK-LIFE', projectName: '任务生命周期项目', projectSource: 'personal' })]),
    );
    expect(after.lines.every((line) => line.projectCode === 'TASK-LIFE' && line.projectName === '任务生命周期项目')).toBe(true);
  });
});

describe('public project lifecycle', () => {
  it('enforces administrator authority while inactive public entries continue to reserve their number', async () => {
    await book(admin, '/api/public-project-book/intake', { number: 'PUBLIC-LIFE', name: '公共生命周期项目' });

    const forbidden = await member.post('/api/public-project-book/deactivate', { number: 'PUBLIC-LIFE' });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as { error: { code: string }; book: { projects: { active: boolean }[] } }).toMatchObject({
      error: { code: 'forbidden' },
      book: { projects: [expect.objectContaining({ active: true })] },
    });

    const deactivated = await book(admin, '/api/public-project-book/deactivate', { number: 'PUBLIC-LIFE' });
    expect(deactivated).toMatchObject({ status: 'deactivated', book: { projects: [expect.objectContaining({ active: false, selectable: false })] } });
    expect(await book(member, '/api/project-book/intake', { number: 'PUBLIC-LIFE', name: '不应成为私人项目' })).toMatchObject({
      status: 'rejected',
      note: expect.stringContaining('公共项目簿'),
    });

    const restored = await book(admin, '/api/public-project-book/restore', { number: 'PUBLIC-LIFE' });
    expect(restored).toMatchObject({ status: 'restored', book: { projects: [expect.objectContaining({ active: true, selectable: true })] } });
  });

  it('shows a legacy public reservation on the personal entry and rejects restoring into it without appending a fact', async () => {
    const at = '2026-01-01T00:00:00Z';
    await server.db
      .insertInto('project_book_event')
      .values([
        {
          event_id: 'legacy-personal-admitted', seq: 1, scope: 'personal', owner_account_id: member.account.accountId,
          number: 'LEGACY-RESTORE', action: 'admitted', name: '旧个人项目', verdict: null, expires_on: null,
          admission_source: 'manual', maintenance_action: null, actor_account_id: member.account.accountId, created_at: at,
        },
        {
          event_id: 'legacy-personal-deactivated', seq: 2, scope: 'personal', owner_account_id: member.account.accountId,
          number: 'LEGACY-RESTORE', action: 'removed', name: null, verdict: null, expires_on: null,
          admission_source: null, maintenance_action: 'deactivated', actor_account_id: member.account.accountId, created_at: at,
        },
        {
          event_id: 'legacy-public-admitted', seq: 3, scope: 'public', owner_account_id: null,
          number: 'LEGACY-RESTORE', action: 'admitted', name: '旧公共项目', verdict: null, expires_on: null,
          admission_source: 'manual', maintenance_action: null, actor_account_id: admin.account.accountId, created_at: at,
        },
      ])
      .execute();

    const personal = ProjectBookSchema.parse(await (await member.request('/api/project-book')).json());
    expect(personal.projects).toEqual([
      expect.objectContaining({ number: 'LEGACY-RESTORE', active: false, selectable: false, statusLabel: '已停用・公共项目已保留', statusNote: expect.stringContaining('公共项目簿') }),
    ]);

    const refused = await book(member, '/api/project-book/restore', { number: 'LEGACY-RESTORE' });
    expect(refused).toMatchObject({ status: 'rejected', note: expect.stringContaining('公共项目簿') });
    expect(
      await server.db.selectFrom('project_book_event').select('event_id').where('number', '=', 'LEGACY-RESTORE').orderBy('seq').execute(),
    ).toHaveLength(3);
  });
});

describe('lifecycle persistence', () => {
  it('retains an inactive entry after reopening the database', async () => {
    const dataDir = tempDataDir();
    const database = databasePath(dataDir);
    const first = await createTestServer({ database, dataDir });
    const owner = await first.signIn('restart-owner');
    try {
      await book(owner, '/api/project-book/intake', { number: 'RESTART-LIFE', name: '重启后仍停用' });
      await book(owner, '/api/project-book/deactivate', { number: 'RESTART-LIFE' });
      await book(owner, '/api/public-project-book/intake', { number: 'RESTART-DELETE', name: '重启后保持删除' });
      await book(owner, '/api/public-project-book/delete', { number: 'RESTART-DELETE' });
      await first.app.close();
      await first.db.destroy();

      const second = await createTestServer({ database, dataDir });
      try {
        const restored = ProjectBookSchema.parse(await (await testClient(second.app, owner.account, owner.cookie).request('/api/project-book')).json());
        expect(restored.projects).toEqual([expect.objectContaining({ number: 'RESTART-LIFE', name: '重启后仍停用', active: false, selectable: false, statusLabel: '已停用' })]);
        const publicBook = ProjectBookSchema.parse(await (await testClient(second.app, owner.account, owner.cookie).request('/api/public-project-book')).json());
        expect(publicBook.projects).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      // The first process was explicitly closed above. The catch path still releases its resources if setup failed.
      await first.app.close().catch(() => undefined);
      await first.db.destroy().catch(() => undefined);
    }
  });
});


describe('public project deletion', () => {
  it.each([true, false])('requires an administrator, releases the number, and records explicit deletion (active=%s)', async (active) => {
    await book(admin, '/api/public-project-book/intake', { number: 'PUBLIC-DELETE', name: '待删除公共项目' });
    if (!active) await book(admin, '/api/public-project-book/deactivate', { number: 'PUBLIC-DELETE' });
    expect((await member.post('/api/public-project-book/delete', { number: 'PUBLIC-DELETE' })).status).toBe(403);
    expect((await book(admin, '/api/public-project-book/delete', { number: 'PUBLIC-DELETE' })).status).toBe('deleted');
    expect(ProjectBookSchema.parse(await (await member.request('/api/public-project-book')).json()).projects).toEqual([]);
    const event = await server.db.selectFrom('project_book_event').select(['action', 'maintenance_action']).where('number', '=', 'PUBLIC-DELETE').orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(event).toEqual({ action: 'removed', maintenance_action: 'deleted' });
    expect((await book(admin, '/api/public-project-book/restore', { number: 'PUBLIC-DELETE' })).status).toBe('rejected');
    expect((await book(member, '/api/project-book/intake', { number: 'PUBLIC-DELETE', name: '重新使用项目号' })).status).toBe('admitted');
  });

  it.each([false, true])('refreshes member task options and preserves submitted history (submitted=%s)', async (submitted) => {
    await book(admin, '/api/public-project-book/intake', { number: 'TASK-LIFE', name: '公共历史名称' });
    const start = (await scenario(server, member).at('project', INVENTORIED)).reached;
    const first = start.lines[0]!;
    const drafted = await memberApi.accepted(await memberApi.act(start, 'assign-project-lines', { lineIds: [first.lineId], projectNumber: 'TASK-LIFE', onlyUnassigned: false }));
    if (submitted) await memberApi.accepted(await memberApi.act(drafted, 'submit-project-assignment', { purpose: '杭州出差', projects: Object.fromEntries(drafted.lines.map((line) => [line.lineId, 'TASK-LIFE'])) }));
    await book(admin, '/api/public-project-book/delete', { number: 'TASK-LIFE' });
    const after = await memberApi.current(start.task.taskId);
    expect(after.projectAssignment.projects).toEqual([]);
    if (submitted) {
      expect(after.projectAssignment.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ projectNumber: 'TASK-LIFE', projectName: '公共历史名称', projectSource: 'public' })]));
    } else {
      expect(after.projectAssignment.working).toEqual([]);
      expect(after.projectAssignment.reselect).toEqual(expect.arrayContaining([expect.objectContaining({ lineId: first.lineId, projectNumber: 'TASK-LIFE' })]));
    }
  });
});
