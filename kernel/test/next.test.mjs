import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../src/state.mjs';

// 每个用例一个独立的数据目录：凭据登记簿落在 BAOX_HOME 里，用例之间不能互相看见。
const freshHome = () => {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-next-'));
  return process.env.BAOX_HOME;
};

const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const other = { displayName: '张三', account: 'zhang.san', tenant: '5f1f13f6dde29e' };

const healthy = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: '22.14.0', nodeMajor: 22,
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
  ...over,
});

const KEY = 'a1b2c3d4e5f60718';

test('七个环境状态各有一步可做，说给用户听的话全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const cases = [
    ['env_node_unsupported', 'tell_user', healthy({ nodeMajor: 20, nodeVersion: '20.11.0' })],
    ['env_chrome_down', 'tell_user', healthy({ cdpUp: false, probe: null })],
    ['env_not_logged_in', 'tell_user', healthy({ probe: { status: 'not_logged_in' }, binding: null })],
    ['env_identity_unknown', 'tell_user', healthy({ probe: { status: 'unknown' }, binding: null })],
    // 第一次认身份走终端表格（confirm_table），不再弹本地页面。
    ['env_identity_unbound', 'confirm_table', healthy({ binding: null })],
    ['env_identity_mismatched', 'tell_user', healthy({ probe: { status: 'matched', identity: other } })],
    ['env_ready', 'done', healthy()],
  ];
  for (const [state, kind, observation] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释，用户追问时才用`);
    if (kind === 'run') {
      assert.ok(Array.isArray(shaped.step.argv) && shaped.step.argv.length >= 3,
        `${state} 的 argv 要是一条完整命令行，模型原样执行，不用自己拼`);
      assert.ok(shaped.step.argv[1].endsWith(path.join('bin', 'baox.mjs')));
    }
  }
});

test('system 默认模式没有 ERP 标签时发 browser-open，而不是要求 ego', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('env_identity_unknown', {
    browserMode: 'system',
    probe: { status: 'no_tab', transport: 'system' },
  });
  assert.equal(shaped.step.kind, 'run');
  assert.equal(shaped.step.argv[2], 'browser-open');
  assert.ok(shaped.step.argv.includes('--url'));
  assert.doesNotMatch(shaped.speak, /BAOX_EGO_TASK_SPACE|ego task space/);
});

test('system 只读能力失败时如实提示，不假装未登录或已登录', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('env_identity_unknown', {
    browserMode: 'system',
    browserReadError: { code: 'BROWSER_AUTOMATION_PERMISSION', message: 'AppleEvents 被拒绝' },
    probe: { status: 'browser_read_unavailable', transport: 'system' },
  });
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.context, /AppleEvents/);
  assert.match(shaped.speak, /浏览器权限/);
  assert.doesNotMatch(shaped.speak, /未登录/);
  assert.doesNotMatch(shaped.speak, /BAOX_EGO_TASK_SPACE/);
});

test('硬阻塞才给 2：等人登录不是硬阻塞', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  assert.equal(stepFor('schema_too_new', healthy({ schemaVersion: SCHEMA_VERSION + 1 })).exit, 2);
  assert.equal(stepFor('env_node_unsupported', healthy({ nodeMajor: 20 })).exit, 2);
  assert.equal(stepFor('env_identity_mismatched', healthy({ probe: { status: 'matched', identity: other } })).exit, 2);
  assert.equal(stepFor('env_not_logged_in', healthy({ probe: { status: 'not_logged_in' } })).exit, 0,
    '在等人，不是被拦住');
  assert.equal(stepFor('env_ready', healthy()).exit, 0);
});

test('落成的状态都要有 step，漏一个就当场报出来', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  // 判定表以外的名字没有对应的一步。缺一步是内核自己的 bug，不是"暂时没顾上"，
  // 所以它当场抛，不悄悄给一个 done。
  // 拿 `archived` 当例子有意为之：它是**任务状态**（0.9.x 在途任务迁移时打的），
  // 不是状态机的状态，喂进来就该被当成不认识的名字。
  assert.throws(() => stepFor('archived', healthy()), /archived/);
});

/** 环境全绿、材料也观测过的那份观测。 */
const withMaterials = (over = {}) => healthy({
  taskObserved: true,
  sourceDir: '/tmp/材料',
  task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
    currentVersionId: 'v-abc', erpWriteState: null },
  inventoryVersionId: 'v-abc',
  inventoryStale: false,
  classificationRecorded: true,
  openItems: [],
  pendingImages: [],
  pendingReadings: [],
  ...over,
});

/** 一份读过、等着用户过目的读数。它是终端那张表格的全部内容。 */
const PENDING_READING = {
  materialId: 'm-1',
  fileName: '发票.png',
  docType: 'invoice',
  docTypeLabel: '发票',
  fields: [
    { key: 'invoiceNumber', label: '发票号码', value: '26427000000640558021' },
    { key: 'totalAmount', label: '价税合计', value: '18.80' },
  ],
  unreadable: ['税额'],
  amountCheck: 'partial',
  notes: null,
};

test('材料这一段每个状态都有一步可做，说给用户听的话全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'abc123' }];
  const cases = [
    ['task_none', 'run', withMaterials({ task: null })],
    ['inventory_stale', 'run', withMaterials({ inventoryStale: true })],
    ['classify_pending', 'run', withMaterials({ classificationRecorded: false })],
    ['image_awaiting_reading', 'extract_images', withMaterials({ pendingImages: images })],
    ['reading_rejected', 'read_images', withMaterials({
      pendingImages: [{ ...images[0], rejection: { reasons: ['不含税金额 + 税额 ≠ 价税合计'] } }] })],
    ['reading_stale', 'extract_images', withMaterials({ pendingImages: images })],
    ['reading_awaiting_confirmation', 'confirm_table',
      withMaterials({ pendingReadings: [PENDING_READING] })],
    ['duplicate_blocked', 'tell_user', withMaterials()],
    ['events_pending', 'run', withMaterials()],
  ];
  for (const [state, kind, observation] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释`);
    assert.equal(shaped.exit, 0, `${state} 不是硬阻塞`);
    if (kind === 'run') {
      assert.ok(shaped.step.argv.includes('--dir') && shaped.step.argv.includes('/tmp/材料'),
        `${state} 的 argv 要指着这批材料，模型不用自己拼`);
    }
  }
});

