import { ProjectBookResultSchema, ProjectBookSchema, TaskListSchema, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath } from './data-dir';
import { api } from './test/api';
import { createTestServer, tempDataDir, testClient, type TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Personal project intake, home city, and project assignment through `app.request()`. Project-book intake is local:
// no ERP catalog is consulted for admission.

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => alice);

// A task inventoried up to `stage` (the hotel e-invoice plus a rail ticket by default, so it has two lines), with the
// project book as the test entered it: these tests are about the book, so the builder's own projects stay out of it.
async function taskAt(stage: 'project' | 'pending' = 'project', materials: readonly string[] = ['m01', 'm07'], homeCity = '杭州'): Promise<TaskSnapshot> {
  return (await scenario(server, alice).at(stage, { materials, homeCity, projectBook: 'as_is', stayTrio: 'answered' })).reached;
}

async function book(path: string, body: unknown = {}) {
  if (path !== 'intake') throw new Error(`unsupported project-book action: ${path}`);
  const input = body as { number?: string; name?: string; deadlineOn?: string | null };
  const names: Readonly<Record<string, string>> = {
    'P-2307': '华东客户交付',
    'P-3312': '产品调研',
    'P-9001': '已停用项目',
  };
  const response = await alice.post('/api/project-book/intake', { number: input.number ?? '', name: input.name ?? names[input.number ?? ''] ?? '本地项目', ...(input.deadlineOn === undefined ? {} : { deadlineOn: input.deadlineOn }) });
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
    const start = await client.current((await taskAt()).task.taskId);
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
    const start = await taskAt();
    const lineIds = start.lines.map((line) => line.lineId);
    await refused(await client.act(start, 'assign-project-lines', { lineIds, projectNumber: 'P-3312', onlyUnassigned: false }), 'project_not_selectable');
    await refused(await client.act(start, 'submit-project-assignment', { purpose: '出差', projects: Object.fromEntries(lineIds.map((id) => [id, 'P-3312'])) }), 'project_not_allowed');
    await refused(await client.act(start, 'submit-project-assignment', { purpose: '出差', projects: { ...Object.fromEntries(lineIds.map((id) => [id, 'P-2307'])), 'line.nope': 'P-2307' } }), 'unknown_line');
  });

  it('assign with onlyUnassigned keeps lines that already have a project; without it, it overwrites', async () => {
    for (const number of ['P-2307', 'P-3312']) await book('intake', { number });
    const start = await taskAt();
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
    const start = await taskAt();
    const total = start.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0);
    expect(start.confirmation.grossTotal).toBeNull();
    expect(start.projectAssignment.grossTotal).toBe((total / 100).toFixed(2));
    // It is the whole list, not the assigned part: assigning one line does not change it.
    const one = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [start.lines[0]?.lineId ?? ''], projectNumber: 'P-2307', onlyUnassigned: false }));
    expect(one.projectAssignment.grossTotal).toBe((total / 100).toFixed(2));
    expect(one.projectAssignment.usage[0]?.grossTotal).toBe(start.lines[0]?.grossAmount);
  });

  it('an empty book sends a clean inventory to maintain_project_book; the first intake moves it to assign_projects', async () => {
    const start = await taskAt();
    expect(start).toMatchObject({ stage: 'project', step: { kind: 'maintain_project_book' } });
    await book('intake', { number: 'P-2307' });
    const after = await client.current(start.task.taskId);
    expect(after.step.kind).toBe('assign_projects');
    expect(after.step.stepToken).not.toBe(start.step.stepToken);
    expect(after.projectAssignment.projects).toEqual([{ number: 'P-2307', name: '华东客户交付', source: 'personal' }]);
  });
});

