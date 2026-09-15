import { ProjectBookResultSchema, ProjectBookSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { api, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 14b (#194): the 公共项目簿 (public project book) through `app.request()` (ADR-0018). Admins edit it; removal
// deactivates; 任务选择 (task selection) offers public next to personal projects and pins the source; an entry
// deactivated before submission forces a re-select.

const CATALOG = fixtureCatalog([
  { number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false },
  { number: 'P-3312', name: '产品调研', audited: true, forbidden: false },
]);

let server: TestServer;
let admin: TestClient;
let bob: TestClient;
beforeEach(async () => {
  server = await createTestServer({ projectCatalog: CATALOG });
  admin = await server.signIn('admin');
  bob = await server.signIn('bob');
});
afterEach(() => server.close());
const asBob = api(() => bob);

const hotel = sample('m01');
// Hotel plus rail, so the task has two lines (a byte-different copy of one invoice is a 重复发票 since #187).
const rail = sample('m07');

async function publicBook(client: TestClient, path: string, body: unknown = {}) {
  const response = await client.post(`/api/public-project-book/${path}`, body);
  expect(response.status).toBe(200);
  return ProjectBookResultSchema.parse(await response.json());
}

async function refused(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

async function inventoried(): Promise<TaskSnapshot> {
  const { task } = await asBob.createTask('杭州');
  const uploaded = await asBob.upload(task.taskId, [hotel, rail]);
  await asBob.accepted(await asBob.act(uploaded, 'start-inventory'));
  return asBob.settled(task.taskId);
}

describe('editing the public book', () => {
  it('is for admins only; everyone signed in can read it', async () => {
    await refused(await bob.post('/api/public-project-book/intake', { number: 'P-2307' }), 403, 'forbidden');
    await refused(await bob.post('/api/public-project-book/remove', { number: 'P-2307' }), 403, 'forbidden');
    await refused(await bob.post('/api/public-project-book/recheck', {}), 403, 'forbidden');

    expect(await publicBook(admin, 'intake', { number: 'P-2307' })).toMatchObject({ status: 'admitted', note: expect.stringContaining('公共项目簿') });
    const read = ProjectBookSchema.parse(await (await bob.request('/api/public-project-book')).json());
    expect(read.projects).toEqual([expect.objectContaining({ number: 'P-2307', name: '华东客户交付', selectable: true })]);
    // The personal book is a different book.
    expect(ProjectBookSchema.parse(await (await admin.request('/api/project-book')).json()).projects).toEqual([]);
  });

  it('removal deactivates: the entry stays listed as 已停用 and a re-intake brings it back', async () => {
    await publicBook(admin, 'intake', { number: 'P-2307' });
    const removed = await publicBook(admin, 'remove', { number: 'P-2307' });
    expect(removed).toMatchObject({ status: 'removed', note: expect.stringContaining('停用') });
    expect(removed.book.projects).toEqual([expect.objectContaining({ number: 'P-2307', selectable: false, statusLabel: '已停用' })]);
    expect(await publicBook(admin, 'remove', { number: 'P-2307' })).toMatchObject({ status: 'not_found' });
    expect((await publicBook(admin, 'intake', { number: 'P-2307' })).book.projects).toEqual([expect.objectContaining({ number: 'P-2307', selectable: true })]);
  });
});

describe('task selection with the public book', () => {
  it('offers public projects next to personal ones; a personal entry of the same number wins', async () => {
    await publicBook(admin, 'intake', { number: 'P-2307' });
    await publicBook(admin, 'intake', { number: 'P-3312' });
    expect((await bob.post('/api/project-book/intake', { number: 'P-3312' })).status).toBe(200);
    const start = await inventoried();
    expect(start.step.kind).toBe('assign_projects');
    expect(start.projectAssignment.projects).toEqual([
      { number: 'P-3312', name: '产品调研', source: 'personal' },
      { number: 'P-2307', name: '华东客户交付', source: 'public' },
    ]);
  });

  it('an entry deactivated before submission forces a re-select; the submission pins the public source', async () => {
    await publicBook(admin, 'intake', { number: 'P-2307' });
    // Another project stays selectable, so the task stays at assignment (with none left it goes to the book gate).
    await publicBook(admin, 'intake', { number: 'P-3312' });
    const start = await inventoried();
    expect(start.step.kind).toBe('assign_projects');
    const lineIds = start.lines.map((line) => line.lineId);
    const assigned = await asBob.accepted(await asBob.act(start, 'assign-project-lines', { lineIds, projectNumber: 'P-2307', onlyUnassigned: false }));
    expect(assigned.projectAssignment.working.map((w) => w.projectSource)).toEqual(['public', 'public']);

    await publicBook(admin, 'remove', { number: 'P-2307' });
    const after = await asBob.current(start.task.taskId);
    expect(after.step.stepToken).not.toBe(assigned.step.stepToken);
    expect(after.projectAssignment.working).toEqual([]);
    expect(after.projectAssignment.reselect.map((r) => [r.lineId, r.projectNumber])).toEqual(lineIds.map((id) => [id, 'P-2307']));
    const projects = Object.fromEntries(lineIds.map((id) => [id, 'P-2307']));
    await refused(await asBob.act(after, 'submit-project-assignment', { purpose: '出差', projects }), 400, 'project_not_allowed');
    await refused(await asBob.act(after, 'assign-project-lines', { lineIds, projectNumber: 'P-2307', onlyUnassigned: false }), 400, 'project_not_selectable');

    const reassigned = await asBob.accepted(await asBob.act(after, 'assign-project-lines', { lineIds, projectNumber: 'P-3312', onlyUnassigned: false }));
    expect(reassigned.projectAssignment.reselect).toEqual([]);
    const submitted = await asBob.accepted(await asBob.act(reassigned, 'submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(lineIds.map((id) => [id, 'P-3312'])) }));
    expect(submitted.projectAssignment.status).toBe('submitted');
    expect(submitted.projectAssignment.assignments.map((a) => [a.projectNumber, a.projectName, a.projectSource])).toEqual([
      ['P-3312', '产品调研', 'public'],
      ['P-3312', '产品调研', 'public'],
    ]);

    // Deactivating after submission leaves the pinned selection alone.
    await publicBook(admin, 'remove', { number: 'P-3312' });
    const later = await asBob.current(start.task.taskId);
    expect(later.projectAssignment).toMatchObject({ status: 'submitted', reselect: [] });
    expect(later.lines.map((line) => line.projectCode)).toEqual(['P-3312', 'P-3312']);
  });
});
