import { PROJECT_BOOK_NOTES, ProjectBookResultSchema, ProjectBookSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from './test/api';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
let admin: TestClient;
let bob: TestClient;

beforeEach(async () => {
  server = await scenarioServer();
  admin = await server.signIn('admin');
  bob = await server.signIn('bob');
});
afterEach(() => server.close());

const asBob = api(() => bob);

async function intake(client: TestClient, path: '/api/project-book/intake' | '/api/public-project-book/intake', input: { number: string; name: string }) {
  const response = await client.post(path, input);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

// Hotel e-invoice + rail ticket inventoried (住宿 trio answered 确认没有), with the project book exactly as the test left it.
const INVENTORIED = { materials: ['m01', 'm07'], projectBook: 'as_is' } as const;

describe('offline public intake', () => {
  it('is administrator-only, while every signed-in member can read the complete public book', async () => {
    const forbidden = await bob.post('/api/public-project-book/intake', { number: 'PUB-2307', name: '共享项目' });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' }, book: { projects: [] } });

    const added = await intake(admin, '/api/public-project-book/intake', { number: 'PUB-2307', name: '共享项目' });
    expect(added).toMatchObject({
      status: 'admitted',
      verdict: null,
      book: { projects: [expect.objectContaining({ number: 'PUB-2307', name: '共享项目', expiresOn: null, lastCheckedAt: null, selectable: true })] },
    });
    const visible = ProjectBookSchema.parse(await (await bob.request('/api/public-project-book')).json());
    expect(visible.projects).toEqual([expect.objectContaining({ number: 'PUB-2307', name: '共享项目', selectable: true })]);
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects).toEqual([]);
  });

  it('keeps personal books independent, prompts for public conversion, and does not reveal the personal owner', async () => {
    expect((await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-7', name: 'Bob 私有项目' })).status).toBe('admitted');
    const other = await server.signIn('alice');
    expect((await intake(other, '/api/project-book/intake', { number: 'PERSONAL-7', name: 'Alice 私有项目' })).status).toBe('admitted');
    expect(await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-7', name: '重复名称' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('未重复加入') });

    const blockedPublic = await intake(admin, '/api/public-project-book/intake', { number: 'PERSONAL-7', name: '不应公开' });
    expect(blockedPublic).toMatchObject({ status: 'conversion_required', note: PROJECT_BOOK_NOTES.conversionRequired('PERSONAL-7') });
    expect(blockedPublic.note).not.toContain('bob');
    expect(blockedPublic.note).not.toContain('alice');

    expect((await intake(admin, '/api/public-project-book/intake', { number: 'PUBLIC-9', name: '公共项目' })).status).toBe('admitted');
    expect(await intake(bob, '/api/project-book/intake', { number: 'PUBLIC-9', name: '不应私有' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('公共项目簿') });
    expect(await intake(admin, '/api/public-project-book/intake', { number: 'PUBLIC-9', name: '重复公共项目' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('公共项目簿') });
  });

  it('serializes simultaneous cross-scope collision checks so only one admission wins', async () => {
    const [personal, shared] = await Promise.all([
      bob.post('/api/project-book/intake', { number: 'RACE-1', name: '个人竞态项目' }),
      admin.post('/api/public-project-book/intake', { number: 'RACE-1', name: '公共竞态项目' }),
    ]);
    const outcomes = await Promise.all([personal.json(), shared.json()]).then((bodies) => bodies.map((body) => ProjectBookResultSchema.parse(body)));
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['admitted', 'conversion_required']);

    const personalBook = ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json());
    const publicBook = ProjectBookSchema.parse(await (await bob.request('/api/public-project-book')).json());
    expect(personalBook.projects.some((project) => project.number === 'RACE-1')).not.toBe(publicBook.projects.some((project) => project.number === 'RACE-1'));
  });
});

describe('public availability', () => {
  it('refreshes an open member task so the newly admitted public entry is assignable', async () => {
    const start = (await scenario(server, bob).at('project', INVENTORIED)).reached;
    expect(start.step.kind).toBe('maintain_project_book');

    await intake(admin, '/api/public-project-book/intake', { number: 'PUB-OPEN', name: '打开任务也可用' });
    const refreshed = await asBob.current(start.task.taskId);
    expect(refreshed.step.kind).toBe('assign_projects');
    expect(refreshed.projectAssignment.projects).toEqual([{ number: 'PUB-OPEN', name: '打开任务也可用', source: 'public' }]);
  });

  it('uses the public source for a pre-existing legacy collision without deleting either append-only fact', async () => {
    const at = '2026-01-01T00:00:00Z';
    await server.db
      .insertInto('project_book_event')
      .values([
        {
          event_id: 'legacy-personal', seq: 1, scope: 'personal', owner_account_id: bob.account.accountId,
          number: 'LEGACY-1', action: 'admitted', name: '旧个人名称', verdict: null, expires_on: null,
          admission_source: null, actor_account_id: bob.account.accountId, created_at: at,
        },
        {
          event_id: 'legacy-public', seq: 2, scope: 'public', owner_account_id: null,
          number: 'LEGACY-1', action: 'admitted', name: '旧公共名称', verdict: null, expires_on: null,
          admission_source: null, actor_account_id: admin.account.accountId, created_at: at,
        },
      ])
      .execute();

    const start = (await scenario(server, bob).at('project', INVENTORIED)).reached;
    expect(start.projectAssignment.projects).toEqual([{ number: 'LEGACY-1', name: '旧公共名称', source: 'public' }]);
    expect(await server.db.selectFrom('project_book_event').select(['scope', 'number']).where('number', '=', 'LEGACY-1').orderBy('seq').execute()).toEqual([
      { scope: 'personal', number: 'LEGACY-1' },
      { scope: 'public', number: 'LEGACY-1' },
    ]);
  });

  it('does not silently reinterpret a personal draft as public when a legacy collision becomes visible', async () => {
    await intake(bob, '/api/project-book/intake', { number: 'PIVOT-1', name: '个人草稿名称' });
    const start = (await scenario(server, bob).at('project', INVENTORIED)).reached;
    const lineId = start.lines[0]?.lineId;
    if (!lineId) throw new Error('expected an inventoried line');
    await asBob.accepted(await asBob.act(start, 'assign-project-lines', { lineIds: [lineId], projectNumber: 'PIVOT-1', onlyUnassigned: false }));

    await server.db
      .insertInto('project_book_event')
      .values({
        event_id: 'legacy-public-pivot', seq: 2, scope: 'public', owner_account_id: null,
        number: 'PIVOT-1', action: 'admitted', name: '公共旧名称', verdict: null, expires_on: null,
        admission_source: null, actor_account_id: admin.account.accountId, created_at: '2026-01-01T00:00:00Z',
      })
      .execute();
    await intake(admin, '/api/public-project-book/intake', { number: 'REFRESH-1', name: '触发刷新' });

    const refreshed = await asBob.current(start.task.taskId);
    expect(refreshed.projectAssignment.projects).toEqual(expect.arrayContaining([{ number: 'PIVOT-1', name: '公共旧名称', source: 'public' }]));
    expect(refreshed.projectAssignment.working).toEqual([]);
    expect(refreshed.projectAssignment.reselect).toEqual([{ lineId, projectNumber: 'PIVOT-1', projectName: '个人草稿名称', projectSource: 'personal' }]);
  });
});
