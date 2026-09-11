import { describe, expect, test } from 'vitest';
import { t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from '../mock/fixtures/tasks';
import { FAULTS, readMockOptions } from '../mock/options';
import { CREATE_TASK_ERRORS, CreateTaskInputSchema, isRealDate } from './actions';
import { TASK_STAGES, TaskStageSchema, pageAllowed, stageReached } from './stage';
import { TaskSnapshotSchema, UploadBatchSchema } from './snapshot';
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

  test('上传批次里的材料与逐文件结果通过 schema；已接收的文件带 64 位内容哈希', () => {
    const snapshot = t1Snapshot('inventory');
    expect(snapshot.batches).toHaveLength(1);
    expect(snapshot.materials).toHaveLength(11);
    const batch = UploadBatchSchema.parse(snapshot.batches[0]);
    for (const file of batch.files) {
      expect(file.status).toBe('accepted');
      expect(file.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.materials.some((material) => material.materialId === file.materialId)).toBe(true);
    }
    const rejected = { ...batch, files: [{ ...batch.files[0], status: 'rejected', contentHash: null, materialId: null, reasonCode: 'heic', reason: 'HEIC 不支持' }] };
    expect(UploadBatchSchema.safeParse(rejected).success).toBe(true);
    const badHash = { ...batch, files: [{ ...batch.files[0], contentHash: 'sha256:abcd' }] };
    expect(UploadBatchSchema.safeParse(badHash).success).toBe(false);
  });

  test('新建任务输入：名称必填，日期范围起止合法且结束不早于开始', () => {
    const messages = (input: unknown) => {
      const result = CreateTaskInputSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    expect(messages({ name: '  ', periodStart: null, periodEnd: null })).toEqual([CREATE_TASK_ERRORS.nameRequired]);
    expect(messages({ name: 'x', periodStart: null, periodEnd: null })).toEqual([]);
    expect(messages({ name: 'x', periodStart: '2026-09-03', periodEnd: '2026-09-05' })).toEqual([]);
    expect(messages({ name: 'x', periodStart: '2026-09-03', periodEnd: '2026-09-03' })).toEqual([]);
    expect(messages({ name: 'x', periodStart: '2026-09-05', periodEnd: '2026-09-03' })).toEqual([CREATE_TASK_ERRORS.periodReversed]);
    expect(messages({ name: 'x', periodStart: '2026-09-03', periodEnd: null })).toEqual([CREATE_TASK_ERRORS.periodIncomplete]);
    expect(messages({ name: 'x', periodStart: '2026-02-30', periodEnd: '2026-03-01' })).toEqual([CREATE_TASK_ERRORS.dateInvalid]);
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026/09/03')).toBe(false);
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
