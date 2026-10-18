// Mock/contract consistency: fixture snapshots, mock server behaviour and ?seed= options must all pass the @baox/contract schemas. Pure schema tests live in contract/.
import { describe, expect, test } from 'vitest';
import {
  ALLOCATION_ERRORS,
  ERP_STEPS,
  ErpStepSchema,
  PENDING_ANSWER_ERRORS,
  PendingAnswerSchema,
  ProjectBookSchema,
  STEP_KINDS,
  TASK_STAGES,
  TaskListSchema,
  TaskSnapshotSchema,
  TaskStageSchema,
  UploadBatchSchema,
  validatePendingAnswer,
} from '@baox/contract';
import { GOLDEN_SCENARIOS, GOLDENS } from '@baox/contract/goldens';
import { ERP_STEP_DEFS, ERP_STEP_INDEX, erpSteps } from './fixtures/erp';
import { INITIAL_BOOK, MOCK_TODAY, annotateProject, confirmationDigest } from './fixtures/projects';
import { t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from './fixtures/tasks';
import { createMockAdapter } from './mock-adapter';
import { FAULTS, SEED_STAGES, readMockOptions } from './options';

describe('契约 schema', () => {
  // The server records the goldens (server/src/snapshot-goldens.test.ts); here only that the mock can load them.
  test('服务端录制的黄金快照能被 mock 载入', () => {
    expect(Object.keys(GOLDENS)).toEqual([...GOLDEN_SCENARIOS]);
    expect(GOLDENS['choose-action'].step.kind).toBe('choose_action');
    expect(GOLDENS.voided.stage).toBe('voided');
  });

  test('每个阶段的 T1 夹具、T2 与 T3 夹具都通过快照 schema', () => {
    for (const stage of SEED_STAGES) {
      expect(() => TaskSnapshotSchema.parse(t1Snapshot(stage)), stage).not.toThrow();
    }
    expect(() => TaskSnapshotSchema.parse(t2Snapshot())).not.toThrow();
    expect(() => TaskSnapshotSchema.parse(t3Snapshot())).not.toThrow();
  });

  test('mock 的写入步骤清单与契约同源', () => {
    expect(ERP_STEP_DEFS).toEqual(ERP_STEPS);
    expect(ERP_STEP_INDEX.handover).toBe(ERP_STEP_DEFS.length - 1);
    expect(ERP_STEP_DEFS.some((step) => step.title.includes('保存'))).toBe(false);
    for (const step of erpSteps(ERP_STEP_DEFS.length, 'running')) expect(() => ErpStepSchema.parse(step)).not.toThrow();
  });

  test('由快照投影出的任务列表通过任务列表 schema', () => {
    const list = { homeCity: { value: '杭州', source: 'network' }, tasks: [t1Snapshot('done'), t2Snapshot(), t3Snapshot()].map(toListItem) };
    const parsed = TaskListSchema.parse(list);
    expect(parsed.tasks.map((task) => task.stage)).toEqual(['done', 'reconcile', 'done']);
    expect(parsed.tasks[0]?.grossTotal).toBe('3972.59');
    // 交接后没有单据编号（还没有保存）；T3 那张是员工自己保存过的，才有编号。
    expect(parsed.tasks[0]?.erpDraftNo).toBeNull();
    expect(parsed.tasks[2]?.erpDraftNo).toBe('BX20260702-0088');
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
      ['stay_screenshot_missing.m01', 'choice', 'open'],
    ]);
    expect(inventory.materials.every((material) => material.originalUrl?.startsWith('fixtures/'))).toBe(true);
    // As on the server, the candidate lines follow the expense events as soon as the inventory is done.
    expect(inventory.lines.map((line) => line.no)).toEqual(inventory.events.map((event) => event.no));

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
    expect(review.lines.filter((line) => line.voucherMaterialId === 'm03')).toHaveLength(3);
    // 费用事件与候选明细共用同一个序号。
    expect(review.events.map((event) => [event.no, event.grossAmount])).toEqual(review.lines.map((line) => [line.no, line.grossAmount]));
    expect(review.confirmation).toMatchObject({ status: 'unconfirmed', lineCount: 9, invoiceCount: 7, grossTotal: '3972.59' });
    // As on the server: the catalog is checked inside the ERP job (still pending here), and the preparation is ready
    // without problems or package files once the digest exists.
    expect(review.catalog).toEqual({ status: 'pending', problems: [] });
    expect(review.preparation).toEqual({ status: 'ready', problems: [], packageFiles: [] });
    // 确认表字段：发票短标签按主要发票 materialId 编号（不跟随行序）；项目号在提交后写入；费用项目为虚构编码。
    expect(review.lines.map((line) => line.invoiceLabel)).toEqual(['发票2', '发票2', '发票2', '发票3', '发票6', '发票7', '发票4', '发票5', '发票1']);
    expect(review.lines.map((line) => line.projectCode)).toEqual(['P-3312', 'P-3312', 'P-3312', 'P-3312', 'P-3312', 'P-3312', 'P-2307', 'P-2307', 'P-2307']);
    expect(review.lines[8]).toMatchObject({ city: '上海', date: '2026-08-09', endDate: '2026-08-22', projectName: '华东客户交付', expenseItemCode: 'FY020102', expenseItemName: '住宿费' });
    expect(review.lines[4]).toMatchObject({ origin: '张江高科', destination: '漕河泾开发区', endDate: null });
    expect(review.lines[6]).toMatchObject({ city: null, origin: '杭州东', destination: '上海虹桥', expenseItemCode: 'FY020101' });
    // 项目归属页的卡片字段：路线（起点与终点都有才有）与脱敏票号（内核 maskNumber；铁路夹具没有发票号码）。
    expect(review.lines.map((line) => line.maskedNumber)).toEqual([
      '2631************7402',
      '2631************7402',
      '2631************7402',
      '2631************0115',
      '04****77',
      '04****52',
      null,
      null,
      '2631************7734',
    ]);
    expect(review.lines.map((line) => line.route)).toEqual([
      '虹桥枢纽 → 漕河泾',
      '漕河泾 → 静安寺',
      '静安寺 → 张江',
      '浦东机场 → 张江',
      '张江高科 → 漕河泾开发区',
      '静安寺 → 虹桥枢纽',
      '杭州东 → 上海虹桥',
      '上海虹桥 → 杭州东',
      null,
    ]);
    // 允许列表只含可选项目；「本次已归入」的条数与金额由服务端投影给出。
    expect(review.projectAssignment.projects.map((project) => project.number)).toEqual(['P-2307', 'P-2311', 'P-3312', 'P-1180']);
    expect(review.projectAssignment.working).toEqual(review.projectAssignment.assignments);
    expect(review.projectAssignment.usage).toEqual([
      { number: 'P-3312', name: '产品调研', lineCount: 6, grossTotal: '186.59', selectable: true },
      { number: 'P-2307', name: '华东客户交付', lineCount: 3, grossTotal: '3786.00', selectable: true },
    ]);
    expect(t1Snapshot('project').projectAssignment.usage).toEqual([{ number: 'P-2307', name: '华东客户交付', lineCount: 2, grossTotal: '47.54', selectable: true }]);
    expect(t1Snapshot('project').lines.every((line) => line.projectCode === null && line.projectName === null)).toBe(true);
    expect(t1Snapshot('project').preparation).toEqual({ status: 'pending', problems: [], packageFiles: [] });
    expect(t1Snapshot('project').catalog.status).toBe('pending');
    expect(t1Snapshot('project').confirmation).toMatchObject({ digest: null, lineCount: 0, invoiceCount: 0, grossTotal: null });
    expect(review.confirmation.digest).toMatch(/^digest-t1-v1-[0-9a-f]{8}$/);
    expect(t1Snapshot('actions').confirmation.status).toBe('confirmed');
    expect(t1Snapshot('actions').step.kind).toBe('choose_action');
    expect(t1Snapshot('pending', true).pendingItems).toHaveLength(5);
  });

  test('流程顺序照 Skill：项目归属在整单确认之前；整单确认的摘要绑定项目归属与事由；没有「开始填报」这一步', () => {
    const project = t1Snapshot('project');
    expect(project.lines).toHaveLength(9);
    expect(project.step.kind).toBe('assign_projects');
    expect(project.projectAssignment.status).toBe('pending');
    expect(project.confirmation.digest).toBeNull();

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

  test('逐段分摊与处理人：?allocation=1 的各阶段夹具通过 schema；待确认项都带处理人；答复为 amounts 或 giveUp', () => {
    for (const stage of SEED_STAGES) {
      expect(() => TaskSnapshotSchema.parse(t1Snapshot(stage, false, true)), stage).not.toThrow();
    }
    expect(t1Snapshot('pending').pendingItems.map((item) => item.resolver)).toEqual(['要你处理', '要你处理', '要你处理', '要你处理']);
    expect(t1Snapshot('pending').blockers).toEqual([]);
    const pending = t1Snapshot('pending', false, true);
    expect(pending.pendingItems.map((item) => [item.itemId, item.kind])).toEqual([
      ['p1', 'allocation'],
      ['p2', 'form'],
      ['p3', 'form'],
      ['p4', 'choice'],
      ['stay_screenshot_missing.m01', 'choice'],
    ]);
    const allocation = pending.pendingItems[0]?.allocation;
    expect(allocation?.total).toBe('69.19');
    expect(allocation?.segments.map((segment) => [segment.index, segment.route, segment.suggested])).toEqual([
      [1, '虹桥枢纽 → 漕河泾', '26.69'],
      [2, '漕河泾 → 静安寺', '20.85'],
      [3, '静安寺 → 张江', '21.56'],
    ]);
    // project 起按原件金额答复，明细与默认相同。
    const review = t1Snapshot('review', false, true);
    expect(review.lines.map((line) => line.grossAmount)).toEqual(['26.69', '20.85', '21.65', '38.40', '32.00', '47.00', '73.00', '73.00', '3640.00']);
    expect(review.lines.slice(0, 3).map((line) => line.taxAmount)).toEqual(['0.77', '0.61', '0.63']);

    const target = { kind: 'allocation' as const, fields: [], choices: [], allocation: allocation ?? null };
    expect(validatePendingAnswer(target, { giveUp: true })).toEqual({});
    expect(validatePendingAnswer(target, { amounts: ['30.00', '20.00', '19.19'] })).toEqual({});
    expect(validatePendingAnswer(target, { amounts: ['26.69', '0.00', '2'] })).toEqual({ 'segment-2': ALLOCATION_ERRORS.amount, 'segment-3': ALLOCATION_ERRORS.amount });
    expect(validatePendingAnswer(target, { amounts: ['26.69'] })).toEqual({ allocation: ALLOCATION_ERRORS.missing });
    expect(validatePendingAnswer(target, { choice: 'exclude' })).toEqual({ allocation: ALLOCATION_ERRORS.missing });
    // 「认不出」留下的 given_up 项不接受任何答复（出路是排除材料或追加行程单）。
    expect(validatePendingAnswer({ kind: 'given_up', fields: [], choices: [] }, { choice: 'exclude' })).toEqual({ item: PENDING_ANSWER_ERRORS.notAnswerable });
    expect(PendingAnswerSchema.safeParse({ amounts: ['1.00'] }).success).toBe(true);
    expect(PendingAnswerSchema.safeParse({ giveUp: true }).success).toBe(true);
    expect(PendingAnswerSchema.safeParse({ giveUp: false }).success).toBe(false);
  });

  test('逐段金额被改过时，mock 服务端按比例重拆税额（余数归最大段），不含税金额 = 价税合计 - 税额', async () => {
    const adapter = createMockAdapter({ seed: 'pending', fault: null, allocationRequired: true });
    const before = await adapter.getSnapshot('T1');
    const outcome = await adapter.answerPendingItem('T1', 'p1', { amounts: ['30.00', '20.00', '19.19'] }, before.step.stepToken);
    expect(outcome.ok).toBe(true);
    let snapshot = await adapter.getSnapshot('T1');
    const answers = [
      ['p2', { origin: '张江高科', destination: '漕河泾开发区' }],
      ['p3', { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' }],
      ['p4', { choice: 'exclude' }],
      ['stay_screenshot_missing.m01', { choice: 'confirm_none' }],
    ] as const;
    for (const [itemId, answer] of answers) {
      snapshot = await adapter.getSnapshot('T1');
      expect((await adapter.answerPendingItem('T1', itemId, answer, snapshot.step.stepToken)).ok).toBe(true);
    }
    snapshot = await adapter.getSnapshot('T1');
    const amap = snapshot.lines.slice(0, 3);
    expect(amap.map((line) => [line.grossAmount, line.netAmount, line.taxAmount])).toEqual([
      ['30.00', '29.12', '0.88'],
      ['20.00', '19.42', '0.58'],
      ['19.19', '18.64', '0.55'],
    ]);
    // The review's total only comes with its digest (after project assignment); here the lines carry it.
    expect(snapshot.confirmation.grossTotal).toBeNull();
    expect(snapshot.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0)).toBe(397259);
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
    expect(TASK_STAGES).toEqual(['upload', 'inventory', 'pending', 'project', 'catalog', 'preparation', 'review', 'actions', 'erp', 'done', 'reconcile', 'voided']);
    expect(TaskStageSchema.safeParse('print').success).toBe(false);
    expect(readMockOptions('?seed=review&fault=readback-mismatch')).toEqual({ seed: 'review', fault: 'readback-mismatch' });
    expect(readMockOptions('?seed=nope&fault=nope')).toEqual({ seed: null, fault: null });
    // ?location=unavailable 不是故障，与 seed/fault 并列。
    expect(readMockOptions('?seed=review&location=unavailable')).toEqual({ seed: 'review', fault: null, locationUnavailable: true });
    // 票面写的 ?seed=assign 是 project 的别名。
    expect(readMockOptions('?seed=assign')).toEqual({ seed: 'project', fault: null });
    expect(readMockOptions('?seed=project')).toEqual({ seed: 'project', fault: null });
    // The server never projects the catalog / preparation stages, so they are no seeds.
    expect(readMockOptions('?seed=catalog')).toEqual({ seed: null, fault: null });
    expect(readMockOptions('?seed=preparation')).toEqual({ seed: null, fault: null });
    // ?seed=print：actions 阶段，且打印稿已经生成（打印稿预览不是阶段）。
    expect(readMockOptions('?seed=print')).toEqual({ seed: 'actions', fault: null, printSheet: true });
    expect(FAULTS).toHaveLength(8);
    // ?book=empty：个人项目簿初始为空。
    expect(readMockOptions('?seed=pending&book=empty')).toEqual({ seed: 'pending', fault: null, bookEmpty: true });
    expect(readMockOptions('?book=nope')).toEqual({ seed: null, fault: null });
    // A catalog mismatch is an ERP-job outcome (?fault=catalog-mismatch); the old ?catalog= / ?preparation= are gone.
    expect(readMockOptions('?seed=actions&fault=catalog-mismatch')).toEqual({ seed: 'actions', fault: 'catalog-mismatch' });
    expect(readMockOptions('?catalog=mismatch&preparation=blocked')).toEqual({ seed: null, fault: null });
    // ?allocation=1 / ?duplicate=1：逐段分摊、跨任务重复发票。
    expect(readMockOptions('?seed=pending&allocation=1')).toEqual({ seed: 'pending', fault: null, allocationRequired: true });
    expect(readMockOptions('?duplicate=1')).toEqual({ seed: null, fault: null, duplicateHit: true });
    expect(readMockOptions('?allocation=yes&duplicate=0')).toEqual({ seed: null, fault: null });
  });

  test('个人项目簿夹具通过 schema；状态标签照内核：可选 / 已过期 / 复检未通过 / 项目号不安全', () => {
    const entries = INITIAL_BOOK.map((project) => annotateProject(project, MOCK_TODAY));
    expect(() => ProjectBookSchema.parse({ projects: entries })).not.toThrow();
    expect(entries.map((entry) => entry.statusLabel)).toEqual(['可选', '可选', '可选', '可选', '已过期', '复检未通过']);
    expect(entries.map((entry) => entry.selectable)).toEqual([true, true, true, true, false, false]);
    const unsafe = annotateProject({ number: 'P 1', name: null, expiresOn: null, lastCheckedAt: null, lastVerdict: 'unsafe' }, MOCK_TODAY);
    expect(unsafe.selectable).toBe(false);
    expect(unsafe.statusLabel).toBe('项目号不安全・复检未通过');
    expect(unsafe.statusNote).toBe('项目号含有不能安全查询的字符，请删除后从报销系统重新录入；这个项目号含有不能安全查询的字符，请删除后从报销系统重新录入');
    const unreadable = annotateProject({ number: 'P-1', name: 'x', expiresOn: '2026-02-30', lastCheckedAt: null, lastVerdict: 'confirmed' }, MOCK_TODAY);
    expect(unreadable.statusNote).toBe('过期时间读不出来（2026-02-30），当作已过期');
  });
});
