import { describe, expect, test } from 'vitest';
import { t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from '../mock/fixtures/tasks';
import { FAULTS, readMockOptions } from '../mock/options';
import { TASK_STAGES, TaskStageSchema, pageAllowed, stageReached } from './stage';
import { TaskSnapshotSchema } from './snapshot';
import { TaskListSchema } from './task-list';

describe('契约 schema', () => {
  test('每个阶段的 T1 夹具、T2 与 T3 夹具都通过快照 schema', () => {
    for (const stage of TASK_STAGES) {
      expect(() => TaskSnapshotSchema.parse(t1Snapshot(stage)), stage).not.toThrow();
    }
    expect(() => TaskSnapshotSchema.parse(t2Snapshot())).not.toThrow();
    expect(() => TaskSnapshotSchema.parse(t3Snapshot())).not.toThrow();
  });

  test('由快照投影出的任务列表通过任务列表 schema', () => {
    const list = { employee: { name: '林颂宜', department: '产品研发部' }, tasks: [t1Snapshot('done'), t2Snapshot(), t3Snapshot()].map(toListItem) };
    const parsed = TaskListSchema.parse(list);
    expect(parsed.tasks.map((task) => task.stage)).toEqual(['done', 'reconcile', 'done']);
    expect(parsed.tasks[0]?.grossTotal).toBe('3972.59');
    expect(parsed.tasks[0]?.erpDraftNo).toBe('BX20260911-0173');
  });

  test('金额与日期格式不对的快照被拒绝', () => {
    const broken = t1Snapshot('done');
    broken.confirmation.grossTotal = '3972.5';
    expect(() => TaskSnapshotSchema.parse(broken)).toThrow();
    const badDate = t3Snapshot();
    badDate.task.period = { start: '2026/06/02', end: '2026-06-05' };
    expect(() => TaskSnapshotSchema.parse(badDate)).toThrow();
  });
});

describe('报销任务阶段', () => {
  test('阶段是闭合枚举，?seed= 复用同一套名字，未知值被忽略', () => {
    expect(TaskStageSchema.safeParse('print').success).toBe(false);
    expect(readMockOptions('?seed=review&fault=readback-mismatch')).toEqual({ seed: 'review', fault: 'readback-mismatch' });
    expect(readMockOptions('?seed=nope&fault=nope')).toEqual({ seed: null, fault: null });
    expect(FAULTS).toHaveLength(6);
  });

  test('页面守卫：阶段不可跳过', () => {
    expect(stageReached('review', 'inventory')).toBe(true);
    expect(stageReached('upload', 'inventory')).toBe(false);
    expect(pageAllowed('upload', 'inventory')).toBe(false);
    expect(pageAllowed('actions', 'print')).toBe(true);
    expect(pageAllowed('actions', 'erp')).toBe(false);
    expect(pageAllowed('project', 'erp')).toBe(true);
    expect(pageAllowed('reconcile', 'reconcile')).toBe(true);
    expect(pageAllowed('done', 'reconcile')).toBe(false);
  });
});
