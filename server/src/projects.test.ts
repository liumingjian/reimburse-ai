import { ProjectBookResultSchema, ProjectBookSchema, TaskListSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog, type ProjectCatalog } from './catalog/project-catalog';
import { api, sample, type Upload } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 09 (#188): 个人项目簿 (personal project book), 常驻城市 (home city) and 项目归属 (project assignment) through
// `app.request()`. The project catalog is the fixture-backed fake of the ERP query-service port (ADR-0008).

const CATALOG = fixtureCatalog([
  { number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false },
  { number: 'P-3312', name: '产品调研', audited: true, forbidden: false },
  { number: 'P-9001', name: '已停用项目', audited: true, forbidden: true },
]);

let server: TestServer;
let alice: TestClient;
async function boot(projectCatalog: ProjectCatalog = CATALOG) {
  server = await createTestServer({ projectCatalog });
  alice = await server.signIn('alice');
}
beforeEach(() => boot());
afterEach(() => server.close());
const client = api(() => alice);

// The hotel e-invoice plus a rail ticket, so the task has two lines. (A byte-different copy of the same invoice is a
// 重复发票 since #187 and blocks the inventory.)
const hotel = sample('m01');
const rail = sample('m07');

async function inventoried(files: readonly Upload[] = [hotel, rail], homeCity = '杭州'): Promise<TaskSnapshot> {
  const { task } = await client.createTask(homeCity);
  const uploaded = await client.upload(task.taskId, files);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  return client.settled(task.taskId);
}

async function book(path: string, body: unknown = {}) {
  const response = await alice.post(`/api/project-book/${path}`, body);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

async function refused(response: Response, code: string) {
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

describe('submit-project-assignment', () => {
  it('is refused until every line has a project and the purpose is filled', async () => {
    await book('intake', { number: 'P-2307' });
    const start = await client.current((await inventoried()).task.taskId);
    expect(start).toMatchObject({ stage: 'project', step: { kind: 'assign_projects' } });
    const [first, second] = start.lines;
    if (!first || !second) throw new Error('expected two lines');

    const one = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [first.lineId], projectNumber: 'P-2307', onlyUnassigned: false }));
    expect(one.projectAssignment.working).toEqual([{ lineId: first.lineId, projectNumber: 'P-2307', projectName: '华东客户交付', projectSource: 'personal' }]);

    await refused(await client.act(one, 'submit-project-assignment', { purpose: '杭州出差', projects: { [first.lineId]: 'P-2307' } }), 'incomplete');
    await refused(await client.act(one, 'submit-project-assignment', { purpose: '   ', projects: { [first.lineId]: 'P-2307', [second.lineId]: 'P-2307' } }), 'invalid_input');
    const still = await client.current(start.task.taskId);
    expect(still.projectAssignment.status).toBe('pending');

    const submitted = await client.accepted(await client.act(one, 'submit-project-assignment', { purpose: '杭州出差', projects: { [first.lineId]: 'P-2307', [second.lineId]: 'P-2307' } }));
    expect(submitted).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, projectAssignment: { status: 'submitted', purpose: '杭州出差' } });
    expect(submitted.lines.map((line) => [line.projectCode, line.projectName])).toEqual([
      ['P-2307', '华东客户交付'],
      ['P-2307', '华东客户交付'],
    ]);
  });

  it('refuses a project that is not selectable in the book, and a line that does not exist', async () => {
    await book('intake', { number: 'P-2307' });
    const start = await inventoried();
    const lineIds = start.lines.map((line) => line.lineId);
    await refused(await client.act(start, 'assign-project-lines', { lineIds, projectNumber: 'P-3312', onlyUnassigned: false }), 'project_not_selectable');
    await refused(await client.act(start, 'submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(lineIds.map((id) => [id, 'P-3312'])) }), 'project_not_allowed');
    await refused(await client.act(start, 'submit-project-assignment', { purpose: '出差', projects: { ...Object.fromEntries(lineIds.map((id) => [id, 'P-2307'])), 'line.nope': 'P-2307' } }), 'unknown_line');
  });

  it('assign with onlyUnassigned keeps lines that already have a project; without it, it overwrites', async () => {
    for (const number of ['P-2307', 'P-3312']) await book('intake', { number });
    const start = await inventoried();
    const [first, second] = start.lines.map((line) => line.lineId);
    const a = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [first], projectNumber: 'P-2307', onlyUnassigned: false }));
    const b = await client.accepted(await client.act(a, 'assign-project-lines', { lineIds: [first, second], projectNumber: 'P-3312', onlyUnassigned: true }));
    expect(b.projectAssignment.working.map((w) => w.projectNumber)).toEqual(['P-2307', 'P-3312']);
    expect(b.projectAssignment.usage).toEqual([
      { number: 'P-2307', name: '华东客户交付', lineCount: 1, grossTotal: start.lines[0]?.grossAmount, selectable: true },
      { number: 'P-3312', name: '产品调研', lineCount: 1, grossTotal: start.lines[1]?.grossAmount, selectable: true },
    ]);
    const c = await client.accepted(await client.act(b, 'assign-project-lines', { lineIds: [first, second], projectNumber: 'P-3312', onlyUnassigned: false }));
    expect(c.projectAssignment.working.map((w) => w.projectNumber)).toEqual(['P-3312', 'P-3312']);
  });

  // The assignment workbench prints 整单合计 before anything is submitted, so the whole-list total has to be on the
  // assignment view itself. It used to read `confirmation.grossTotal`, which stays null until there is a confirmable
  // whole list, and the workbench showed the unit with no amount.
  it('the assignment view carries the whole-list total from the moment the workbench opens', async () => {
    for (const number of ['P-2307']) await book('intake', { number });
    const start = await inventoried();
    const total = start.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0);
    expect(start.confirmation.grossTotal).toBeNull();
    expect(start.projectAssignment.grossTotal).toBe((total / 100).toFixed(2));
    // It is the whole list, not the assigned part: assigning one line does not change it.
    const one = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [start.lines[0]?.lineId ?? ''], projectNumber: 'P-2307', onlyUnassigned: false }));
    expect(one.projectAssignment.grossTotal).toBe((total / 100).toFixed(2));
    expect(one.projectAssignment.usage[0]?.grossTotal).toBe(start.lines[0]?.grossAmount);
  });

  it('an empty book sends a clean inventory to maintain_project_book; the first intake moves it to assign_projects', async () => {
    const start = await inventoried();
    expect(start).toMatchObject({ stage: 'project', step: { kind: 'maintain_project_book' } });
    await book('intake', { number: 'P-2307' });
    const after = await client.current(start.task.taskId);
    expect(after.step.kind).toBe('assign_projects');
    expect(after.step.stepToken).not.toBe(start.step.stepToken);
    expect(after.projectAssignment.projects).toEqual([{ number: 'P-2307', name: '华东客户交付', source: 'personal' }]);
  });
});