test('PDF 候选读取严格使用 Markdown，不携带或要求打开页图', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [{
    kind: 'markdown_candidate_required', blocking: true, materialId: 'm-pdf', fileName: '发票.pdf',
    relPath: '发票.pdf', sourcePath: '/tmp/材料/发票.pdf',
    artifactPath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.artifact.json',
    markdownPath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.md',
    numberedMarkdownPath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.numbered.md',
    templatePath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.candidate.template.json',
    candidatePath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.candidate.json',
    candidateRecordPath: '/tmp/ws/pdf-markdown/v-abc/m-pdf.candidate.record.json',
    markdownHash: 'a'.repeat(64), hint: '请提交候选',
  }];
  const { step, speak } = stepFor('pdf_markdown_candidate_required', withMaterials(), blockedBy);
  assert.equal(step.kind, 'read_markdown');
  assert.equal(step.outsourceable, true);
  assert.ok(step.argv.includes('markdown-ingest'));
  assert.ok(step.argv.includes('/tmp/材料'));
  assert.ok(fs.existsSync(step.schemaPath));
  assert.ok(fs.existsSync(step.templateSchemaPath));
  assert.equal('sourcePath' in step.materials[0], false);
  assert.equal(step.materials[0].numberedMarkdownPath, blockedBy[0].numberedMarkdownPath);
  assert.equal('sourcePages' in step.materials[0], false);
  assert.doesNotMatch(step.instructions, /sourcePages|页图|打开.*PDF|回看.*PDF/);
  assert.match(step.instructions, /numberedMarkdownPath/);
  assert.match(speak, /核对 PDF/);
});

test('PDF 转换空结果给用户处置，运行时失败允许明确重试', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const item = { kind: 'markdown_conversion_empty', blocking: true, materialId: 'm-pdf',
    fileName: '扫描件.pdf', relPath: '扫描件.pdf', sourcePath: '/tmp/材料/扫描件.pdf' };
  const empty = stepFor('pdf_markdown_conversion_empty', withMaterials(), [item]);
  assert.equal(empty.step.kind, 'tell_user');
  assert.match(empty.speak, /电子发票原件/);
  const failed = stepFor('pdf_markdown_conversion_failed', withMaterials(), [
    { ...item, kind: 'markdown_conversion_failed', error: { code: 'RUNTIME', message: 'locked runtime' } },
  ]);
  assert.equal(failed.step.kind, 'run');
  assert.ok(failed.step.argv.includes('markdown-convert'));
  assert.match(failed.speak, /更换文件/);
});

test('要人亲手表态和模型亲眼读图的步骤，明说不能外包给环境子 Agent', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  // 契约说 kind: "run" 的连续段可以外包。要人亲手表态的步骤和已经进入材料阶段的
  // 看图步骤都必须回到主会话，所以写进 JSON，不是只写在 Skill 的说明里。
  assert.equal(stepFor('env_identity_unbound', healthy({ binding: null })).step.outsourceable, false);
  assert.equal(stepFor('reading_awaiting_confirmation',
    withMaterials({ pendingReadings: [PENDING_READING] })).step.outsourceable, false);
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'abc123' }];
  for (const state of ['image_awaiting_reading', 'reading_rejected', 'reading_stale']) {
    const observation = withMaterials({ pendingImages: state === 'reading_rejected'
      ? [{ ...images[0], rejection: { reasons: ['读数未通过'] } }]
      : images });
    assert.equal(stepFor(state, observation).step.outsourceable, false, `${state} 不能由环境子 Agent 继续做`);
  }
  // ego task space 不可用时需要用户恢复环境，不能由环境子 Agent 代办。
  assert.equal(stepFor('env_chrome_down', healthy({ cdpUp: false, probe: null })).step.kind, 'tell_user');
  assert.equal(stepFor('classify_pending', withMaterials({ classificationRecorded: false })).step.outsourceable,
    true);
});

test('跨任务重复：停整批，两边的任务都摆出来', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [
    { kind: 'duplicate_across_tasks', fileName: '发票.pdf', hint: '这张发票在任务 abc123 里也在',
      resolvableBy: 'user', blocking: true },
    { kind: 'history_scope_local', fileName: null, hint: '只比对了本机记过的任务',
      resolvableBy: 'kernel', blocking: false },
  ];
  const shaped = stepFor('duplicate_blocked', withMaterials(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.speak, /发票\.pdf/);
  assert.match(shaped.speak, /abc123/, '另一个任务是哪个，得说出来，不然用户没法裁决');
  assert.doesNotMatch(shaped.speak, /只比对了本机记过的任务/, '范围声明留在 context 和 blockedBy 里');
});

