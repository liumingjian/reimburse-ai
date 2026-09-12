import { describe, expect, test } from 'vitest';
import { confirmationDigest } from '../mock/fixtures/projects';
import { t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from '../mock/fixtures/tasks';
import { FAULTS, readMockOptions } from '../mock/options';
import { CREATE_TASK_ERRORS, CreateTaskInputSchema, PENDING_ANSWER_ERRORS, isRealDate, validatePendingAnswer } from './actions';
import { STAGE_DEFAULT_PAGE, TASK_STAGES, TaskStageSchema, pageAllowed, stageReached } from './stage';
import { STEP_KINDS, TaskSnapshotSchema, UploadBatchSchema } from './snapshot';
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
    const list = { employee: { name: '林颂宜', department: '产品研发部' }, homeCity: { value: '杭州', source: 'network' }, tasks: [t1Snapshot('done'), t2Snapshot(), t3Snapshot()].map(toListItem) };
    const parsed = TaskListSchema.parse(list);
    expect(parsed.tasks.map((task) => task.stage)).toEqual(['done', 'reconcile', 'done']);
    expect(parsed.tasks[0]?.grossTotal).toBe('3972.59');
    expect(parsed.tasks[0]?.erpDraftNo).toBe('BX20260911-0173');
    expect(parsed.tasks.map((task) => task.erpOutcome)).toEqual(['none', 'none', 'none']);
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

  test('新建任务输入：只有常驻城市，去掉空白后必填', () => {
    const messages = (input: unknown) => {
      const result = CreateTaskInputSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };
    expect(messages({ homeCity: '  ' })).toEqual([CREATE_TASK_ERRORS.homeCityRequired]);
    expect(messages({ homeCity: '' })).toEqual([CREATE_TASK_ERRORS.homeCityRequired]);
    expect(messages({ homeCity: '杭州' })).toEqual([]);
    expect(CreateTaskInputSchema.parse({ homeCity: ' 上海 ' })).toEqual({ homeCity: '上海' });
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026/09/03')).toBe(false);
  });

  test('盘点后的快照带材料识别结果、费用事件与待确认项；项目归属起带候选明细，No. 按内核分类排序', () => {
    const inventory = t1Snapshot('inventory');
    expect(inventory.inventory.status).toBe('done');
    expect(inventory.materials.filter((material) => material.role === 'primary_voucher')).toHaveLength(7);
    expect(inventory.materials.filter((material) => material.role === 'reference')).toHaveLength(3);
    expect(inventory.events.map((event) => event.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(inventory.pendingItems.map((item) => [item.itemId, item.kind, item.status])).toEqual([
      ['p1', 'form', 'open'],
      ['p2', 'form', 'open'],
      ['p3', 'choice', 'open'],
    ]);
    expect(inventory.materials.every((material) => material.originalUrl?.startsWith('fixtures/'))).toBe(true);
    expect(inventory.lines).toHaveLength(0);

    const review = t1Snapshot('review');
    expect(review.pendingItems.every((item) => item.status === 'resolved')).toBe(true);
    // 统一业务序号跟随内核确认表的分类排序（本地市内交通 → 外地市内交通 → 长途交通 → 住宿），同一分类内保持事件顺序。
    expect(review.lines.map((line) => line.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(review.lines.map((line) => line.category.code)).toEqual([
      'remote_city_transport',
      'remote_city_transport',
      'remote_city_transport',
      'remote_city_transport',
      'remote_city_transport',
      'remote_city_transport',
      'long_distance',
      'long_distance',
      'accommodation',
    ]);
    expect(review.lines.map((line) => line.grossAmount)).toEqual(['26.69', '20.85', '21.65', '38.40', '32.00', '47.00', '73.00', '73.00', '3640.00']);
    expect(review.lines[4]?.description).toBe('出租车 · 张江高科 → 漕河泾开发区');
    expect(review.lines.filter((line) => line.groupId === 'g1')).toHaveLength(3);
    // 费用事件与候选明细共用同一个序号。
    expect(review.events.map((event) => [event.no, event.grossAmount])).toEqual(review.lines.map((line) => [line.no, line.grossAmount]));
    expect(review.confirmation).toMatchObject({ status: 'unconfirmed', lineCount: 9, invoiceCount: 7, grossTotal: '3972.59' });
    expect(review.confirmation.digest).toMatch(/^digest-t1-v1-[0-9a-f]{8}$/);
    expect(t1Snapshot('actions').confirmation.status).toBe('confirmed');
    expect(t1Snapshot('actions').step.kind).toBe('choose_action');
    expect(t1Snapshot('pending', true).pendingItems).toHaveLength(4);
  });

  test('流程顺序照 Skill：项目归属在整单确认之前；整单确认的摘要绑定项目归属与事由；没有「开始填报」这一步', () => {
    const project = t1Snapshot('project');
    expect(project.lines).toHaveLength(9);
    expect(project.step.kind).toBe('assign_projects');
    expect(project.projectAssignment.status).toBe('pending');
    expect(project.confirmation.digest).toBeNull();
    for (const stage of ['catalog', 'preparation'] as const) {
      const snapshot = t1Snapshot(stage);
      expect(snapshot.projectAssignment.status, stage).toBe('submitted');
      expect(snapshot.confirmation.digest, stage).toBeNull();
      expect(snapshot.step.kind, stage).toBe('none');
    }

    const review = t1Snapshot('review');
    expect(review.confirmation.digest).toBe(confirmationDigest('T1', 'v1', review.projectAssignment));
    const moved = structuredClone(review.projectAssignment);
    const first = moved.assignments[0];
    if (first) first.projectNumber = 'P-1180';
    expect(confirmationDigest('T1', 'v1', moved)).not.toBe(review.confirmation.digest);
    expect(confirmationDigest('T1', 'v1', { ...review.projectAssignment, purpose: '另一个事由' })).not.toBe(review.confirmation.digest);

    expect(STEP_KINDS.indexOf('assign_projects')).toBeLessThan(STEP_KINDS.indexOf('confirm_review'));
    expect(STEP_KINDS.indexOf('confirm_review')).toBeLessThan(STEP_KINDS.indexOf('choose_action'));
    expect((STEP_KINDS as readonly string[]).includes('start_erp_write')).toBe(false);
    // ?seed=erp：已点「去报销」，浏览器启动后等待登录。
    const erp = t1Snapshot('erp');
    expect(erp.step.kind).toBe('erp_login');
    expect(erp.erp.status).toBe('waiting_login');
  });

  test('待确认项答复校验：必填、HH:MM、日期与选择', () => {
    const form = {
      kind: 'form' as const,
      fields: [
        { key: 'alightTime', label: '下车时间', placeholder: '', required: true, format: 'time' as const },
        { key: 'origin', label: '起点', placeholder: '', required: true, format: 'text' as const },
        { key: 'day', label: '日期', placeholder: '', required: false, format: 'date' as const },
      ],
      choices: [],
    };
    expect(validatePendingAnswer(form, { alightTime: '19:06', origin: ' 静安寺 ' })).toEqual({});
    expect(validatePendingAnswer(form, { alightTime: '90:60', origin: '' })).toEqual({ alightTime: PENDING_ANSWER_ERRORS.time, origin: PENDING_ANSWER_ERRORS.required });
    expect(validatePendingAnswer(form, { alightTime: '24:00', origin: 'x', day: '2026-02-30' })).toEqual({ alightTime: PENDING_ANSWER_ERRORS.time, day: PENDING_ANSWER_ERRORS.date });
    const choice = { kind: 'choice' as const, fields: [], choices: [{ key: 'exclude', label: '排除此材料' }] };
    expect(validatePendingAnswer(choice, { choice: 'exclude' })).toEqual({});
    expect(validatePendingAnswer(choice, { choice: 'nope' })).toEqual({ choice: PENDING_ANSWER_ERRORS.choice });
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
  test('阶段是闭合枚举，顺序照 Skill；?seed= 复用同一套名字，未知值被忽略', () => {
    expect(TASK_STAGES).toEqual(['upload', 'inventory', 'pending', 'project', 'catalog', 'preparation', 'review', 'actions', 'erp', 'done', 'reconcile']);
    expect(TaskStageSchema.safeParse('print').success).toBe(false);
    expect(readMockOptions('?seed=review&fault=readback-mismatch')).toEqual({ seed: 'review', fault: 'readback-mismatch' });
    expect(readMockOptions('?seed=nope&fault=nope')).toEqual({ seed: null, fault: null });
    // ?location=unavailable 不是故障，与 seed/fault 并列。
    expect(readMockOptions('?seed=review&location=unavailable')).toEqual({ seed: 'review', fault: null, locationUnavailable: true });
    // 票面写的 ?seed=assign 是 project 的别名。
    expect(readMockOptions('?seed=assign')).toEqual({ seed: 'project', fault: null });
    expect(readMockOptions('?seed=project')).toEqual({ seed: 'project', fault: null });
    expect(readMockOptions('?seed=catalog')).toEqual({ seed: 'catalog', fault: null });
    // ?seed=print：actions 阶段，且打印稿已经生成（打印稿预览不是阶段）。
    expect(readMockOptions('?seed=print')).toEqual({ seed: 'actions', fault: null, printSheet: true });
    expect(FAULTS).toHaveLength(6);
  });

  test('页面守卫：阶段不可跳过；项目归属在整单确认之前，打印稿在确认之后，ERP 填报在去报销之后', () => {
    expect(stageReached('review', 'inventory')).toBe(true);
    expect(stageReached('upload', 'inventory')).toBe(false);
    expect(pageAllowed('upload', 'inventory')).toBe(false);
    expect(pageAllowed('pending', 'project')).toBe(false);
    expect(pageAllowed('project', 'project')).toBe(true);
    expect(pageAllowed('project', 'review')).toBe(false);
    expect(pageAllowed('catalog', 'review')).toBe(true);
    expect(pageAllowed('review', 'print')).toBe(false);
    expect(pageAllowed('actions', 'print')).toBe(true);
    expect(pageAllowed('actions', 'project')).toBe(true);
    expect(pageAllowed('actions', 'erp')).toBe(false);
    expect(pageAllowed('erp', 'erp')).toBe(true);
    expect(pageAllowed('reconcile', 'reconcile')).toBe(true);
    expect(pageAllowed('done', 'reconcile')).toBe(false);
    expect(STAGE_DEFAULT_PAGE.catalog).toBe('review');
    expect(STAGE_DEFAULT_PAGE.preparation).toBe('review');
  });
});