describe('the submitted selection is pinned', () => {
  it('the submitted selection retains the locally entered name when the public book later changes', async () => {
    await book('intake', { number: 'P-2307', name: '本地输入的名称' });
    const start = await taskAt();
    const projects = Object.fromEntries(start.lines.map((line) => [line.lineId, 'P-2307']));
    await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '杭州出差', projects }));

    const publicResult = ProjectBookResultSchema.parse(await (await alice.post('/api/public-project-book/intake', { number: 'PUBLIC-NEW', name: '后加公共项目' })).json());
    expect(publicResult.status).toBe('admitted');
    const after = await client.current(start.task.taskId);
    expect(after.projectAssignment).toMatchObject({ status: 'submitted', purpose: '杭州出差' });
    expect(after.projectAssignment.assignments.map((a) => [a.projectNumber, a.projectName])).toEqual([
      ['P-2307', '本地输入的名称'],
      ['P-2307', '本地输入的名称'],
    ]);
    expect(after.lines.map((line) => line.projectCode)).toEqual(['P-2307', 'P-2307']);
    expect(after.projectAssignment.projects).toEqual(expect.arrayContaining([{ number: 'PUBLIC-NEW', name: '后加公共项目', source: 'public' }]));
  });
});

describe('project deadline advisories', () => {
  it('has no advisory when the selected project has no deadline', async () => {
    await book('intake', { number: 'P-2307' });
    const start = await taskAt('project', ['m08']);
    const projects = Object.fromEntries(start.lines.map((line) => [line.lineId, 'P-2307']));

    const review = await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '返程车票', projects }));
    expect(review.projectAssignment.deadlineWarnings).toEqual([]);
    const actions = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    expect(actions).toMatchObject({ task: { taskId: start.task.taskId }, stage: 'actions', confirmation: { status: 'confirmed' } });
  });

  it('requires explicit continuation for an expense after the project deadline at assignment and confirmation', async () => {
    await book('intake', { number: 'P-2307', deadlineOn: '2026-08-10' });
    const start = await taskAt('project', ['m08']);
    const line = start.lines[0];
    if (!line) throw new Error('expected one rail line');
    const assigned = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [line.lineId], projectNumber: 'P-2307', onlyUnassigned: false }));
    const projects = { [line.lineId]: 'P-2307' };
    expect(assigned.projectAssignment.deadlineWarnings).toEqual([
      expect.objectContaining({ lineId: line.lineId, lineNo: line.no, projectNumber: 'P-2307', deadlineOn: '2026-08-10', kind: 'after_deadline' }),
    ]);

    await refused(await client.act(assigned, 'submit-project-assignment', { purpose: '返程车票', projects }), 'deadline_confirmation_required');
    const review = await client.accepted(await client.act(assigned, 'submit-project-assignment', { purpose: '返程车票', projects, acceptDeadlineWarnings: true }));
    expect(review).toMatchObject({ task: { taskId: start.task.taskId }, stage: 'review', projectAssignment: { deadlineWarnings: [expect.objectContaining({ kind: 'after_deadline' })] } });

    await refused(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }), 'deadline_confirmation_required');
    const actions = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest, acceptDeadlineWarnings: true }));
    expect(actions).toMatchObject({ task: { taskId: start.task.taskId }, stage: 'actions', confirmation: { status: 'confirmed' } });
  });

  it('does not revive a cleared current deadline from the submitted selection', async () => {
    await book('intake', { number: 'P-2307', deadlineOn: '2026-08-10' });
    const start = await taskAt('project', ['m08']);
    const line = start.lines[0];
    if (!line) throw new Error('expected one rail line');
    const projects = { [line.lineId]: 'P-2307' };
    const review = await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '返程车票', projects, acceptDeadlineWarnings: true }));
    expect(review.projectAssignment.deadlineWarnings).toHaveLength(1);

    const cleared = await alice.post('/api/project-book/edit', { originalNumber: 'P-2307', number: 'P-2307', name: '华东客户交付', deadlineOn: null });
    expect(cleared.status).toBe(200);
    const clearedProject = ProjectBookResultSchema.parse(await cleared.json()).book.projects[0];
    expect(clearedProject).toMatchObject({ number: 'P-2307' });
    expect(clearedProject?.deadlineOn ?? null).toBeNull();

    const current = await client.current(start.task.taskId);
    expect(current.projectAssignment.deadlineWarnings).toEqual([]);
    const actions = await client.accepted(await client.act(current, 'confirm-review', { digest: current.confirmation.digest }));
    expect(actions).toMatchObject({ stage: 'actions', confirmation: { status: 'confirmed' } });
  });

  it('warns when a stay crosses the project deadline without splitting the task', async () => {
    await book('intake', { number: 'P-2307', deadlineOn: '2026-08-10' });
    const start = await taskAt('project', ['m01', 'm02']);
    const line = start.lines[0];
    if (!line) throw new Error('expected one stay line');
    const assigned = await client.accepted(await client.act(start, 'assign-project-lines', { lineIds: [line.lineId], projectNumber: 'P-2307', onlyUnassigned: false }));
    const projects = { [line.lineId]: 'P-2307' };
    expect(assigned.projectAssignment.deadlineWarnings).toEqual([
      expect.objectContaining({ lineId: line.lineId, lineNo: line.no, deadlineOn: '2026-08-10', kind: 'stay_crosses_deadline' }),
    ]);

    await refused(await client.act(assigned, 'submit-project-assignment', { purpose: '住宿', projects }), 'deadline_confirmation_required');
    const review = await client.accepted(await client.act(assigned, 'submit-project-assignment', { purpose: '住宿', projects, acceptDeadlineWarnings: true }));
    expect(review).toMatchObject({ task: { taskId: start.task.taskId }, stage: 'review', lines: [expect.objectContaining({ lineId: line.lineId, date: '2026-08-09', endDate: '2026-08-22' })] });
    expect(review.task.taskId).toBe(start.task.taskId);
  });

  it('allows a pre-cutoff expense to be submitted later', async () => {
    await book('intake', { number: 'P-2307', deadlineOn: '2026-08-09' });
    const start = await taskAt('project', ['m07']);
    const line = start.lines[0];
    if (!line) throw new Error('expected one rail line');
    const projects = { [line.lineId]: 'P-2307' };

    const review = await client.accepted(await client.act(start, 'submit-project-assignment', { purpose: '去程车票', projects }));
    expect(review.projectAssignment.deadlineWarnings).toEqual([]);
    const actions = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    expect(actions).toMatchObject({ task: { taskId: start.task.taskId }, stage: 'actions', confirmation: { status: 'confirmed' } });
  });

  it('does not let a deadline acknowledgement bypass a project that is no longer eligible', async () => {
    await book('intake', { number: 'P-2307', deadlineOn: '2026-08-10' });
    await book('intake', { number: 'P-3312' });
    expect((await alice.post('/api/project-book/deactivate', { number: 'P-2307' })).status).toBe(200);
    const start = await taskAt('project', ['m08']);
    const line = start.lines[0];
    if (!line) throw new Error('expected one rail line');

    await refused(
      await client.act(start, 'submit-project-assignment', { purpose: '返程车票', projects: { [line.lineId]: 'P-2307' }, acceptDeadlineWarnings: true }),
      'project_not_allowed',
    );
  });
});

