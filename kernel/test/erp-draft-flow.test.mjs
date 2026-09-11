import test from 'node:test';
import assert from 'node:assert/strict';
import { linesDigest } from '../src/selection.mjs';
import { approvalCovers } from '../src/erpwrite.mjs';
import {
  buildErpDraftPreview, fillApprovedPreview, formReadbackToken,
  matchReceiptRows, routePlanOf, saveApprovedPreview,
} from '../src/erp-draft-flow.mjs';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const projectNames = ['项目一完整名称', '项目二完整名称', '项目二完整名称', '项目三完整名称'];
const projectCodes = ['39163', '38480', '38480', '37269'];
const expense = [
  ['FY010003', '长途交通'],
  ['FY008001', '本地市内交通'],
  ['FY008001', '本地市内交通'],
  ['FY010001', '住宿'],
];
const facts = [
  ['m-rail', '26427000000640558021', 'SPD-rail', '703.00', '644.95', '58.05'],
  ['m-ride-a', '26327000001570964156', 'SPD-ride-a', '51.63', '50.12', '1.51'],
  ['m-ride-b', '26342000002661673906', 'SPD-ride-b', '18.80', '18.25', '0.55'],
  ['m-hotel', '26349119423005877606', 'SPD-hotel', '3640.00', '3433.96', '206.04'],
];
const invoiceTypes = ['普通发票', '普通发票', '普通发票', '增值税发票'];
const events = facts.map(([materialId], index) => ({
  eventId: `ev-${index + 1}`, voucherMaterialId: materialId,
  kind: ['rail_eticket', 'passenger_transport', 'passenger_transport', 'vat_common'][index],
}));
const built = {
  versionId: 'v-1', events,
  lineItems: facts.map(([materialId, , , total], index) => ({
    lineId: `ev-${index + 1}`, eventId: `ev-${index + 1}`, voucherMaterialId: materialId,
    kind: events[index].kind,
    date: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-09'][index],
    ...(index === 3 ? { endDate: '2026-08-22' } : {}),
    city: index === 3 ? '广州' : index === 0 ? null : '广州',
    route: index === 0 ? '合肥南 → 广州南' : index === 1 ? '番禺广场地铁站D口 → 傍西酒堂' : index === 2 ? '时代天逸 傍西酒堂' : null,
    netAmount: index === 0 ? null : facts[index][4],
    taxAmount: index === 0 ? null : facts[index][5], totalAmount: total,
    category: index === 3 ? 'accommodation' : 'local_city_transport',
    invoiceType: invoiceTypes[index], invoiceTypeSource: 'fixture_mapping',
  })),
};
const lines = built.lineItems.map((line, index) => ({
  ...line, projectCode: projectCodes[index], projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book', projectName: projectNames[index],
  expenseItemCode: expense[index][0], expenseItemName: expense[index][1],
  invoiceType: invoiceTypes[index], invoiceTypeSource: 'fixture_mapping',
  ...(index === 2 ? { origin: '时代天逸', destination: '傍西酒堂', routeSource: 'vision_candidate' } : {}),
}));
const projects = Object.fromEntries(projectCodes.map((code, index) => [code, {
  code, name: projectNames[index === 2 ? 1 : index], verdict: 'confirmed',
}]));
const catalog = {
  versionId: built.versionId, linesDigest: linesDigest(built), identity, projects,
};
const expenseItems = Object.fromEntries(expense.map(([code, name]) => [code,
  { code, name, verdict: 'confirmed' }]));
const task = { taskId: 'task-1', currentVersionId: built.versionId, identity, homeCity: '广州' };
const selection = {
  versionId: built.versionId, linesDigest: linesDigest(built), identity, homeCity: '广州',
  purpose: '客户支持', projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
  projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
};
const receiptCheck = {
  taskId: task.taskId, versionId: built.versionId,
  checks: facts.map(([materialId, invoiceNumber, receiptNumber, gross]) => ({
    materialId, identityKey: `einvoice-20:${invoiceNumber}`, ok: true,
    rows: [[receiptNumber, '', '', Number(gross)]],
  })),
};
const receiptReadback = {
  fresh: true, taskId: task.taskId, versionId: built.versionId, identity,
  rows: facts.map(([voucherMaterialId, invoiceNumber, receiptNumber, gross, net, tax]) => ({
    voucherMaterialId, identityKey: `einvoice-20:${invoiceNumber}`, invoiceNumber,
    receiptNumber, grossAmount: gross, netAmount: net, taxAmount: tax, source: 'erp_receipt',
  })),
};
const freshGate = {
  status: 'matched', fresh: true, taskId: task.taskId, versionId: built.versionId, identity,
  scope: { taskId: task.taskId, versionId: built.versionId, identity },
};
const input = () => ({ task, built, lines, selection, catalog, expenseItems, receiptCheck,
  freshGate, receiptReadback });