test('待办这一步逐条说清楚谁能解决它，一条都不含糊', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [
    { kind: 'read_error', fileName: '坏了.pdf', hint: '文件打不开', resolvableBy: 'user', blocking: true },
    { kind: 'no_text_in_pdf', fileName: '扫描件.pdf', hint: '取不到文字', resolvableBy: 'user', blocking: true },
    { kind: 'extension_mismatch', fileName: '其实是png.pdf', hint: '扩展名对不上',
      resolvableBy: 'kernel', blocking: false },
  ];
  const shaped = stepFor('intake_open_items', withMaterials(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.speak, /坏了\.pdf/);
  assert.match(shaped.speak, /扫描件\.pdf/);
  assert.match(shaped.speak, /要你处理/, '每条都得说清楚谁能解决它');
  assert.doesNotMatch(shaped.speak, /其实是png\.pdf/, '不拦路的那条不念给用户听，留在 blockedBy 里');
  assert.equal(shaped.exit, 0, '待办是在等人处理，不是被内核拦住');
});

test('图片提取工单把输入、输出、模板和提交命令一次给全', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [
    { materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png', format: 'png', contentHash: 'aa' },
    { materialId: 'm-2', fileName: '行程单.png', absPath: '/tmp/材料/行程单.png', format: 'png', contentHash: 'bb' },
  ];
  const { step, speak } = stepFor('image_awaiting_reading', withMaterials({ pendingImages: images }));
  assert.equal(step.kind, 'extract_images');
  assert.equal(step.skill, 'extract-reimbursement-images');
  assert.equal(step.images.length, 2);
  assert.equal(step.images[0].absPath, '/tmp/材料/发票.png', '模型要拿绝对路径才打得开图');
  assert.ok(step.images[0].contentHash, '读数钉在这张图当前的字节上');
  assert.ok(fs.existsSync(step.schemaPath), '模板得是一份真存在的文件，不是一句说明');
  assert.equal(step.readingsPath, path.join('/tmp/ws', 'reading-submission.json'));
  assert.equal(step.requestPath, path.join('/tmp/ws', 'image-extraction-request.json'));
  assert.deepEqual(step.request.images.map((image) => image.materialId), ['m-1', 'm-2']);
  assert.match(step.extractionPath, /image-extraction-result\.json$/);
  assert.match(step.resultPath, /image-extraction-submit\.json$/);
  assert.ok(step.argv.includes(step.readingsPath), '写到哪、交哪个文件，是同一个路径');
  assert.ok(step.argv.includes('ocr-submit'));
  assert.match(speak, /发票\.png/, '要看哪几张图，念出来');
});

test('模型视觉回退的凭据闭集跟着图片提取工单一起给', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa' }];
  const { step, context } = stepFor('image_awaiting_reading', withMaterials({ pendingImages: images }));
  assert.deepEqual(step.sightedShapes.map((s) => s.shape),
    ['tall', 'portrait', 'square', 'landscape', 'wide']);
  assert.ok(step.sightedShapes.every((s) => s.label), '每一档都得有一句人话，光给英文词没用');
  assert.match(context, /模型视觉/);
});

test('看图 step 直接给出完整字段闭集，不用反查 vision.mjs', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '行程单.png', absPath: '/tmp/材料/行程单.png',
    format: 'png', contentHash: 'aa' }];
  const { step } = stepFor('image_awaiting_reading', withMaterials({ pendingImages: images }));
  const expectedFields = ['invoiceNumber', 'issueDate', 'netAmount', 'taxAmount', 'totalAmount',
    'sellerName', 'buyerName', 'itemName', 'city', 'travelDate', 'origin', 'destination',
    'travelTime', 'traveler', 'trainNumber', 'seat', 'hotelName', 'guestName',
    'checkIn', 'checkOut', 'folioTotal', 'payer', 'payee', 'paidAt',
    'transactionNumber', 'title', 'merchant'];

  assert.deepEqual(Object.keys(step.readingContract.docTypes),
    ['invoice', 'rail_ticket', 'road_passenger_ticket', 'ride_itinerary', 'hotel_folio', 'payment_slip', 'other', 'unreadable']);
  for (const docType of Object.values(step.readingContract.docTypes)) {
    assert.deepEqual(docType.allowedFields, expectedFields);
  }
  assert.deepEqual(step.readingContract.docTypes.invoice.requiredFields,
    ['invoiceNumber', 'totalAmount']);
  assert.equal(step.readingContract.minimumFields, 1, '完整图片不能交空读数');
  assert.deepEqual(step.readingContract.amountConservation.whenPresent,
    ['netAmount', 'taxAmount', 'totalAmount']);
  assert.match(step.readingContract.amountConservation.rule, /禁止改数凑平/);
  assert.equal(step.readingContract.additionalFields, false, 'schema 外字段必须明确拒绝');
  const segments = step.readingContract.docTypes.ride_itinerary.segments;
  assert.deepEqual(step.readingContract.docTypes.ride_itinerary.requiredOrUnreadable, ['totalAmount']);
  assert.deepEqual(step.readingContract.docTypes.ride_itinerary.flatItinerary.requiredOrUnreadable,
    ['travelDate']);
  assert.match(step.readingContract.docTypes.ride_itinerary.flatItinerary.note, /不能用 issueDate 代替/);
  assert.equal(segments.type, 'array');
  assert.equal(segments.minItems, 1);
  assert.equal(segments.additionalFields, false);
  assert.deepEqual(Object.keys(segments.fields),
    ['travelDate', 'city', 'origin', 'destination', 'amount']);
  assert.deepEqual(Object.entries(segments.fields)
    .filter(([, rule]) => rule.required).map(([field]) => field),
  ['travelDate', 'origin', 'destination']);
  assert.match(step.readingContract.multipleTrips, /segments.*逐段/,
    '多段行程按契约逐段抄写，不能压成一个单段字段');
});