describe('home city', () => {
  it('is snapshotted per task, remembered per account as the next default, and editable on the current task', async () => {
    expect(TaskListSchema.parse(await (await alice.request('/api/tasks')).json()).homeCity).toBeNull();
    const start = await taskAt('project', ['m01'], '杭州');
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
    const start = await taskAt('project', ['m01']);
    // Seeded: a bare attempt row, with no fill job behind it, pins the refusal to the erp_attempt check itself rather
    // than to whatever the ERP phase gate says about a real job.
    await server.db
      .insertInto('erp_attempt')
      .values({ attempt_id: 'a1', job_id: 'j1', task_id: start.task.taskId, action: 'import', preconditions: '{}', expected_postconditions: '{}', erp_build: 'b', form_id: 'f', erp_account: 'x', erp_tenant: 't', erp_display_name: 'n', started_at: '2026-09-15T00:00:00Z' })
      .execute();
    await refused(await client.act(start, 'set-home-city', { homeCity: '上海' }), 'home_city_locked');
    // An invalid city is named before the lock, as it always was.
    await refused(await client.act(start, 'set-home-city', { homeCity: '这是一个超过二十个字的城市名称用来测试长度限制吗' }), 'invalid_home_city');
    expect((await client.current(start.task.taskId)).task.homeCity).toBe('杭州');
  });

  it('re-derives city transport categories: an invoice with no expense city blocks instead of borrowing the home city', async () => {
    const snapshot = await taskAt('pending', ['m03']);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.pendingItems).toEqual([expect.objectContaining({ itemId: `category_city_missing.${snapshot.materials[0]?.materialId}`, kind: 'choice' })]);
    expect(snapshot.stage).toBe('pending');
  });
});