const columns = (...labels) => labels.map((label) => ({ label }));
const data = (values) => ({ kind: 'data', values });
const receiptGrid = () => ({ ok: true, columns: columns('收票单', '发票号码', '不含税金额', '税额', '价税合计'),
  rows: facts.map(([materialId, invoiceNumber, receiptNumber, gross, net, tax]) => data({
    收票单: receiptNumber, 发票号码: `${invoiceNumber.slice(0, 4)}************${invoiceNumber.slice(-4)}`,
    不含税金额: net, 税额: tax, 价税合计: gross, materialId,
  })) });
const detailGrid = (rowCount = 1, railTax = '0.00') => ({ ok: true, columns: columns(
  '收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地',
  '出发地', '目的地', '费用金额', '税额', '申请报销金额',
), rows: Array.from({ length: rowCount }, (_, index) => data(index === 0 ? {
  收票单号: 'SPD-rail', 费用金额: '703.00', 税额: railTax, 申请报销金额: '703.00',
  发票类型: '普通发票', 开始日期: '2026/9/9', 结束日期: '2026/9/9',
} : {})) });
const readings = (detail, mode = 'new', billNo = null, taskMatch = null) => ({
  formMode: { readable: true, value: mode }, billNo: { readable: true, value: billNo },
  receiptsGrid: receiptGrid(), detailGrid: detail,
  taskMatch, receipts: { readable: true, totalCents: 441343, rowCount: 4 },
  detail: { readable: true, totalCents: 441343, rowCount: detail.rows.length },
});

const makePreview = () => {
  const result = buildErpDraftPreview(input());
  assert.equal(result.ready, true, result.problems.map((p) => p.message).join('; '));
  return result.expectedPreview;
};

test('draft preview 用 fresh 收票逐票净税填充铁路，路线不按空格猜，非住宿同日结束', () => {
  const preview = makePreview();
  assert.deepEqual([preview.lines[0].netAmount, preview.lines[0].taxAmount,
    preview.lines[0].netAmountSource, preview.lines[0].taxAmountSource],
  ['644.95', '58.05', 'erp_receipt', 'erp_receipt']);
  assert.equal(preview.lines[1].endDate, '2026-08-27');
  assert.deepEqual(preview.lines[2].routePlan, {
    origin: '时代天逸', destination: '傍西酒堂', source: 'vision_candidate',
  });
  assert.ok(preview.fieldPlan.details[0].fields.some((field) => field.column === '出发地'));
  assert.equal(preview.fieldPlan.details[2].fields.some((field) => field.column === '出发地'), true);
});

test('缺 fresh 铁路净税、票种出处、住宿 checkout 或路线结构时阻塞', () => {
  const noAmounts = buildErpDraftPreview({ ...input(), receiptReadback: {
    ...receiptReadback, rows: receiptReadback.rows.map((row, index) => index === 0
      ? { ...row, netAmount: null, taxAmount: null } : row),
  } });
  assert.equal(noAmounts.ready, false);
  assert.ok(noAmounts.problems.some((p) => p.code === 'receipt_readback_amount_missing'));

  const noType = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => index === 2
    ? { ...line, invoiceType: null, invoiceTypeSource: null } : line) });
  assert.equal(noType.ready, false);
  assert.ok(noType.problems.some((p) => p.code === 'invoice_type_missing'));

  const noHotelCheckout = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => index === 3
    ? (({ endDate, ...rest }) => rest)(line) : line) });
  assert.equal(noHotelCheckout.ready, false);
  assert.ok(noHotelCheckout.problems.some((p) => p.code === 'end_date_missing'));

  assert.equal(routePlanOf({ kind: 'passenger_transport', route: '时代天逸 傍西酒堂' }), null);
  const noRoute = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => index === 2
    ? (({ origin, destination, routeSource, ...rest }) => ({ ...rest, route: '时代天逸 傍西酒堂' }))(line) : line) });
  assert.equal(noRoute.ready, false);
  assert.ok(noRoute.problems.some((p) => p.code === 'route_structure_missing'));
});

test('收票回读必须按唯一发票号和收票号匹配，不接受同金额替代', () => {
  const preview = makePreview();
  const wrong = { ...receiptGrid(), rows: receiptGrid().rows.map((row, index) => index === 0
    ? data({ ...row.values, 发票号码: '26327000001570964156' }) : row) };
  const result = matchReceiptRows(wrong, preview);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => /唯一匹配/.test(reason)));
});