test('证据歧义待办显示凭证与候选参考材料的 materialId 和文件名', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('intake_open_items', withMaterials(), [{
    kind: 'evidence_ambiguous', blocking: true, resolvableBy: 'user',
    materialId: 'm-voucher', references: [
      { materialId: 'm-ref-a', fileName: '行程单一.pdf' },
      { materialId: 'm-ref-b', fileName: '行程单二.pdf' },
    ], hint: '证据归属不唯一',
  }]);
  assert.match(shaped.speak, /m-voucher/);
  assert.match(shaped.speak, /m-ref-a\/行程单一\.pdf/);
  assert.match(shaped.speak, /m-ref-b\/行程单二\.pdf/);
});

test('分类明细确认表完整展示住宿入住和离店日期', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('classified_detail_confirmation', withMaterials({
    task: { taskId: 'task-hotel', identity: me, workspace: '/tmp/ws' },
    classifiedPreview: {
      versionId: 'v-hotel', homeCity: '广州', evidence: [],
      lines: [{ lineId: 'ev-01', maskedNumber: '****1234', kind: 'vat_common',
        date: '2026-08-09', checkOut: '2026-08-22', endDate: '2026-08-22',
        route: '酒店', totalAmount: '3640.00', categoryLabel: '住宿',
        expenseItemCode: 'FY010001', referenceMaterialIds: ['m-folio'] }],
    },
  }));
  assert.match(shaped.step.table, /2026-08-09 至 2026-08-22/);
});

test('分类明细确认表展示每张发票的票据类型和三项票面金额', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('classified_detail_confirmation', withMaterials({
    task: { taskId: 'task-rail', identity: me, workspace: '/tmp/ws' },
    classifiedPreview: {
      versionId: 'v-rail', homeCity: '广州',
      evidence: [{ materialId: 'm-rail', role: 'primary_voucher', kind: 'rail_eticket',
        fields: { invoiceNumber: '26349119423005877606',
          netAmount: null, taxAmount: null, totalAmount: { text: '703.00', cents: 70300 } } }],
      lines: [{ lineId: 'ev-01', voucherMaterialId: 'm-rail', maskedNumber: '********7606',
        kind: 'rail_eticket', date: '2026-09-02',
        totalAmount: '703.00', categoryLabel: '城际交通', expenseItemCode: 'FY010001',
        referenceMaterialIds: [] }],
    },
  }));
  assert.match(shaped.step.table, /票据类型/);
  assert.match(shaped.step.table, /铁路电子客票/);
  assert.match(shaped.step.table, /不含税金额/);
  assert.match(shaped.step.table, /税额/);
  assert.match(shaped.step.table, /价税合计/);
  assert.match(shaped.step.table, /无需读取/);
  assert.match(shaped.step.table, /0\.00（业务默认）/);
  assert.match(shaped.step.table, /703\.00/);
  assert.match(shaped.speak, /发票类型、不含税金额、税额和价税合计/);
  assert.match(shaped.speak, /只核对票面总额/);
  assert.doesNotMatch(shaped.speak, /待ERP|需在 ERP/);
});

test('被驳回的读数：重读时把上次没过的理由原样带上', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa',
    rejection: { reasons: ['不含税金额 + 税额 ≠ 价税合计；请重新逐字核对票面'] } }];
  const { step, speak, context } = stepFor('reading_rejected', withMaterials({ pendingImages: images }));
  assert.equal(step.kind, 'read_images');
  assert.deepEqual(step.images[0].previousRejection, images[0].rejection.reasons);
  assert.match(speak, /发票\.png/);
  assert.match(speak, /价税合计/, '为什么没过，要念给用户听');
  // 守恒式不平的处置是重读或判定读不出，绝不是把某一位数字改到平。
  assert.match(context, /凑平/);
});

test('确认这一步：内核渲染好一整块表格，模型只负责搬运', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const { step, speak, context } = stepFor('reading_awaiting_confirmation',
    withMaterials({ pendingReadings: [PENDING_READING] }));

  assert.equal(step.kind, 'confirm_table');
  assert.ok(step.table.includes('26427000000640558021'), '要比对的值必须完整出现在表里');
  assert.ok(step.table.includes('发票号码'), '给用户看中文名，不给键名');
  assert.ok(step.table.includes('看不清'), '认不出的字段也要让用户知道，不是留白');
  assert.match(step.table, /^\| .* \|$/m);
  assert.match(step.table, /^\| --- /m, '必须有 Markdown 对齐行');
  assert.doesNotMatch(step.table, /[┌┬┐├┼┤└┴┘│─]/);

  assert.deepEqual(step.materialIds, ['m-1'], '这一次点头覆盖哪几份材料，说死');
  assert.ok(step.correctionPath.endsWith('reading-correction.json'));
  assert.ok(step.correctionPath !== step.readingsPath);
  // 全程不弹浏览器：这一步里不该有任何一条要跑的命令，也不该有地址要念。
  assert.equal(step.argv, undefined);
  assert.doesNotMatch(speak + context, /打开一个本地|http:\/\/|127\.0\.0\.1|localhost/);
  assert.match(context, /确认只来自你在这里的表态/);
  assert.match(context, /不需要你打开任何网页/, '这件事要明说，不是让用户自己发现');
});

test('确认这一步收得下纠正 —— 用户指错不该被悄悄丢掉', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = withMaterials({
    openItems: [{ kind: 'reading_awaiting_confirmation', materialId: 'm-1',
      fileName: '发票.png', blocking: true }],
    pendingReadings: [PENDING_READING],
  });
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.state, 'reading_awaiting_confirmation');
  assert.equal(first.actor, 'user');

  const back = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasCorrection: true });
  assert.equal(back.ignored, undefined, 'confirm_table 上的纠正是有处安放的');
});

