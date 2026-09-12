// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { PROFILES } from './fixtures/inventory';
import { createMockAdapter } from './mock-adapter';

// fixtures/sample-materials.json 是 build:mock 复制示例材料用的对照表；它与 mock 识别档案必须一致。
const SAMPLES = JSON.parse(readFileSync(new URL('../../fixtures/sample-materials.json', import.meta.url), 'utf8')) as Array<{ file: string; fileName: string }>;

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
});
