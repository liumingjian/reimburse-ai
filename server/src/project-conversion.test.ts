import { ProjectBookSchema, type PublicProjectConversionInput } from '@baox/contract';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databasePath } from './data-dir';
import { createTestServer, tempDataDir, testClient, type TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { bookChange, INVENTORIED } from './test/project-book';

// Conversion stays at the authenticated HTTP seam: private books are only observed through their owners' public
// results, while the administrator receives no account or task details from a collision prompt.

let server: ScenarioServer;
let admin: TestClient;
let bob: TestClient;
let alice: TestClient;
let carol: TestClient;

beforeEach(async () => {
  server = await scenarioServer();
  admin = await server.signIn('admin');
  bob = await server.signIn('bob');
  alice = await server.signIn('alice');
  carol = await server.signIn('carol');
});
afterEach(() => server.close());

const change = bookChange;

const intake = (client: TestClient, scope: 'personal' | 'public', input: { number: string; name: string }) =>
  change(client, scope === 'personal' ? '/api/project-book/intake' : '/api/public-project-book/intake', input);

const edit = (client: TestClient, scope: 'personal' | 'public', input: { originalNumber: string; number: string; name: string }) =>
  change(client, scope === 'personal' ? '/api/project-book/edit' : '/api/public-project-book/edit', input);

const confirm = (client: TestClient, input: PublicProjectConversionInput) => change(client, '/api/public-project-book/convert', input);

// A task inventoried up to project assignment, with the owner's project book as the test entered it.
const atProject = (client: TestClient, materials: readonly string[] = INVENTORIED.materials) => scenario(server, client).at('project', { ...INVENTORIED, materials });

describe('public project conversion', () => {
  it('prompts without writes, then atomically converts active and inactive personal entries while refreshing drafts and preserving submitted pins', async () => {
    for (const client of [bob, alice, carol]) await intake(client, 'personal', { number: 'CONVERT-1', name: `${client.account.username} 的个人项目` });
    await change(carol, '/api/project-book/deactivate', { number: 'CONVERT-1' });

    const bobTask = await atProject(bob);
    const bobProjects = Object.fromEntries(bobTask.reached.lines.map((line) => [line.lineId, 'CONVERT-1']));
    const submitted = await bobTask.accept('submit-project-assignment', { purpose: '杭州出差', projects: bobProjects });
    expect(submitted.projectAssignment.assignments.every((assignment) => assignment.projectSource === 'personal' && assignment.projectName === 'bob 的个人项目')).toBe(true);

    const aliceTask = await atProject(alice, ['m03', 'm04']);
    const firstLine = aliceTask.reached.lines[0];
    if (!firstLine) throw new Error('expected an inventoried line');
    const drafted = await aliceTask.accept('assign-project-lines', { lineIds: [firstLine.lineId], projectNumber: 'CONVERT-1', onlyUnassigned: false });
    expect(drafted.projectAssignment.working).toEqual([expect.objectContaining({ lineId: firstLine.lineId, projectNumber: 'CONVERT-1', projectSource: 'personal' })]);

    const prompted = await intake(admin, 'public', { number: 'CONVERT-1', name: '全员共享项目' });
    expect(prompted).toMatchObject({ status: 'conversion_required', book: { projects: [] } });
    for (const client of [bob, alice, carol]) {
      const personal = ProjectBookSchema.parse(await (await client.request('/api/project-book')).json());
      expect(personal.projects).toEqual([expect.objectContaining({ number: 'CONVERT-1' })]);
    }

    const converted = await confirm(admin, { operation: 'intake', number: ' CONVERT-1 ', name: ' 全员共享项目 ' });
    expect(converted).toMatchObject({
      status: 'converted',
      book: { projects: [expect.objectContaining({ number: 'CONVERT-1', name: '全员共享项目', active: true, selectable: true })] },
    });
    for (const client of [bob, alice, carol]) {
      expect(ProjectBookSchema.parse(await (await client.request('/api/project-book')).json()).projects).toEqual([]);
    }
    // The per-owner conversion facts are not exposed: every personal book is empty either way, carol's inactive one too.
    const convertedOwners = await server.db.selectFrom('project_book_event').select('owner_account_id').where('maintenance_action', '=', 'converted').where('number', '=', 'CONVERT-1').execute();
    expect(new Set(convertedOwners.map(({ owner_account_id }) => owner_account_id))).toEqual(new Set([alice.account.accountId, bob.account.accountId, carol.account.accountId]));

    const afterSubmitted = await bobTask.snapshot();
    expect(afterSubmitted.projectAssignment.projects).toEqual([{ number: 'CONVERT-1', name: '全员共享项目', source: 'public' }]);
    expect(afterSubmitted.projectAssignment.assignments).toEqual(
      submitted.projectAssignment.assignments.map((assignment) => expect.objectContaining({ ...assignment, projectSource: 'personal', projectName: 'bob 的个人项目' })),
    );

    const afterDraft = await aliceTask.snapshot();
    expect(afterDraft.projectAssignment.projects).toEqual([{ number: 'CONVERT-1', name: '全员共享项目', source: 'public' }]);
    expect(afterDraft.projectAssignment.working).toEqual([]);
    expect(afterDraft.projectAssignment.reselect).toEqual([
      expect.objectContaining({ lineId: firstLine.lineId, projectNumber: 'CONVERT-1', projectName: 'alice 的个人项目', projectSource: 'personal' }),
    ]);
  });

  it('renumbers an inactive public entry only after confirmation, preserves inactivity, and serializes duplicate confirmation', async () => {
    await intake(bob, 'personal', { number: 'CONVERT-TARGET', name: 'Bob 的个人项目' });
    await intake(admin, 'public', { number: 'PUBLIC-OLD', name: '公共原项目' });
    await change(admin, '/api/public-project-book/deactivate', { number: 'PUBLIC-OLD' });

    const prompted = await edit(admin, 'public', { originalNumber: 'PUBLIC-OLD', number: 'CONVERT-TARGET', name: '公共新项目' });
    expect(prompted).toMatchObject({ status: 'conversion_required', book: { projects: [expect.objectContaining({ number: 'PUBLIC-OLD', active: false })] } });
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects).toEqual([expect.objectContaining({ number: 'CONVERT-TARGET', selectable: true })]);

    const request = {
      operation: 'edit' as const,
      originalNumber: 'PUBLIC-OLD',
      originalName: '公共原项目',
      originalActive: false,
      number: 'CONVERT-TARGET',
      name: '公共新项目',
    };
    const results = await Promise.all([confirm(admin, request), confirm(admin, request)]);
    expect(results.map((result) => result.status).sort()).toEqual(['converted', 'rejected']);
    const publicBook = ProjectBookSchema.parse(await (await admin.request('/api/public-project-book')).json());
    expect(publicBook.projects).toEqual([expect.objectContaining({ number: 'CONVERT-TARGET', name: '公共新项目', active: false, selectable: false })]);
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects).toEqual([]);
    expect(await change(bob, '/api/project-book/restore', { number: 'CONVERT-TARGET' })).toMatchObject({ status: 'rejected' });
  });

  it('revalidates stale and duplicate prompts and refuses direct member confirmation without exposing private owners', async () => {
    await intake(alice, 'personal', { number: 'STALE-TARGET', name: 'Alice 的个人项目' });
    const prompted = await intake(admin, 'public', { number: 'STALE-TARGET', name: '不应直接写入' });
    expect(prompted.status).toBe('conversion_required');
    await edit(alice, 'personal', { originalNumber: 'STALE-TARGET', number: 'STALE-MOVED', name: '已移走' });

    const stale = await confirm(admin, { operation: 'intake', number: 'STALE-TARGET', name: '不应直接写入' });
    expect(stale).toMatchObject({ status: 'rejected', note: expect.stringContaining('重新') });
    expect(ProjectBookSchema.parse(await (await admin.request('/api/public-project-book')).json()).projects).toEqual([]);

    const forbidden = await bob.post('/api/public-project-book/convert', { operation: 'intake', number: 'STALE-TARGET', name: '越权' });
    expect(forbidden.status).toBe(403);
    const forbiddenBody = JSON.stringify(await forbidden.json());
    expect(forbiddenBody).not.toContain(alice.account.accountId);
    expect(forbiddenBody).not.toContain(alice.account.username);

    await intake(alice, 'personal', { number: 'DUPLICATE-TARGET', name: '待转换个人项目' });
    await intake(admin, 'public', { number: 'PUBLIC-SOURCE', name: '公共原项目' });
    expect((await edit(admin, 'public', { originalNumber: 'PUBLIC-SOURCE', number: 'DUPLICATE-TARGET', name: '公共目标项目' })).status).toBe('conversion_required');
    expect((await alice.post('/api/reset', {})).status).toBe(200);
    expect((await intake(admin, 'public', { number: 'DUPLICATE-TARGET', name: '竞争公共项目' })).status).toBe('admitted');

    const duplicate = await confirm(admin, {
      operation: 'edit',
      originalNumber: 'PUBLIC-SOURCE',
      originalName: '公共原项目',
      originalActive: true,
      number: 'DUPLICATE-TARGET',
      name: '公共目标项目',
    });
    expect(duplicate).toMatchObject({ status: 'rejected', note: expect.stringContaining('公共项目簿') });
    expect(ProjectBookSchema.parse(await (await admin.request('/api/public-project-book')).json()).projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ number: 'PUBLIC-SOURCE', name: '公共原项目' }), expect.objectContaining({ number: 'DUPLICATE-TARGET', name: '竞争公共项目' })]),
    );
  });

  it('rolls back the public fact when a personal conversion fact fails', async () => {
    await intake(alice, 'personal', { number: 'ROLLBACK-1', name: 'Alice 的个人项目' });
    expect((await intake(admin, 'public', { number: 'ROLLBACK-1', name: '公共项目' })).status).toBe('conversion_required');
    await sql`CREATE TRIGGER fail_project_conversion BEFORE INSERT ON project_book_event WHEN NEW.maintenance_action = 'converted' BEGIN SELECT RAISE(ABORT, 'injected conversion failure'); END`.execute(server.db);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await admin.post('/api/public-project-book/convert', { operation: 'intake', number: 'ROLLBACK-1', name: '公共项目' });
      expect(failed.status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
    expect(ProjectBookSchema.parse(await (await admin.request('/api/public-project-book')).json()).projects).toEqual([]);
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects).toEqual([expect.objectContaining({ number: 'ROLLBACK-1', name: 'Alice 的个人项目' })]);
  });

  it('persists a completed conversion across a database restart', async () => {
    const dataDir = tempDataDir();
    const database = databasePath(dataDir);
    const first = await createTestServer({ database, dataDir });
    const owner = await first.signIn('restart-owner');
    try {
      await intake(owner, 'personal', { number: 'RESTART-CONVERT', name: '重启前个人项目' });
      expect((await intake(owner, 'public', { number: 'RESTART-CONVERT', name: '重启后公共项目' })).status).toBe('conversion_required');
      expect((await confirm(owner, { operation: 'intake', number: 'RESTART-CONVERT', name: '重启后公共项目' })).status).toBe('converted');
      await first.app.close();
      await first.db.destroy();

      const second = await createTestServer({ database, dataDir });
      try {
        const restored = testClient(second.app, owner.account, owner.cookie);
        expect(ProjectBookSchema.parse(await (await restored.request('/api/project-book')).json()).projects).toEqual([]);
        expect(ProjectBookSchema.parse(await (await restored.request('/api/public-project-book')).json()).projects).toEqual([
          expect.objectContaining({ number: 'RESTART-CONVERT', name: '重启后公共项目', active: true, selectable: true }),
        ]);
      } finally {
        await second.close();
      }
    } finally {
      await first.app.close().catch(() => undefined);
      await first.db.destroy().catch(() => undefined);
    }
  });
});