test('图没读完不算读完：交不出结果，状态一步不动', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa' }];
  const observation = withMaterials({
    openItems: [{ kind: 'image_awaiting_reading', materialId: 'm-1', fileName: '发票.png', blocking: true }],
    pendingImages: images,
  });
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.state, 'image_awaiting_reading');
  assert.equal(first.actor, 'model');

  const claimed = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(claimed.ignored.reason, 'no_result', '说看过了不算看过了');
  assert.equal(claimed.state, 'image_awaiting_reading');
  assert.deepEqual(claimed.step, first.step);
});

test('每条应答都带着任务，没有任务就是 null', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const r = nextResponse({ observation: withMaterials(), sourceKey: KEY });
  assert.deepEqual(r.task, { taskId: '75dc9cbb4d', sourceLabel: '材料', sourceDir: '/tmp/材料' });
  assert.equal(r.progress.of, 10);

  const none = nextResponse({ observation: withMaterials({ task: null }), sourceKey: KEY });
  assert.equal(none.task, null, '不给一个看起来像任务的空壳');
});

test('幂等：连着问三次，同一个状态、同一个凭据', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const a = nextResponse({ observation, sourceKey: KEY });
  const b = nextResponse({ observation, sourceKey: KEY });
  const c = nextResponse({ observation, sourceKey: KEY });
  assert.equal(a.state, 'env_not_logged_in');
  assert.equal(b.state, a.state);
  assert.equal(c.state, a.state);
  assert.equal(b.stepToken, a.stepToken);
  assert.equal(c.stepToken, a.stepToken);
  assert.deepEqual(b.step, a.step);
  assert.equal(b.speak, a.speak);
});

test('状态一变就换新凭据，旧的当场作废', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const down = nextResponse({ observation: healthy({ cdpUp: false, probe: null }), sourceKey: KEY });
  const up = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY });
  assert.equal(down.state, 'env_chrome_down');
  assert.equal(up.state, 'env_identity_unbound');
  assert.notEqual(up.stepToken, down.stepToken);

  // 拿着上一步的凭据回来：忽略回传，重发当前步骤。不报错，也不惩罚。
  const again = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY,
    after: down.stepToken, hasResult: true });
  assert.equal(again.exit, 0, '不可跳步是机制，不是错误');
  assert.equal(again.ignored.reason, 'stale_token');
  assert.equal(again.state, 'env_identity_unbound');
  assert.equal(again.stepToken, up.stepToken, '重发的就是当前那一步，凭据也还是当前那个');
});

test('过期凭据被忽略后，状态一步没动', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const bogus = nextResponse({ observation, sourceKey: KEY, after: 'deadbeef'.repeat(4), hasResult: true });
  assert.equal(bogus.ignored.reason, 'stale_token');
  assert.equal(bogus.state, first.state);
  assert.equal(bogus.stepToken, first.stepToken);
});

test('模型声称做完但没交结果时，状态不前进', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = withMaterials({ classificationRecorded: false }); // 该跑 classify 的那一步
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.step.kind, 'run');

  const claimed = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(claimed.ignored.reason, 'no_result');
  assert.equal(claimed.state, 'classify_pending', '嘴上说跑完了，分类仍没有落盘');
  assert.equal(claimed.stepToken, first.stepToken);
  assert.deepEqual(claimed.step, first.step);
});

test('交了结果也不算数：状态只认这一次的观测', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const down = healthy({ cdpUp: false, probe: null });
  const first = nextResponse({ observation: down, sourceKey: KEY });
  // 结果交上来了，但 Chrome 实际还是没起来 —— 状态照旧。
  const still = nextResponse({ observation: down, sourceKey: KEY, after: first.stepToken, hasResult: true });
  assert.equal(still.state, 'env_chrome_down');
  assert.equal(still.stepToken, first.stepToken);
  assert.equal(still.ignored, undefined, '这次回传本身是合规的，只是世界没变');
});

test('tell_user 不需要结果，直接再问一次就行', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const again = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(again.ignored, undefined, '等人做完的那种步骤，本来就没有结果可交');
  assert.equal(again.state, 'env_not_logged_in');
});

test('从登录页一路走到环境就绪，ego task space 只等待用户动作', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  // ego task space 已可用，页面停在登录页 —— 停下等人。
  let r = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' }, binding: null }),
    sourceKey: KEY });
  assert.equal(r.state, 'env_not_logged_in');
  assert.equal(r.step.kind, 'tell_user');

  // 人登进去了，但这台机器还没绑过身份 —— 在终端上摆一张表请他认。
  r = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY, after: r.stepToken });
  assert.equal(r.state, 'env_identity_unbound');
  assert.equal(r.step.kind, 'confirm_table');

  // 绑完，环境就绪。
  r = nextResponse({ observation: healthy(), sourceKey: KEY, after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'env_ready');
  assert.equal(r.step.kind, 'done');
  assert.equal(r.exit, 0);
});

test('环境这一段没有可纠正的读数，纠正不被悄悄收下', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const r = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasCorrection: true });
  assert.equal(r.ignored.reason, 'correction_not_applicable',
    '收下一份没处安放的纠正而不吭声，会让用户以为自己的改动被采纳了');
  assert.equal(r.state, 'env_not_logged_in');
});

