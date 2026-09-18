// @vitest-environment node
import { SAMPLE_MATERIALS as SAMPLES } from '@baox/fixtures';
import { describe, expect, test, vi } from 'vitest';
import { MOCK_ACCOUNT, MOCK_PASSWORD } from './auth';
import { PROFILES } from './fixtures/inventory';
import { createMockAdapter } from './mock-adapter';

// The @baox/fixtures manifest drives the build:mock copy of sample materials; it must agree with the mock's recognition profiles.

async function inventoryOf(files: string[]) {
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 1 });
  const created = await adapter.createTask({ homeCity: '杭州' });
  if (!created.ok) throw new Error(created.error.message);
  const taskId = created.snapshot.task.taskId;
  const uploaded = await adapter.uploadBatch(taskId, files.map((name) => new File([`bytes of ${name}`], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf' })));
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  expect((await adapter.startInventory(taskId, uploaded.snapshot.step.stepToken)).ok).toBe(true);
  await vi.waitFor(async () => expect((await adapter.getSnapshot(taskId)).inventory.status).toBe('done'));
  return { adapter, snapshot: await adapter.getSnapshot(taskId) };
}

describe('mock 服务端：新建任务命名与示例材料识别', () => {
  test('示例材料对照表与识别档案一致（11 份，m01 到 m11）', () => {
    expect(SAMPLES).toHaveLength(11);
    expect(SAMPLES.map((sample) => [sample.file, sample.fileName])).toEqual(Object.values(PROFILES).map((profile) => [profile.file, profile.fileName]));
  });

  test('创建时是占位名称；按业务文件名上传 11 份后盘点，改名为 2026-08 上海出差并给出费用期间，待确认项 3 个', async () => {
    const { snapshot } = await inventoryOf(SAMPLES.map((sample) => sample.fileName));
    expect(snapshot.task.name).toBe('2026-08 上海出差');
    expect(snapshot.task.period).toEqual({ start: '2026-08-09', end: '2026-08-22' });
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toHaveLength(3);
    expect(snapshot.materials.filter((material) => material.kindLabel === '未识别版式')).toHaveLength(1);
  });

  test('new task snapshots start at revision 1 and accepted changes advance the revision', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const created = await adapter.createTask({ homeCity: '杭州' });
    if (!created.ok) throw new Error(created.error.message);
    const uploaded = await adapter.uploadBatch(created.snapshot.task.taskId, [new File(['invoice'], 'invoice.pdf', { type: 'application/pdf' })]);
    if (!uploaded.ok) throw new Error(uploaded.error.message);

    expect(created.snapshot.revision).toBe(1);
    expect(uploaded.snapshot.revision).toBe(2);
  });

  test('按示例原件文件名（m01-hotel-invoice.pdf 等）上传也能识别', async () => {
    const { snapshot } = await inventoryOf(SAMPLES.map((sample) => sample.file));
    expect(snapshot.task.name).toBe('2026-08 上海出差');
    expect(snapshot.pendingItems).toHaveLength(3);
    expect(snapshot.events).toHaveLength(9);
  });

  test('不认识的文件仍成为「不支持的材料类型」待确认项，名称保持占位', async () => {
    const { snapshot } = await inventoryOf(['随便一份.pdf']);
    expect(snapshot.pendingItems.map((item) => item.title)).toEqual(['不支持的材料类型']);
    expect(snapshot.task.name).toMatch(/^\d{4}-\d{2}-\d{2} 新建报销$/);
  });

  test('常驻城市：第一次是网络位置候选，创建后变为记住的城市；空城市被服务端拒绝', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    expect((await adapter.listTasks()).homeCity).toEqual({ value: '杭州', source: 'network' });
    expect((await adapter.createTask({ homeCity: ' ' })).ok).toBe(false);
    expect((await adapter.createTask({ homeCity: '苏州' })).ok).toBe(true);
    expect((await adapter.listTasks()).homeCity).toEqual({ value: '苏州', source: 'remembered' });
    const unavailable = createMockAdapter({ seed: null, fault: null, locationUnavailable: true });
    expect((await unavailable.listTasks()).homeCity).toBeNull();
  });

  test('background inventory resolves project options from the task owner after an account switch', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, bookEmpty: true, inventoryPhaseMs: 5 });
    expect(await adapter.intakeProject({ number: 'A-PRIVATE', name: 'Owner A private' })).toMatchObject({ ok: true, result: { status: 'admitted' } });
    const created = await adapter.createTask({ homeCity: '杭州' });
    if (!created.ok) throw new Error(created.error.message);
    const uploaded = await adapter.uploadBatch(created.snapshot.task.taskId, [new File(['rail'], 'm07-rail-0809.pdf', { type: 'application/pdf' })]);
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    expect((await adapter.startInventory(created.snapshot.task.taskId, uploaded.snapshot.step.stepToken)).ok).toBe(true);

    expect((await adapter.register({ username: 'other-owner', password: 'test-password' })).ok).toBe(true);
    expect(await adapter.intakeProject({ number: 'B-PRIVATE', name: 'Owner B private' })).toMatchObject({ ok: true, result: { status: 'admitted' } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);
    const completed = await adapter.getSnapshot(created.snapshot.task.taskId);
    expect(completed.inventory.status).toBe('done');
    expect(completed.projectAssignment.projects).toEqual([{ number: 'A-PRIVATE', name: 'Owner A private', source: 'personal' }]);
  });

  test('unchanged resubmission preserves historical pins after a personal project becomes public', async () => {
    const adapter = createMockAdapter({ seed: 'review', fault: null, autoStepMs: 1 });
    const before = await adapter.getSnapshot('T1');
    const historicalPins = before.projectAssignment.assignments.filter((assignment) => assignment.projectNumber === 'P-3312');

    expect(await adapter.intakePublicProject({ number: 'P-3312', name: 'Public replacement name' })).toMatchObject({ ok: true, result: { status: 'conversion_required' } });
    expect(await adapter.confirmPublicProjectConversion({ operation: 'intake', number: 'P-3312', name: 'Public replacement name' })).toMatchObject({ ok: true, result: { status: 'converted' } });
    const converted = await adapter.getSnapshot('T1');
    expect(converted.projectAssignment.projects).toContainEqual({ number: 'P-3312', name: 'Public replacement name', source: 'public' });

    const projects = Object.fromEntries(converted.projectAssignment.assignments.map((assignment) => [assignment.lineId, assignment.projectNumber]));
    const submitted = await adapter.submitProjectAssignment('T1', { purpose: converted.projectAssignment.purpose ?? 'Travel', projects }, converted.step.stepToken);
    if (!submitted.ok) throw new Error(submitted.error.message);
    expect(submitted.snapshot.projectAssignment.assignments.filter((assignment) => assignment.projectNumber === 'P-3312')).toEqual(historicalPins);
  });
});