describe('the submitted selection is pinned', () => {
  it('editing the personal book after submit does not change the submitted selection', async () => {
    await book('intake', { number: 'P-2307' });
    const start = await inventoried();
    const projects = Object.fromEntries(start.lines.map((line) => [line.lineId, 'P-2307']));
    await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '杭州出差', projects }));

    await book('remove', { number: 'P-2307' });
    const after = await client.current(start.task.taskId);
    expect(after.projectAssignment).toMatchObject({ status: 'submitted', purpose: '杭州出差', projects: [] });
    expect(after.projectAssignment.assignments.map((a) => [a.projectNumber, a.projectName])).toEqual([
      ['P-2307', '华东客户交付'],
      ['P-2307', '华东客户交付'],
    ]);
    expect(after.lines.map((line) => line.projectCode)).toEqual(['P-2307', 'P-2307']);
    expect(after.projectAssignment.usage).toEqual([expect.objectContaining({ number: 'P-2307', selectable: false })]);

    // Re-submitting the same, now-removed project on the same lines is still accepted (the pin carries it).
    const again = await client.accepted(await client.act(after, 'submit-project-assignment', { purpose: '杭州出差（改）', projects }));
    expect(again.lines.map((line) => line.projectName)).toEqual(['华东客户交付', '华东客户交付']);
  });

  it('a later catalog rename does not reach the submitted names', async () => {
    const renamed = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);
    await server.close();
    await boot(renamed);
    await book('intake', { number: 'P-2307' });
    const start = await inventoried();
    const projects = Object.fromEntries(start.lines.map((line) => [line.lineId, 'P-2307']));
    await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '出差', projects }));
    renamed.replace([{ number: 'P-2307', name: '华东客户交付二期', audited: true, forbidden: false }]);
    expect((await book('recheck')).book.projects[0]?.name).toBe('华东客户交付二期');
    expect((await client.current(start.task.taskId)).lines.map((line) => line.projectName)).toEqual(['华东客户交付', '华东客户交付']);
  });
});