test('fill 预检拒绝旧号单/错误收票，且没有 addRow 适配器时不猜工具栏', async () => {
  const preview = makePreview();
  const approval = { digest: preview.previewDigest, preview };
  const old = await fillApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate,
    readCurrent: async () => readings(detailGrid(), 'modify', 'FYBX-1', null),
  });
  assert.equal(old.ok, false);
  assert.equal(old.phase, 'preflight');
  assert.ok(old.problems.some((p) => p.code === 'new_form_required'));

  const current = readings(detailGrid(), 'new', null, null);
  const noAdd = await fillApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate,
    readCurrent: async () => current,
    ops: {
      writeHeader: async () => ({ ok: true }),
      writeCell: async () => ({ ok: true }),
      selectOption: async () => ({ ok: true }),
      leaveEdit: async () => ({ ok: true, stillEditing: false }),
    },
  });
  assert.equal(noAdd.ok, false);
  assert.ok(noAdd.problems.some((p) => p.code === 'add_row_adapter_required'));
});

test('fill 复用唯一铁路行、受控新增其余三行，任一字段回读失败立即停止', async () => {
  const preview = makePreview();
  const approval = { digest: preview.previewDigest, preview };
  let reads = 0;
  const readCurrent = async (expected) => {
    reads += 1;
    if (expected) return readings(detailGrid(4), 'new', null, { ok: true, reasons: [] });
    return readings(detailGrid(Math.min(reads, 4), reads === 1 ? '58.05' : '0.00'), 'new', null, null);
  };
  const calls = [];
  const ops = {
    writeHeader: async () => ({ ok: true }),
    writeCell: async (_page, spec) => { calls.push(['cell', spec.row, spec.column, spec.value]); return { ok: true }; },
    selectOption: async (_page, spec) => { calls.push(['option', spec.row, spec.column, spec.option]); return { ok: true }; },
    leaveEdit: async () => ({ ok: true, stillEditing: false }),
  };
  const added = [];
  const filled = await fillApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate, readCurrent, ops,
    addRow: async (_page, detail) => { added.push(detail.line.lineId); return { ok: true }; },
  });
  assert.equal(filled.ok, true, filled.problems?.map((p) => p.message).join('; '));
  assert.deepEqual(added, ['ev-2', 'ev-3', 'ev-4']);
  assert.equal(filled.rowsWritten.length, 4);
  assert.ok(calls.some((call) => call[0] === 'cell' && call[2] === '税额' && call[3] === '0.00'));

  let stopped = false;
  const stoppedResult = await fillApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate,
    readCurrent: async (expected) => expected
      ? readings(detailGrid(4), 'new', null, { ok: true, reasons: [] })
      : readings(detailGrid(1), 'new', null, null),
    ops: { ...ops, writeCell: async () => { stopped = true; return { ok: false, reason: '回读不一致' }; } },
    addRow: async () => ({ ok: true }),
  });
  assert.equal(stoppedResult.ok, false);
  assert.equal(stopped, true);
  assert.ok(stoppedResult.problems.some((p) => p.code === 'field_write_failed' || p.code === 'tax_clear_failed'));
});

test('save 仅在同一表单 strict readback 通过时调用一次，失败不重试', async () => {
  const preview = makePreview();
  const approval = { digest: preview.previewDigest, preview };
  const before = readings(detailGrid(4), 'new', null, { ok: true, reasons: [] });
  const fillResult = { ok: true, previewDigest: preview.previewDigest, formToken: formReadbackToken(before) };
  let saves = 0;
  let afterReads = 0;
  const saved = await saveApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate, fillResult,
    readCurrent: async () => {
      afterReads += 1;
      return afterReads === 1 ? before : readings(detailGrid(4), 'modify', 'FYBX-202609-1', { ok: true, reasons: [] });
    },
    save: async () => { saves += 1; },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'saved');
  assert.equal(saves, 1);

  let failedSaves = 0;
  const failed = await saveApprovedPreview({}, {
    approvedPreview: preview, approval, freshGate, fillResult,
    readCurrent: async () => before,
    save: async () => { failedSaves += 1; throw Object.assign(new Error('save timeout'), { code: 'EGO_TIMEOUT' }); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.saveAttempts, 1);
  assert.equal(failedSaves, 1);
});

test('审批只能覆盖完整最终 preview，修改铁路净税后摘要失效', () => {
  const preview = makePreview();
  assert.equal(approvalCovers({ digest: preview.previewDigest, preview }, preview), true);
  const changed = { ...preview, lines: preview.lines.map((line, index) => index === 0
    ? { ...line, taxAmount: '58.04' } : line) };
  assert.equal(approvalCovers({ digest: preview.previewDigest, preview }, changed), false);
});
