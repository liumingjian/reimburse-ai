import { ProjectBookResultSchema, ProjectBookSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath } from './data-dir';
import { api, sample } from './test/api';
import { createTestServer, tempDataDir, testClient, type TestClient, type TestServer } from './test/harness';

// Project edits run through the same authenticated HTTP seam as intake. These checks keep the original identity,
// scoped collision rules, append-only facts, and assignment refresh observable without depending on lifecycle #219.

let server: TestServer;
let admin: TestClient;
let bob: TestClient;
let alice: TestClient;

beforeEach(async () => {
  server = await createTestServer();
  admin = await server.signIn('admin');
  bob = await server.signIn('bob');
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

const asBob = api(() => bob);

async function intake(client: TestClient, path: '/api/project-book/intake' | '/api/public-project-book/intake', input: { number: string; name: string }) {
  const response = await client.post(path, input);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

async function edit(client: TestClient, path: '/api/project-book/edit' | '/api/public-project-book/edit', input: { originalNumber: string; number: string; name: string }) {
  const response = await client.post(path, input);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

async function inventoried(): Promise<TaskSnapshot> {
  const { task } = await asBob.createTask('杭州');
  const uploaded = await asBob.upload(task.taskId, [sample('m01'), sample('m07')]);
  await asBob.accepted(await asBob.act(uploaded, 'start-inventory'));
  return asBob.withoutStayGaps(await asBob.settled(task.taskId));
}

describe('project-book edits', () => {
  it('renumbers a personal entry as an append-only fact, refreshes new choices, and leaves a submitted pin intact', async () => {
    await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-OLD', name: '原个人名称' });
    const start = await inventoried();
    const projects = Object.fromEntries(start.lines.map((line) => [line.lineId, 'PERSONAL-OLD']));
    const submitted = await asBob.accepted(await asBob.act(start, 'submit-project-assignment', { purpose: '杭州出差', projects }));
    expect(submitted.projectAssignment.assignments.map((item) => [item.projectNumber, item.projectName, item.projectSource])).toEqual(
      start.lines.map(() => ['PERSONAL-OLD', '原个人名称', 'personal']),
    );

    const changed = await edit(bob, '/api/project-book/edit', { originalNumber: ' PERSONAL-OLD ', number: ' PERSONAL-NEW ', name: ' 更正后的名称 ' });
    expect(changed).toMatchObject({
      status: 'edited',
      book: { projects: [expect.objectContaining({ number: 'PERSONAL-NEW', name: '更正后的名称', selectable: true, lastCheckedAt: null })] },
    });

    const refreshed = await asBob.current(start.task.taskId);
    expect(refreshed.projectAssignment.projects).toEqual([{ number: 'PERSONAL-NEW', name: '更正后的名称', source: 'personal' }]);
    expect(refreshed.projectAssignment.assignments.map((item) => [item.projectNumber, item.projectName, item.projectSource])).toEqual(
      start.lines.map(() => ['PERSONAL-OLD', '原个人名称', 'personal']),
    );
    expect(refreshed.lines.map((line) => [line.projectCode, line.projectName])).toEqual(start.lines.map(() => ['PERSONAL-OLD', '原个人名称']));
    expect(await server.db.selectFrom('project_book_event').select(['action', 'maintenance_action', 'previous_number', 'number', 'name']).where('owner_account_id', '=', bob.account.accountId).orderBy('seq').execute()).toEqual([
      { action: 'admitted', maintenance_action: null, previous_number: null, number: 'PERSONAL-OLD', name: '原个人名称' },
      { action: 'checked', maintenance_action: 'edited', previous_number: 'PERSONAL-OLD', number: 'PERSONAL-NEW', name: '更正后的名称' },
    ]);
  });

  it('rejects invalid, missing, duplicate, and public-reserved personal edits without changing the original entry', async () => {
    await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-A', name: '原名称' });
    await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-B', name: '另一项目' });
    await intake(admin, '/api/public-project-book/intake', { number: 'PUBLIC-RESERVED', name: '公共项目' });

    expect(await edit(bob, '/api/project-book/edit', { originalNumber: 'PERSONAL-A', number: 'P-12;', name: '非法号码' })).toMatchObject({ status: 'rejected', verdict: 'unsafe' });
    expect(await edit(bob, '/api/project-book/edit', { originalNumber: 'MISSING', number: 'PERSONAL-C', name: '不存在' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('未记录') });
    expect(await edit(bob, '/api/project-book/edit', { originalNumber: 'PERSONAL-A', number: 'PERSONAL-B', name: '重复' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('无法改为') });
    expect(await edit(bob, '/api/project-book/edit', { originalNumber: 'PERSONAL-A', number: 'PUBLIC-RESERVED', name: '冲突' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('公共项目簿') });

    const malformed = await bob.post('/api/project-book/edit', { number: 'PERSONAL-C', name: '缺少原身份' });
    expect(malformed.status).toBe(400);
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects.map((project) => [project.number, project.name])).toEqual([
      ['PERSONAL-A', '原名称'],
      ['PERSONAL-B', '另一项目'],
    ]);
    expect(await server.db.selectFrom('project_book_event').select('maintenance_action').where('owner_account_id', '=', bob.account.accountId).execute()).toEqual([{ maintenance_action: null }, { maintenance_action: null }]);
  });

  it('scopes personal edits to their owner and public edits to administrators, while prompting a public renumber into a personal collision', async () => {
    await intake(alice, '/api/project-book/intake', { number: 'ALICE-ONLY', name: 'Alice 私有项目' });
    await intake(admin, '/api/public-project-book/intake', { number: 'PUBLIC-OLD', name: '公共原名称' });

    const foreign = await edit(bob, '/api/project-book/edit', { originalNumber: 'ALICE-ONLY', number: 'BOB-NEW', name: '不应写入' });
    expect(foreign).toMatchObject({ status: 'rejected', note: expect.stringContaining('未记录') });
    const forbidden = await bob.post('/api/public-project-book/edit', { originalNumber: 'PUBLIC-OLD', number: 'PUBLIC-NEW', name: '越权' });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });

    const collision = await edit(admin, '/api/public-project-book/edit', { originalNumber: 'PUBLIC-OLD', number: 'ALICE-ONLY', name: '不应公开' });
    expect(collision).toMatchObject({ status: 'conversion_required', note: expect.stringContaining('个人项目簿') });
    const renamed = await edit(admin, '/api/public-project-book/edit', { originalNumber: 'PUBLIC-OLD', number: 'PUBLIC-OLD', name: '公共新名称' });
    expect(renamed).toMatchObject({ status: 'edited', book: { projects: [expect.objectContaining({ number: 'PUBLIC-OLD', name: '公共新名称' })] } });
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects).toEqual([expect.objectContaining({ number: 'ALICE-ONLY', name: 'Alice 私有项目' })]);
  });

  it('serializes concurrent personal and public renumbers so one target number cannot exist in both books', async () => {
    await intake(bob, '/api/project-book/intake', { number: 'PERSONAL-SOURCE', name: '个人原项目' });
    await intake(admin, '/api/public-project-book/intake', { number: 'PUBLIC-SOURCE', name: '公共原项目' });

    const [personal, shared] = await Promise.all([
      edit(bob, '/api/project-book/edit', { originalNumber: 'PERSONAL-SOURCE', number: 'RACE-TARGET', name: '个人竞争项目' }),
      edit(admin, '/api/public-project-book/edit', { originalNumber: 'PUBLIC-SOURCE', number: 'RACE-TARGET', name: '公共竞争项目' }),
    ]);
    expect([personal.status, shared.status].sort()).toEqual(['conversion_required', 'edited']);
    const personalBook = ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json());
    const publicBook = ProjectBookSchema.parse(await (await bob.request('/api/public-project-book')).json());
    expect(personalBook.projects.some((project) => project.number === 'RACE-TARGET')).not.toBe(publicBook.projects.some((project) => project.number === 'RACE-TARGET'));
  });

  it('persists an edited identity after reopening the SQLite database', async () => {
    const dataDir = tempDataDir();
    const database = databasePath(dataDir);
    const first = await createTestServer({ database, dataDir });
    const owner = await first.signIn('restart-owner');
    try {
      await intake(owner, '/api/project-book/intake', { number: 'RESTART-OLD', name: '重启前名称' });
      expect((await edit(owner, '/api/project-book/edit', { originalNumber: 'RESTART-OLD', number: 'RESTART-NEW', name: '重启后名称' })).status).toBe('edited');
      await first.app.close();
      await first.db.destroy();

      const second = await createTestServer({ database, dataDir });
      try {
        const restored = ProjectBookSchema.parse(await (await testClient(second.app, owner.account, owner.cookie).request('/api/project-book')).json());
        expect(restored.projects).toEqual([expect.objectContaining({ number: 'RESTART-NEW', name: '重启后名称', selectable: true, lastCheckedAt: null })]);
      } finally {
        await second.close();
      }
    } finally {
      // The second server removes the temporary directory when it starts successfully. If the first phase throws,
      // close it with the normal harness cleanup instead.
      await first.app.close().catch(() => undefined);
      await first.db.destroy().catch(() => undefined);
    }
  });
});