describe('the personal book', () => {
  it('admits a trimmed arbitrary safe number without any ERP catalog check', async () => {
    const admitted = await book('intake', { number: '  LOCAL-0000 ', name: '  不在 ERP 目录中的本地项目  ' });
    expect(admitted).toMatchObject({
      status: 'admitted',
      verdict: null,
      book: { projects: [expect.objectContaining({ number: 'LOCAL-0000', name: '不在 ERP 目录中的本地项目', expiresOn: null, lastCheckedAt: null, selectable: true })] },
    });
    expect(await server.db.selectFrom('project_book_event').select(['action', 'admission_source', 'name']).where('number', '=', 'LOCAL-0000').execute()).toEqual([
      { action: 'admitted', admission_source: 'manual', name: '不在 ERP 目录中的本地项目' },
    ]);
  });

  it('rejects incomplete, unsafe, and duplicate local admissions without changing the saved fact', async () => {
    const missingNumber = await alice.post('/api/project-book/intake', { number: ' ', name: '名称' });
    expect(ProjectBookResultSchema.parse(await missingNumber.json())).toMatchObject({ status: 'rejected', note: '请填写项目号。' });
    const missingName = await alice.post('/api/project-book/intake', { number: 'LOCAL-1', name: ' ' });
    expect(ProjectBookResultSchema.parse(await missingName.json())).toMatchObject({ status: 'rejected', note: '请填写项目名称。' });
    expect(await book('intake', { number: 'P-12;', name: '非法字符' })).toMatchObject({ status: 'rejected', verdict: 'unsafe' });
    expect((await book('intake', { number: 'LOCAL-1', name: '原名称' })).status).toBe('admitted');
    expect(await book('intake', { number: 'LOCAL-1', name: '新名称' })).toMatchObject({ status: 'rejected', note: expect.stringContaining('未重复加入') });
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects).toEqual([expect.objectContaining({ number: 'LOCAL-1', name: '原名称' })]);
  });

  it('persists a manual admission across an application restart', async () => {
    const dataDir = tempDataDir();
    const database = databasePath(dataDir);
    const first = await createTestServer({ database, dataDir });
    const owner = await first.signIn('restart-owner');
    const admitted = ProjectBookResultSchema.parse(await (await owner.post('/api/project-book/intake', { number: 'RESTART-1', name: '重启后仍在' })).json());
    expect(admitted.status).toBe('admitted');

    // A process restart closes only the server and database; the data directory remains for the replacement process.
    await first.app.close();
    await first.db.destroy();
    const second = await createTestServer({ database, dataDir });
    try {
      const restored = ProjectBookSchema.parse(await (await testClient(second.app, owner.account, owner.cookie).request('/api/project-book')).json());
      expect(restored.projects).toEqual([expect.objectContaining({ number: 'RESTART-1', name: '重启后仍在', lastCheckedAt: null, selectable: true })]);
    } finally {
      await second.close();
    }
  });

  it('is per account, and resetAll clears this account’s book and home city only', async () => {
    await book('intake', { number: 'P-2307' });
    await taskAt('project', ['m01'], '杭州');
    const bob = await server.signIn('bob');
    await bob.post('/api/project-book/intake', { number: 'P-3312', name: '产品调研' });
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects.map((p) => p.number)).toEqual(['P-3312']);

    const reset = TaskListSchema.parse(await (await alice.post('/api/reset', {})).json());
    expect(reset).toEqual({ homeCity: null, tasks: [] });
    expect(ProjectBookSchema.parse(await (await alice.request('/api/project-book')).json()).projects).toEqual([]);
    expect(ProjectBookSchema.parse(await (await bob.request('/api/project-book')).json()).projects.map((p) => p.number)).toEqual(['P-3312']);
    expect(await server.db.selectFrom('project_book_event').select('action').where('owner_account_id', '=', alice.account.accountId).orderBy('seq').execute()).toEqual([{ action: 'admitted' }, { action: 'removed' }]);
  });
});