test('每一条应答都自带身份和契约字段', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const r = nextResponse({ observation: healthy(), sourceKey: KEY });
  assert.equal(r.command, 'next');
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(r.identity, { displayName: '刘明建', account: 'luo.liu' },
    '每次都带身份：绑错了人，下一句话就暴露');
  assert.equal(r.actor, null);
  assert.ok(r.stepToken.length === 32, '16 字节 hex');
  assert.deepEqual(r.blockedBy, []);
  assert.ok('task' in r);
  assert.ok('progress' in r);
  assert.deepEqual(r.interaction, {
    templateId: 'workflow.ready', version: 1, status: 'completed',
  });
});

test('还没登录时，身份退回这台机器绑过的那一个，读不出就是 null', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const bound = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' } }), sourceKey: KEY });
  assert.deepEqual(bound.identity, { displayName: '刘明建', account: 'luo.liu' });

  const blank = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' }, binding: null }),
    sourceKey: KEY });
  assert.equal(blank.identity, null, '不知道就是不知道，不给一个看起来像身份的东西');
});

test('两个材料目录各记各的凭据，互不串台', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const a = nextResponse({ observation: healthy({ binding: null }), sourceKey: 'aaaa1111bbbb2222' });
  const b = nextResponse({ observation: healthy({ cdpUp: false, probe: null }), sourceKey: 'cccc3333dddd4444' });
  assert.notEqual(a.stepToken, b.stepToken);
  const backToA = nextResponse({ observation: healthy({ binding: null }), sourceKey: 'aaaa1111bbbb2222' });
  assert.equal(backToA.stepToken, a.stepToken);
});

// —— 主干后半段：事件、分摊、项目、核对、写入前确认 ——

/** 后半段观测。它比材料那一段多出事件、明细、核对和待写内容。 */
const withErp = (over = {}) => withMaterials({
  eventsRecorded: true,
  events: { versionId: 'v-abc', events: [], lineItems: [], notes: [] },
  allocationRound: null,
  selectionApplied: true,
  lines: [{ lineId: 'ev-01', voucherMaterialId: 'm-1', maskedNumber: '2642****8021',
    date: '2026-07-09', city: '北京市', route: '北京南站 → 望京', netAmount: '25.91',
    taxAmount: '0.78', totalAmount: '26.69', amountSource: 'itinerary_conserved',
    categoryLabel: '本地市内交通', project: '111454' }],
  homeCity: '北京市',
  purpose: '七月出差交通费',
  catalogFresh: true,
  catalogProblems: [],
  writePreview: { lines: [], homeCity: '北京市', purpose: '七月出差交通费', versionId: 'v-abc' },
  writeApproved: false,
  ...over,
});

const preparationFixture = ({ digest = 'preparation-digest-1', ready = true,
  purpose = '七月出差交通费', problems = [] } = {}) => ({
  digest,
  ready,
  problems,
  document: {
    phase: 'pre-erp',
    status: ready ? 'ready_for_preparation' : 'draft',
    task: { taskId: '75dc9cbb4d', versionId: 'v-abc' },
    identity: me,
    purpose,
    homeCity: '北京市',
    lines: [{
      lineId: 'ev-01', eventId: 'event-1', voucherMaterialId: 'm-1',
      kind: 'passenger_transport', kindLabel: '客运交通', date: '2026-07-09',
      city: '北京市', route: '北京南站 → 望京', projectCode: '111454', projectName: '测试项目',
      projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
      expenseItemCode: 'FY008001', expenseItemName: '本地市内交通',
      expenseItemSource: 'erp_catalog_confirmed', invoiceType: '增值税发票',
      invoiceTypeSource: 'save-contract', netCents: 2591, taxCents: 78, totalCents: 2669,
      amountSource: 'itinerary_conserved', sourceRefs: [],
    }],
    invoices: [{ materialId: 'm-1', fileName: '发票.pdf', targetPath: 'invoices/m-1.pdf',
      identity: { number: '26427000000640558021' }, contentHash: 'h1' }],
    evidence: [], excluded: [], problems, digest,
  },
});

const withPreparation = (over = {}) => withErp({
  preparation: preparationFixture(),
  preparationPackageCurrent: true,
  preparationPackage: {
    directory: '/tmp/ws/preparation/preparation-digest-1',
    files: { detailJson: '/tmp/detail.json', detailMarkdown: '/tmp/detail.md',
      manifest: '/tmp/manifest.json' },
    manifestHash: 'manifest-hash-1', bundleHash: 'bundle-hash-1',
  },
  preparationConfirmed: false,
  ...over,
});

const askRound = (over = {}) => ({
  materialId: 'm-inv', fileName: '合并发票.pdf', contentHash: 'h1',
  segmentCount: 3, totalAmount: '69.19', netAmount: '67.18', taxAmount: '2.01',
  stale: false, answered: [], remaining: 3, rejection: null,
  questions: [
    { id: 'm-inv#1', header: '第 1 段', question: '第 1 段（2026-07-09 北京市）的价税合计是多少？',
      options: [{ label: '26.69' }, { label: '这张票我认不出' }, { label: '其他' }], multiSelect: false },
    { id: 'm-inv#2', header: '第 2 段', question: '第 2 段的价税合计是多少？',
      options: [{ label: '20.85' }, { label: '这张票我认不出' }, { label: '其他' }], multiSelect: false },
  ],
  ...over,
});