describe('home city', () => {
  it('is snapshotted per task, remembered per account as the next default, and editable on the current task', async () => {
    expect(TaskListSchema.parse(await (await alice.request('/api/tasks')).json()).homeCity).toBeNull();
    const start = await inventoried([hotel], '杭州');
    expect(start.task.homeCity).toBe('杭州');
    expect(TaskListSchema.parse(await (await alice.request('/api/tasks')).json()).homeCity).toEqual({ value: '杭州', source: 'remembered' });

    const edited = await client.accepted(await client.act(start, 'set-home-city', { homeCity: ' 上海 ' }));
    expect(edited.task.homeCity).toBe('上海');
    expect(edited.projectAssignment.homeCity).toBe('上海');
    expect(TaskListSchema.parse(await (await alice.request('/api/tasks')).json()).homeCity).toEqual({ value: '上海', source: 'remembered' });
    await refused(await client.act(edited, 'set-home-city', { homeCity: '这是一个超过二十个字的城市名称用来测试长度限制吗' }), 'invalid_home_city');

    // Another account remembers its own.
    const bob = await server.signIn('bob');
    expect(TaskListSchema.parse(await (await bob.request('/api/tasks')).json()).homeCity).toBeNull();
  });

  it('editing it after an ERP action attempt is refused', async () => {
    const start = await inventoried([hotel]);
    await server.db
      .insertInto('erp_attempt')
      .values({ attempt_id: 'a1', job_id: 'j1', task_id: start.task.taskId, action: 'import', preconditions: '{}', expected_postconditions: '{}', erp_build: 'b', form_id: 'f', erp_account: 'x', erp_tenant: 't', erp_display_name: 'n', started_at: '2026-09-15T00:00:00Z' })
      .execute();
    await refused(await client.act(start, 'set-home-city', { homeCity: '上海' }), 'home_city_locked');
    expect((await client.current(start.task.taskId)).task.homeCity).toBe('杭州');
  });

  it('re-derives city transport categories: an invoice with no expense city blocks instead of borrowing the home city', async () => {
    const snapshot = await inventoried([sample('m03')]);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.pendingItems).toEqual([expect.objectContaining({ itemId: `category_city_missing.${snapshot.materials[0]?.materialId}`, kind: 'choice' })]);
    expect(snapshot.stage).toBe('pending');
  });
});

describe('the personal book', () => {
  it('intake takes the name from the catalog and rejects missing, unusable and unsafe numbers', async () => {
    expect((await book('intake', { number: 'P-2307' })).book.projects).toEqual([
      expect.objectContaining({ number: 'P-2307', name: '华东客户交付', selectable: true, statusLabel: '可选' }),
    ]);
    expect(await book('intake', { number: 'P-0000' })).toMatchObject({ status: 'rejected', verdict: 'missing' });
    expect(await book('intake', { number: 'P-9001' })).toMatchObject({ status: 'rejected', verdict: 'unusable' });
    expect(await book('intake', { number: 'P-12;' })).toMatchObject({ status: 'rejected', verdict: 'unsafe' });
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects.map((p) => p.number)).toEqual(['P-2307']);
  });

  it('recheck marks a project that went unusable; purge removes it; remove removes one', async () => {
    const live = fixtureCatalog([
      { number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false },
      { number: 'P-3312', name: '产品调研', audited: true, forbidden: false },
    ]);
    await server.close();
    await boot(live);
    for (const number of ['P-2307', 'P-3312']) await book('intake', { number });
    live.replace([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: true }]);
    const rechecked = await book('recheck');
    expect(rechecked).toMatchObject({ status: 'done' });
    expect(rechecked.book.projects.map((p) => [p.number, p.selectable])).toEqual([
      ['P-2307', false],
      ['P-3312', false],
    ]);
    expect(await book('purge')).toMatchObject({ status: 'purged', book: { projects: [] } });
    expect(await book('purge')).toMatchObject({ status: 'none' });
    expect(await book('remove', { number: 'P-2307' })).toMatchObject({ status: 'not_found' });
  });

  it('without a reachable catalog, intake changes nothing and says why', async () => {
    await server.close();
    await boot(fixtureCatalog([], { unavailable: true }));
    expect(await book('intake', { number: 'P-2307' })).toMatchObject({ status: 'not_logged_in', book: { projects: [] } });
  });

  it('is per account, and resetAll clears this account’s book and home city only', async () => {
    await book('intake', { number: 'P-2307' });
    await inventoried([hotel], '杭州');
    const bob = await server.signIn('bob');
    await bob.post('/api/project-book/intake', { number: 'P-3312' });
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects.map((p) => p.number)).toEqual(['P-3312']);

    const reset = TaskListSchema.parse(await (await alice.post('/api/reset', {})).json());
    expect(reset).toEqual({ homeCity: null, tasks: [] });
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects).toEqual([]);
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects.map((p) => p.number)).toEqual(['P-3312']);
  });
});
