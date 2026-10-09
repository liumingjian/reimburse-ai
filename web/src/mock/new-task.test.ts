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
  test('餐饮小票缺少发票时阻塞，只能排除或追加上传发票', async () => {
    const { adapter, snapshot } = await inventoryOf(['餐饮_小票.pdf']);
    const slip = snapshot.materials[0];
    const item = snapshot.pendingItems[0];
    expect(slip).toMatchObject({ role: 'reference', status: 'pending' });
    expect(item).toMatchObject({ itemId: `dining_invoice_missing.${slip?.materialId}`, title: '餐饮小票「餐饮_小票.pdf」缺少发票', choices: [{ key: 'exclude', label: '排除这份材料' }] });
    if (!item) throw new Error('missing dining invoice item');
    for (const choice of ['confirm_none', 'supply']) {
      expect(await adapter.answerPendingItem(snapshot.task.taskId, item.itemId, { choice }, snapshot.step.stepToken)).toMatchObject({ ok: false, error: { code: 'invalid_answer' } });
    }
    const excluded = await adapter.answerPendingItem(snapshot.task.taskId, item.itemId, { choice: 'exclude' }, snapshot.step.stepToken);
    if (!excluded.ok) throw new Error(excluded.error.message);
    expect(excluded.snapshot.pendingItems.filter((candidate) => candidate.status === 'open')).toEqual([]);
    expect(excluded.snapshot.materials[0]?.status).toBe('excluded');
  });

  test.each(['餐饮_小票.pdf', '餐饮_优惠小票.pdf'])('餐饮发票与 %s 实付金额相等时配对', async (fileName) => {
    const { snapshot } = await inventoryOf(['餐饮_发票.pdf', fileName]);
    const receipt = snapshot.materials.find((material) => material.fileName === fileName);
    expect(receipt).toMatchObject({ kind: 'dining_receipt', role: 'reference', status: 'ok' });
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.lines).toEqual([expect.objectContaining({ category: { code: 'hospitality', label: '招待费' }, grossAmount: '240.00', referenceMaterialIds: [receipt?.materialId] })]);
  });

  test('孤立餐饮小票追加匹配发票后配对并清除阻塞', async () => {
    const { adapter, snapshot } = await inventoryOf(['餐饮_小票.pdf']);
    const reopened = await adapter.reopenUpload(snapshot.task.taskId, snapshot.step.stepToken);
    if (!reopened.ok) throw new Error(reopened.error.message);
    const uploaded = await adapter.uploadBatch(snapshot.task.taskId, [new File(['invoice'], '餐饮_发票.pdf', { type: 'application/pdf' })]);
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    expect((await adapter.startInventory(snapshot.task.taskId, uploaded.snapshot.step.stepToken)).ok).toBe(true);
    await vi.waitFor(async () => expect((await adapter.getSnapshot(snapshot.task.taskId)).inventory.status).toBe('done'));
    const paired = await adapter.getSnapshot(snapshot.task.taskId);
    expect(paired.stage).toBe('project');
    expect(paired.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([snapshot.materials[0]?.materialId]);
    expect(paired.materials.every((material) => material.status === 'ok')).toBe(true);
  });

  test('示例材料对照表与识别档案一致（14 份，m01 到 m14）', () => {
    expect(SAMPLES).toHaveLength(14);
    expect(SAMPLES.map((sample) => [sample.file, sample.fileName])).toEqual(Object.values(PROFILES).map((profile) => [profile.file, profile.fileName]));
  });

  test('创建时是占位名称；上传全部示例后名称不变，并保留重复金额的小票及 7 个待确认项', async () => {
    const { snapshot } = await inventoryOf(SAMPLES.map((sample) => sample.fileName));
    expect(snapshot.task.name).toMatch(/^\d{4}-\d{2}-\d{2} 新建报销$/);
    expect(snapshot.task.period).toEqual({ start: '2026-08-09', end: '2026-08-22' });
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toHaveLength(7);
    expect(snapshot.materials.filter((material) => material.kindLabel === '未识别版式')).toHaveLength(1);
  });

  test('餐饮发票列为招待费，并且缺少餐饮小票只能排除', async () => {
    const { adapter, snapshot } = await inventoryOf(['餐饮_发票.pdf']);
    expect(snapshot.lines).toEqual([expect.objectContaining({ category: { code: 'hospitality', label: '招待费' }, expenseItemCode: 'FY009001', expenseItemName: '招待费' })]);
    const item = snapshot.pendingItems[0];
    expect(item).toMatchObject({ itemId: `dining_receipt_missing.${snapshot.materials[0]?.materialId}`, choices: [{ key: 'exclude', label: '排除这份材料' }] });
    if (!item) throw new Error('missing dining receipt item');
    expect(await adapter.answerPendingItem(snapshot.task.taskId, item.itemId, { choice: 'confirm_none' }, snapshot.step.stepToken)).toMatchObject({ ok: false, error: { code: 'invalid_answer' } });
    const excluded = await adapter.answerPendingItem(snapshot.task.taskId, item.itemId, { choice: 'exclude' }, snapshot.step.stepToken);
    if (!excluded.ok) throw new Error(excluded.error.message);
    expect(excluded.snapshot.materials[0]?.status).toBe('excluded');
    expect(excluded.snapshot.lines).toEqual([]);
    expect(excluded.snapshot.events).toEqual([]);
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
    expect(snapshot.task.period).toEqual({ start: '2026-08-09', end: '2026-08-22' });
    expect(snapshot.pendingItems).toHaveLength(7);
    expect(snapshot.events).toHaveLength(10);
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
    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);
    const pending = (await adapter.listAccounts()).accounts.find((account) => account.username === 'other-owner');
    if (!pending) throw new Error('pending account was not listed');
    expect((await adapter.updateAccount(pending.accountId, { approved: true })).ok).toBe(true);
    expect((await adapter.login({ username: 'other-owner', password: 'test-password' })).ok).toBe(true);
    expect(await adapter.intakeProject({ number: 'B-PRIVATE', name: 'Owner B private' })).toMatchObject({ ok: true, result: { status: 'admitted' } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);
    const completed = await adapter.getSnapshot(created.snapshot.task.taskId);
    expect(completed.inventory.status).toBe('done');
    expect(completed.projectAssignment.projects).toEqual([{ number: 'A-PRIVATE', name: 'Owner A private', source: 'personal' }]);
  });

  test('unchanged resubmission preserves historical pins after a personal project becomes public', async () => {
    const adapter = createMockAdapter({ seed: 'review', fault: null });
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