test('后半段每个状态也各有一步可做，话仍然全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const cases = [
    ['events_pending', 'run', withErp({ eventsRecorded: false })],
    ['allocation_required', 'ask_user', withErp({ allocationRound: askRound() })],
    ['allocation_stale', 'ask_user', withErp({ allocationRound: askRound({ stale: true }) })],
    ['project_unassigned', 'run',
      withErp({ lines: [{ lineId: 'ev-01', totalAmount: '26.69', project: null }] })],
    ['project_book_empty', 'run', withErp({ selectionApplied: false,
      projectBook: { empty: true } })],
    ['catalog_unverified', 'run', withErp({ catalogFresh: false })],
    ['preparation_package_pending', 'run', withPreparation({ preparationPackageCurrent: false })],
    ['preparation_blocked', 'tell_user', withPreparation({
      preparation: preparationFixture({ ready: false,
        problems: [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }] }),
    }), 2],
    ['preparation_confirmation', 'confirm_table', withPreparation()],
    ['preparation_complete', 'done', withPreparation({ preparationConfirmed: true })],
    ['handed_off_recover', 'run', withErp({
      task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
        erpWriteState: 'upload_dispatched' } })],
  ];
  for (const [state, kind, observation, expectedExit = 0] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释`);
    assert.equal(shaped.exit, expectedExit, `${state} 的退出码`);
    if (kind === 'run') {
      if (state === 'project_book_empty') {
        assert.ok(shaped.step.argv.includes('projects-page'), '空册要打开本人项目簿维护页');
      } else if (state === 'project_unassigned') {
        assert.ok(shaped.step.argv.includes('select-task'), '项目未指定要打开任务选择页');
      } else {
        assert.ok(shaped.step.argv.includes('--dir') && shaped.step.argv.includes('/tmp/材料'),
          `${state} 的 argv 要指着这批材料，模型不用自己拼`);
      }
    }
  }
});

test('对话提问的形状是硬的：至多四题，每题二到四个选项，末项恒为「其他」', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('allocation_required', withErp({ allocationRound: askRound() }));
  const qs = shaped.step.questions;
  assert.ok(qs.length >= 1 && qs.length <= 4, '一轮至多四题');
  for (const q of qs) {
    assert.ok(q.id && q.question, '每题要有 id 和问法');
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id} 的选项要在 2–4 之间`);
    assert.equal(q.options.at(-1).label, '其他', '末项恒为「其他」，永远留一个自由输入口');
  }
  assert.equal(shaped.step.outsourceable, false, '在对话里问这一步子 Agent 做不了：那里没有用户');
  // 问题整块由内核渲染，模型原样贴出去 —— 不走任何提问工具，也不让模型自己组织问法。
  assert.ok(shaped.step.prompt, '问题得渲染成一整块文本放在 step.prompt 里');
  for (const q of qs) {
    assert.ok(shaped.step.prompt.includes(q.question), `${q.id} 的问法要在贴出去的那块里`);
    for (const o of q.options) {
      assert.ok(shaped.step.prompt.includes(o.label), `${q.id} 的选项「${o.label}」不能被吞掉`);
    }
  }
  assert.ok(shaped.step.answersPath, '答案写到哪里由内核定，模型不选地方');
  assert.ok(shaped.step.answersFormat.answers.some((a) => a.giveUp === true),
    '「我认不出」要有一条明确的回传形状，而且和别的答案写在同一处 —— '
    + '另起一个顶层键，模型照着写就会被判成"这几段没答"');
  assert.match(shaped.speak, /69\.19/, '加起来该是多少，得摆在眼前');
  assert.match(shaped.speak, /不会平均|不会按比例/, '内核不替用户分摊这句话要说出口');
});

test('分摊问到一半：已经定下来的那几段摆出来，还剩几段也说清楚', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('allocation_required', withErp({
    allocationRound: askRound({ answered: [{ index: 1, amount: '26.69' }], remaining: 2,
      questions: [askRound().questions[1]] }),
  }));
  assert.match(shaped.speak, /第 1 段 26\.69 元/, '他上一轮说过什么，要看得见');

  // 上一轮没收下时，理由原样念出来 —— 不说的话用户不知道自己在重答什么。
  const again = stepFor('allocation_required', withErp({
    allocationRound: askRound({ rejection: { reasons: ['逐段价税合计相加 69.20，与票面价税合计 69.19 差 0.01'] } }),
  }));
  assert.match(again.speak, /差 0\.01/);
});

test('项目未指定：如实报出来，并说清楚问法还没定 —— 不假装问了一个不存在的问题', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('project_unassigned', withErp({
    lines: [{ lineId: 'ev-01', totalAmount: '26.69', project: null },
      { lineId: 'ev-02', totalAmount: '20.85', project: null }],
  }));
  assert.equal(shaped.step.kind, 'run',
    '由内核发出任务选择页，不能靠对话里的项目号绕过提交门禁');
  assert.ok(shaped.step.argv.includes('select-task'));
  assert.match(shaped.speak, /项目选择页/);
  assert.equal(shaped.progress.label, '项目归属');
});

test('ERP 里查无此项目 —— 硬停，退出码 2，并说清是哪个号', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [{ kind: 'catalog_mismatch', number: '999999', verdict: 'missing',
    hint: '项目号 999999 在 ERP 项目目录里查不到', resolvableBy: 'user', blocking: true }];
  const shaped = stepFor('catalog_mismatch', withErp(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.step.table, /999999/, 'tell_user 的表格必须出现在 step.table');
  assert.equal(shaped.exit, 2, '拿一个不存在的项目号建单，错误只会在保存那一刻暴露');
  assert.match(shaped.speak, /999999/);
});

