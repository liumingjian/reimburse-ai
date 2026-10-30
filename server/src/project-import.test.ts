import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectBookSchema, ProjectImportResultSchema, ProjectImportWorkbookSchema, type ProjectImportPreview } from '@baox/contract';
import { createTestServer, type TestServer, type TestClient } from './test/harness';
import { bookChange } from './test/project-book';

const workbook = readFileSync(new URL('../../fixtures/generated/project-import.xlsx', import.meta.url));
let server: TestServer;
let admin: TestClient;
let member: TestClient;
beforeEach(async () => { server = await createTestServer(); admin = await server.signIn('admin'); member = await server.signIn('member'); });
afterEach(() => server.close());

async function preview(client: TestClient, scope = 'project-book'): Promise<ProjectImportPreview> {
  const body = new FormData();
  body.append('file', new File([workbook], 'projects.xlsx'));
  const response = await client.request(`/api/${scope}/import/preview`, { method: 'POST', body });
  expect(response.status).toBe(200);
  const parsed = ProjectImportWorkbookSchema.parse(await response.json());
  if (parsed.kind !== 'preview') throw new Error('expected a single-sheet preview');
  return parsed.preview;
}
const commit = (client: TestClient, input: ProjectImportPreview, rows = input.rows.filter(row => row.status === 'add').map(row => row.row), scope = 'project-book') => client.post(`/api/${scope}/import/commit`, { previewId: input.previewId, rows });
const book = async (client: TestClient, scope = 'project-book') => ProjectBookSchema.parse(await (await client.request(`/api/${scope}`)).json());

describe('project import over authenticated HTTP', () => {
  it('previews without writes, imports the two intended columns, skips repeats, and scopes previews to their owner', async () => {
    const pending = await preview(member);
    expect(pending.rows.map(row => [row.row, row.number, row.status])).toEqual([[2, '0001', 'add'], [3, '0002', 'add']]);
    expect((await book(member)).projects).toEqual([]);
    expect((await commit(admin, pending)).status).toBe(409);
    const response = await commit(member, pending);
    expect(response.status).toBe(200);
    expect(ProjectImportResultSchema.parse(await response.json())).toMatchObject({ added: 2, updated: 0, book: { projects: [
      { number: '0001', name: '客户甲-服务项目-26-0001', active: true },
      { number: '0002', name: '客户乙-维护项目-26-0002', active: true },
    ] } });
    expect((await preview(member)).rows.every(row => row.status === 'skip')).toBe(true);
    expect((await book(admin)).projects).toEqual([]);
  });

  it('updates only explicitly selected project numbers, preserving deadlines, inactive state and unselected values', async () => {
    await bookChange(member, '/api/project-book/intake', { number: '0001', name: '原值一', deadlineOn: '2027-01-01' });
    await bookChange(member, '/api/project-book/deactivate', { number: '0001' });
    await bookChange(member, '/api/project-book/intake', { number: '0002', name: '原值二' });
    const pending = await preview(member);
    expect(pending.rows.map(row => row.status)).toEqual(['update', 'update']);
    expect(pending.rows[0]?.previousName).toBe('原值一');
    expect((await commit(member, pending, [2])).status).toBe(200);
    const entries = (await book(member)).projects;
    expect(entries.find(entry => entry.number === '0001')).toMatchObject({ name: '客户甲-服务项目-26-0001', active: false, deadlineOn: '2027-01-01' });
    expect(entries.find(entry => entry.number === '0002')).toMatchObject({ name: '原值二' });
  });

  it('rejects a stale preview atomically but allows unrelated project changes', async () => {
    const stale = await preview(member);
    await bookChange(member, '/api/project-book/intake', { number: '0002', name: '另一个窗口新增' });
    expect((await commit(member, stale)).status).toBe(409);
    expect((await book(member)).projects.map(entry => entry.number)).toEqual(['0002']);
    const refreshed = await preview(member);
    await bookChange(member, '/api/project-book/intake', { number: 'UNRELATED', name: '无关项目' });
    expect((await commit(member, refreshed, [2])).status).toBe(200);
    expect((await commit(member, refreshed, [2])).status).toBe(409);
  });

  it('rolls back every row on a database failure and allows a clean retry', async () => {
    const pending = await preview(member);
    await sql`CREATE TRIGGER fail_import BEFORE INSERT ON project_book_event WHEN NEW.number = '0002' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`.execute(server.db);
    expect((await commit(member, pending)).status).toBe(500);
    expect((await book(member)).projects).toEqual([]);
    await sql`DROP TRIGGER fail_import`.execute(server.db);
    expect((await commit(member, pending)).status).toBe(200);
    expect((await book(member)).projects).toHaveLength(2);
  });

  it('enforces public maintenance permissions and both reservation directions without converting ownership', async () => {
    const shared = await preview(admin, 'public-project-book');
    expect((await member.post('/api/public-project-book/import/commit', { previewId: shared.previewId, rows: [2] })).status).toBe(403);
    expect((await commit(admin, shared, [2], 'public-project-book')).status).toBe(200);
    expect((await preview(member)).rows.map(row => row.status)).toEqual(['skip', 'add']);
    await bookChange(member, '/api/project-book/intake', { number: '0002', name: '私有项目' });
    const collisions = await preview(admin, 'public-project-book');
    expect(collisions.rows.map(row => row.status)).toEqual(['skip', 'skip']);
    expect(collisions.rows[1]?.note).toContain('转公共项目');
    const newPreview = await preview(admin, 'public-project-book');
    expect((await commit(admin, newPreview, [3], 'public-project-book')).status).toBe(400);
    expect((await book(member)).projects[0]?.name).toBe('私有项目');
  });

  it('rechecks public reservations after preview and invalidates older previews', async () => {
    const first = await preview(member);
    const second = await preview(member);
    expect((await commit(member, first)).status).toBe(409);
    await bookChange(admin, '/api/public-project-book/intake', { number: '0001', name: '新增公共项目' });
    expect((await commit(member, second)).status).toBe(409);
    expect((await book(member)).projects).toEqual([]);
  });

  it('accepts only one of two simultaneous confirmations of the same preview', async () => {
    const pending = await preview(member);
    const responses = await Promise.all([commit(member, pending), commit(member, pending)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await book(member)).projects).toHaveLength(2);
    expect(await server.db.selectFrom('project_book_event').selectAll().where('owner_account_id', '=', member.account.accountId).execute()).toHaveLength(2);
  });

  it('refuses expired previews and revoked public maintenance permission without writes', async () => {
    const expired = await preview(member);
    server.clock.advance(31 * 60_000);
    expect((await commit(member, expired)).status).toBe(409);
    const shared = await preview(admin, 'public-project-book');
    await server.db.updateTable('account').set({ role: 'user' }).where('account_id', '=', admin.account.accountId).execute();
    expect((await commit(admin, shared, [2], 'public-project-book')).status).toBe(403);
    expect((await book(member)).projects).toEqual([]);
    expect((await book(member, 'public-project-book')).projects).toEqual([]);
  });
});