test('准备确认表：摆全、绑定交接包、且收不下任何改值', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('preparation_confirmation', withPreparation());
  assert.equal(shaped.step.kind, 'confirm_table');
  assert.equal(shaped.step.acceptsCorrection, false,
    '准备确认不接受对话内改值，改动后必须重新生成并核验交接包');
  assert.equal(shaped.step.outsourceable, false);
  assert.match(shaped.step.table, /111454/, '项目号要摆在表里 —— 它就是用户要核对的东西之一');
  assert.match(shaped.step.table, /26\.69/);
  assert.match(shaped.speak, /逐项核对发票/);
  assert.ok(shaped.stepMeta.preparationDigest, '凭据钉在这一份准备材料上');
  assert.equal(shaped.stepMeta.packageManifestHash, 'manifest-hash-1');
  assert.equal(shaped.stepMeta.packageBundleHash, 'bundle-hash-1');

  // 内容变一个字，凭据的身份就变了 —— 他点的头只对他看过的那一份有效。
  const other = stepFor('preparation_confirmation', withPreparation({
    preparation: preparationFixture({ digest: 'preparation-digest-2', purpose: '改了事由' }) }));
  assert.notEqual(other.stepMeta.preparationDigest, shaped.stepMeta.preparationDigest);
});

test('确认表和准备缺项都输出标准 Markdown 表格，用户话术只保留状态和下一步', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const markdownTable = (value) => {
    const lines = value.split('\n');
    assert.match(lines[0], /^\| .* \|/);
    assert.match(lines[1], /^\| --- /);
    assert.doesNotMatch(value, /[┌┬┐├┼┤└┴┘│─]/);
  };

  markdownTable(stepFor('env_identity_unbound', healthy({ binding: null })).step.table);
  markdownTable(stepFor('reading_awaiting_confirmation', withMaterials({
    pendingReadings: [PENDING_READING],
  })).step.table);
  markdownTable(stepFor('classified_detail_confirmation', withMaterials()).step.table);
  markdownTable(stepFor('preparation_confirmation', withPreparation()).step.table);

  const blocked = stepFor('preparation_blocked', withPreparation({
    preparation: preparationFixture({ ready: false,
      problems: [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }] }),
  }), [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }]);
  assert.match(blocked.speak, /^\| .* \|/m);
  assert.match(blocked.speak, /^\| --- /m);
  assert.doesNotMatch(blocked.speak, /^1\. /m);
  assert.match(blocked.speak, /处理完成后告诉我，我会重新核对/);
});

test('确认和待办的 speak 不暴露内部处理原理', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const reading = stepFor('reading_awaiting_confirmation', withMaterials({
    pendingReadings: [PENDING_READING],
  }));
  assert.match(reading.speak, /对照原件/);
  assert.doesNotMatch(reading.speak, /落库|分歧重新看一遍/);

  const classified = stepFor('classified_detail_confirmation', withMaterials({
    classifiedPreview: { lines: [], evidence: [], homeCity: '广州市' },
  }));
  assert.doesNotMatch(classified.speak, /reextract|同 hash|候选/);

  const openItems = stepFor('intake_open_items', withMaterials(), [{
    kind: 'read_error', fileName: '坏了.pdf', hint: '文件打不开',
    resolvableBy: 'user', blocking: true,
  }]);
  assert.doesNotMatch(openItems.speak, /blockedBy|resolvableBy|abandon-task|step\.argv/);

  const identity = stepFor('env_identity_unbound', healthy({ binding: null }));
  assert.match(identity.speak, /核对身份表/);
  assert.doesNotMatch(identity.speak, /step\.argv|task space|stepToken/);

  const preparationBlocked = stepFor('preparation_blocked', withPreparation({
    preparation: preparationFixture({ ready: false,
      problems: [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额' }] }),
  }), [{ code: 'rail_net_tax_missing', message: '铁路票面未提供净额和税额', resolvableBy: 'user' }]);
  assert.match(preparationBlocked.speak, /缺项|处理这些项目/);
  assert.doesNotMatch(preparationBlocked.speak, /argv|resolvableBy|stepToken/);

  const preparationConfirmation = stepFor('preparation_confirmation', withPreparation());
  assert.match(preparationConfirmation.speak, /逐项核对/);
  assert.doesNotMatch(preparationConfirmation.speak, /manifestHash|bundleHash|stepToken/);
});

test('准备确认之后不再重复问，而且明说"还没写进 ERP"', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('preparation_complete', withPreparation({ preparationConfirmed: true }));
  assert.equal(shaped.step.kind, 'done');
  assert.match(shaped.speak, /后续处理会从这里继续/);
});

test('动过 ERP 的任务：先建立本地准备恢复凭据，并说清状态变化', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('handed_off_recover', withErp({
    task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
      erpWriteState: 'upload_dispatched' } }));
  assert.ok(shaped.step.argv.includes('resume-local-preparation'));
  assert.match(shaped.speak, /人工核对/);
});

test('未知 ERP marker 只交接，不冒充已定义的本地恢复协议', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('handed_off_recover', withErp({
    task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
      erpWriteState: 'future_marker' } }));
  assert.equal(shaped.step.kind, 'handoff');
  assert.equal(shaped.step.skill, 'baox-recover');
  assert.match(shaped.speak, /当前报销已暂停/);
});

test('恢复凭据无效时仍停在恢复态，不能落到写入前确认', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const response = nextResponse({
    observation: withErp({
      task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
        erpWriteState: 'upload_dispatched' },
      recovery: { valid: false, status: 'credential_invalid', reasons: ['凭据已过期'] },
      selectionApplied: true, projectBook: { empty: false }, catalogFresh: true,
    }),
    sourceKey: 'source-key',
  });
  assert.equal(response.state, 'handed_off_recover');
  assert.notEqual(response.state, 'ready_for_erp_write');
  assert.equal(response.recovery.valid, false);
});
