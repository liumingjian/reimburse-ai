// Origin: 50931a3:kernel/test/erp-draft-flow.test.mjs (translated to Vitest; inputs and expected outputs kept).
// The kernel's `linesDigest` (selection.mjs) is `previewLinesDigest`; `approvalCovers` lives in the protocol.
import { describe, expect, it } from 'vitest';
import { computedTotalProblem, fillApprovedPreview, formReadbackToken, handOverApprovedPreview, matchReceiptRows } from './executor/draft-flow';
import { buildErpDraftPreview, previewLinesDigest as linesDigest, routePlanOf } from './preview';
import { approvalCovers, type ApprovedPreview } from './protocol';

const identity = { account: 'luo.liu', tenant: 'tenant-a' };
const projectNames = ['项目一完整名称', '项目二完整名称', '项目二完整名称', '项目三完整名称'];
const projectCodes = ['39163', '38480', '38480', '37269'];
const expense = [['FY010003', '长途交通'], ['FY008001', '本地市内交通'], ['FY008001', '本地市内交通'], ['FY010001', '住宿']] as const;
const facts = [
  ['m-rail', '26427000000640558021', 'SPD-rail', '703.00', '644.95', '58.05'],
  ['m-ride-a', '26327000001570964156', 'SPD-ride-a', '51.63', '50.12', '1.51'],
  ['m-ride-b', '26342000002661673906', 'SPD-ride-b', '18.80', '18.25', '0.55'],
  ['m-hotel', '26349119423005877606', 'SPD-hotel', '3640.00', '3433.96', '206.04'],
] as const;
const invoiceTypes = ['普通发票', '普通发票', '普通发票', '增值税发票'];
const events = facts.map(([materialId], index) => ({
  eventId: `ev-${index + 1}`, voucherMaterialId: materialId,
  kind: ['rail_eticket', 'passenger_transport', 'passenger_transport', 'vat_common'][index],
}));
const built = {
  versionId: 'v-1', events,
  lineItems: facts.map(([materialId, , , total], index) => ({
    lineId: `ev-${index + 1}`, eventId: `ev-${index + 1}`, voucherMaterialId: materialId,
    kind: events[index]!.kind,
    date: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-09'][index],
    ...(index === 3 ? { endDate: '2026-08-22' } : {}),
    city: index === 3 ? '广州' : index === 0 ? null : '广州',
    route: index === 0 ? '合肥南 → 广州南' : index === 1 ? '番禺广场地铁站D口 → 傍西酒堂' : index === 2 ? '时代天逸 傍西酒堂' : null,
    netAmount: index === 0 ? null : facts[index]![4],
    taxAmount: index === 0 ? null : facts[index]![5], totalAmount: total,
    category: index === 3 ? 'accommodation' : 'local_city_transport',
    invoiceType: invoiceTypes[index], invoiceTypeSource: 'fixture_mapping',
  })),
};
const lines = built.lineItems.map((line, index) => ({
  ...line, projectCode: projectCodes[index], projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book', projectName: projectNames[index],
  expenseItemCode: expense[index]![0], expenseItemName: expense[index]![1],
  invoiceType: invoiceTypes[index], invoiceTypeSource: 'fixture_mapping',
  ...(index === 2 ? { origin: '时代天逸', destination: '傍西酒堂', routeSource: 'vision_candidate' } : {}),
}));
const projects = Object.fromEntries(projectCodes.map((code, index) => [code, { code, name: projectNames[index === 2 ? 1 : index], verdict: 'confirmed' }]));
const catalog = { versionId: built.versionId, linesDigest: linesDigest(built), identity, projects };
const expenseItems = Object.fromEntries(expense.map(([code, name]) => [code, { code, name, verdict: 'confirmed' }]));
const task = { taskId: 'task-1', currentVersionId: built.versionId, identity, homeCity: '广州' };
const selection = {
  versionId: built.versionId, linesDigest: linesDigest(built), identity, homeCity: '广州',
  purpose: '客户支持', projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
  projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
};
const receiptCheck = {
  taskId: task.taskId, versionId: built.versionId,
  checks: facts.map(([materialId, invoiceNumber, receiptNumber, gross]) => ({
    materialId, identityKey: `einvoice-20:${invoiceNumber}`, ok: true, rows: [[receiptNumber, '', '', Number(gross)]],
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
const input = () => ({ task, built, lines, selection, catalog, expenseItems, receiptCheck, freshGate, receiptReadback });

const columns = (...labels: string[]) => labels.map((label) => ({ label }));
const data = (values: Record<string, string>) => ({ kind: 'data' as const, values });
const receiptGrid = () => ({ ok: true as const, columns: columns('收票单', '发票号码', '不含税金额', '税额', '价税合计'),
  rows: facts.map(([materialId, invoiceNumber, receiptNumber, gross, net, tax]) => data({
    收票单: receiptNumber, 发票号码: `${invoiceNumber.slice(0, 4)}************${invoiceNumber.slice(-4)}`,
    不含税金额: net, 税额: tax, 价税合计: gross, materialId,
  })) });
const detailGrid = (rowCount = 1, railTax = '0.00') => ({ ok: true as const, columns: columns(
  '收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额', '申请报销金额',
), rows: Array.from({ length: rowCount }, (_, index) => data(index === 0 ? {
  收票单号: 'SPD-rail', 费用金额: '703.00', 税额: railTax, 申请报销金额: '703.00', 发票类型: '普通发票', 开始日期: '2026/9/9', 结束日期: '2026/9/9',
} : {})) });
/**
 * A 费用明细 grid that answers with what the ops wrote into it, with 申请报销金额 computed from 费用金额 + 税额 the
 * way ERP computes it. The fill now reads that computed column back as the witness that a write reached ERP, so a
 * stub grid that never moves would be a form where nothing was ever written.
 */
const writableDetailGrid = (seed: Array<Record<string, string>> = []) => {
  const rows = seed.map((values) => ({ ...values }));
  const cents = (value: string | undefined) => {
    const normalized = String(value ?? '').replace(/[¥￥,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    const [whole, fraction = ''] = normalized.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  };
  const recompute = (row: Record<string, string>) => {
    const net = cents(row['费用金额']);
    const tax = cents(row['税额']) ?? 0;
    row['申请报销金额'] = net === null ? '' : ((net + tax) / 100).toFixed(2);
  };
  return {
    rows,
    addRow: () => { rows.push({}); },
    write: (row: number, column: string, value: string) => {
      const target = rows[row] ?? (rows[row] = {});
      target[column] = value;
      // A new 费用金额 clears 税额, as the real grid does (erpform.ts settleGrid note).
      if (column === '费用金额') target['税额'] = '0.00';
      recompute(target);
    },
    grid: () => ({ ok: true as const, columns: columns(
      '收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额', '申请报销金额',
    ), rows: rows.map((values) => data(values)) }),
  };
};

const readings = (detail: ReturnType<typeof detailGrid>, mode = 'new', billNo: string | null = null, taskMatch: { ok: boolean; reasons: string[] } | null = null) => ({
  formMode: { readable: true, value: mode }, billNo: { readable: true, value: billNo },
  receiptsGrid: receiptGrid(), detailGrid: detail, taskMatch,
  receipts: { readable: true, totalCents: 441343, rowCount: 4 },
  detail: { readable: true, totalCents: 441343, rowCount: detail.rows.length },
});

const makePreview = (): ApprovedPreview => {
  const result = buildErpDraftPreview(input());
  expect(result.ready, result.problems.map((p) => p.message).join('; ')).toBe(true);
  return result.expectedPreview!;
};

const okOps = {
  writeHeader: async () => ({ ok: true }),
  writeCell: async () => ({ ok: true }),
  selectOption: async () => ({ ok: true }),
  leaveEdit: async () => ({ ok: true, stillEditing: false }),
};

describe('ERP draft flow (草稿填写与保存)', () => {
  it('fills the railway net/tax from the fresh receipt, never splits routes on spaces, ends same-day lines on the start date', () => {
    const preview = makePreview();
    expect([preview.lines[0]!.netAmount, preview.lines[0]!.taxAmount, preview.lines[0]!.netAmountSource, preview.lines[0]!.taxAmountSource])
      .toEqual(['644.95', '58.05', 'erp_receipt', 'erp_receipt']);
    expect(preview.lines[1]!.endDate).toBe('2026-08-27');
    expect(preview.lines[2]!.routePlan).toEqual({ origin: '时代天逸', destination: '傍西酒堂', source: 'vision_candidate' });
    expect(preview.fieldPlan!.details[0]!.fields.some((field) => field.column === '出发地')).toBe(true);
    expect(preview.fieldPlan!.details[2]!.fields.some((field) => field.column === '出发地')).toBe(true);
  });

  it('blocks on a missing fresh railway net/tax, invoice-type source, hotel checkout or route structure', () => {
    const noAmounts = buildErpDraftPreview({ ...input(), receiptReadback: {
      ...receiptReadback, rows: receiptReadback.rows.map((row, index) => (index === 0 ? { ...row, netAmount: null, taxAmount: null } : row)),
    } });
    expect(noAmounts.ready).toBe(false);
    expect(noAmounts.problems.some((p) => p.code === 'receipt_readback_amount_missing')).toBe(true);

    const noType = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => (index === 2 ? { ...line, invoiceType: null, invoiceTypeSource: null } : line)) });
    expect(noType.ready).toBe(false);
    expect(noType.problems.some((p) => p.code === 'invoice_type_missing')).toBe(true);

    const noHotelCheckout = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => (index === 3 ? (({ endDate: _e, ...rest }) => rest)(line as typeof line & { endDate?: string }) : line)) });
    expect(noHotelCheckout.ready).toBe(false);
    expect(noHotelCheckout.problems.some((p) => p.code === 'end_date_missing')).toBe(true);

    expect(routePlanOf({ kind: 'passenger_transport', route: '时代天逸 傍西酒堂' })).toBeNull();
    const noRoute = buildErpDraftPreview({ ...input(), lines: lines.map((line, index) => (index === 2
      ? (({ origin: _o, destination: _d, routeSource: _r, ...rest }) => ({ ...rest, route: '时代天逸 傍西酒堂' }))(line as typeof line & { origin?: string; destination?: string; routeSource?: string })
      : line)) });
    expect(noRoute.ready).toBe(false);
    expect(noRoute.problems.some((p) => p.code === 'route_structure_missing')).toBe(true);
  });

  it('matches receipt rows by unique invoice and receipt number; an equal amount is no substitute', () => {
    const preview = makePreview();
    const wrong = { ...receiptGrid(), rows: receiptGrid().rows.map((row, index) => (index === 0 ? data({ ...row.values, 发票号码: '26327000001570964156' }) : row)) };
    const result = matchReceiptRows(wrong, preview);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /唯一匹配/.test(reason))).toBe(true);
  });

  // The three rows of the live fill of 2026-09-20, with their own numbers. Every one of them read back both money
  // cells correctly; only ERP's computed 申请报销金额 says the value never arrived.
  it('reads the computed 申请报销金额 as the witness that a money write reached ERP, not the cell it was typed into', () => {
    const row = (net: string, tax: string, sum: string) => ({ 费用金额: net, 税额: tax, 申请报销金额: sum });
    expect(computedTotalProblem(row('¥32.18', '¥0.32', '¥32.50'), { net: '32.18', tax: '0.32' }, '明细第 1 行')).toBe(null);
    expect(computedTotalProblem(row('¥32.18', '¥0.32', '¥32.18'), { net: '32.18', tax: '0.32' }, '明细第 1 行'))
      .toMatch(/明细第 1 行.*申请报销金额.*没有进到报销系统自己的账里/);
    expect(computedTotalProblem(row('¥15.56', '¥0.47', '¥0.47'), { net: '15.56', tax: '0.47' }, '明细第 2 行'))
      .toMatch(/明细第 2 行/);
    expect(computedTotalProblem(row('¥1,677.36', '¥100.64', '¥1,677.36'), { net: '1677.36', tax: '100.64' }, '明细第 11 行'))
      .toMatch(/明细第 11 行/);
    expect(computedTotalProblem(row('¥1,677.36', '¥100.64', '¥1,778.00'), { net: '1677.36', tax: '100.64' }, '明细第 11 行')).toBe(null);
    // A cell that does not hold what was asked for is caught by the same reading, computed column or not.
    expect(computedTotalProblem(row('¥32.18', '¥0.32', '¥32.50'), { net: '32.19', tax: '0.32' }, '明细第 1 行')).toMatch(/费用金额/);
    expect(computedTotalProblem(row('¥32.18', '', '¥32.18'), { net: '32.18', tax: '0.32' }, '明细第 1 行')).toMatch(/读不出金额/);
  });

  it('refuses an old-number form or wrong receipts in preflight, and never guesses a toolbar without an addRow adapter', async () => {
    const preview = makePreview();
    const approval = { digest: preview.previewDigest!, preview };
    const old = await fillApprovedPreview({}, {
      approvedPreview: preview, approval, freshGate,
      readCurrent: async () => readings(detailGrid(), 'modify', 'FYBX-1', null),
    });
    expect(old.ok).toBe(false);
    expect(old.phase).toBe('preflight');
    expect(!old.ok && old.problems.some((p) => p.code === 'new_form_required')).toBe(true);

    const form = writableDetailGrid([{ 收票单号: 'SPD-rail', 费用金额: '703.00', 税额: '0.00', 申请报销金额: '703.00', 发票类型: '普通发票', 开始日期: '2026/9/9', 结束日期: '2026/9/9' }]);
    const writing = { ...okOps, writeCell: async (_page: unknown, spec: { row: number; column: string; value: string }) => { form.write(spec.row, spec.column, spec.value); return { ok: true }; } };
    const noAdd = await fillApprovedPreview({}, { approvedPreview: preview, approval, freshGate,
      readCurrent: async () => readings(form.grid() as ReturnType<typeof detailGrid>, 'new', null, null), ops: writing });
    expect(noAdd.ok).toBe(false);
    expect(!noAdd.ok && noAdd.problems.some((p) => p.code === 'add_row_adapter_required')).toBe(true);
  });

  it('reuses the one railway row, adds the other three under control, and stops at the first failed field read-back', async () => {
    const preview = makePreview();
    const approval = { digest: preview.previewDigest!, preview };
    // The railway row arrives from the import carrying the receipt's own 税额, which the fill clears before it
    // writes the pair; every write lands in the grid and ERP recomputes 申请报销金额 from it.
    const form = writableDetailGrid([{ 收票单号: 'SPD-rail', 费用金额: '703.00', 税额: '58.05', 申请报销金额: '761.05' }]);
    const readCurrent = async (expected: ApprovedPreview | null) =>
      readings(form.grid() as ReturnType<typeof detailGrid>, 'new', null, expected ? { ok: true, reasons: [] } : null);
    const calls: unknown[][] = [];
    const ops = {
      ...okOps,
      writeCell: async (_page: unknown, spec: { row: number; column: string; value: string }) => { calls.push(['cell', spec.row, spec.column, spec.value]); form.write(spec.row, spec.column, spec.value); return { ok: true }; },
      selectOption: async (_page: unknown, spec: { row: number; column: string; option: string }) => { calls.push(['option', spec.row, spec.column, spec.option]); return { ok: true }; },
    };
    const added: string[] = [];
    const filled = await fillApprovedPreview({}, {
      approvedPreview: preview, approval, freshGate, readCurrent, ops,
      addRow: async (_page, detail) => { added.push(detail.line.lineId); form.addRow(); return { ok: true }; },
    });
    expect(filled.ok, !filled.ok ? filled.problems.map((p) => p.message).join('; ') : '').toBe(true);
    expect(added).toEqual(['ev-2', 'ev-3', 'ev-4']);
    expect(filled.ok && filled.rowsWritten.length).toBe(4);
    expect(calls.some((call) => call[0] === 'cell' && call[2] === '税额' && call[3] === '0.00')).toBe(true);

    let stopped = false;
    const stoppedResult = await fillApprovedPreview({}, {
      approvedPreview: preview, approval, freshGate,
      readCurrent: async (expected) => readings(detailGrid(1), 'new', null, expected ? { ok: true, reasons: [] } : null),
      ops: { ...ops, writeCell: async () => { stopped = true; return { ok: false, reason: '回读不一致' }; } },
      addRow: async () => ({ ok: true }),
    });
    expect(stoppedResult.ok).toBe(false);
    expect(stopped).toBe(true);
    expect(!stoppedResult.ok && stoppedResult.problems.some((p) => p.code === 'field_write_failed' || p.code === 'tax_clear_failed')).toBe(true);
  });

  it('hands over only when the same form still passes the strict read-back, and never saves', async () => {
    const preview = makePreview();
    const approval = { digest: preview.previewDigest!, preview };
    const before = readings(detailGrid(4), 'new', null, { ok: true, reasons: [] });
    const fillResult = { ok: true, previewDigest: preview.previewDigest, formToken: formReadbackToken(before) };

    let reads = 0;
    const handedOver = await handOverApprovedPreview({
      approvedPreview: preview, approval, freshGate, fillResult,
      readCurrent: async () => { reads += 1; return before; },
    });
    expect(handedOver).toMatchObject({ status: 'handed_over' });
    expect(handedOver.readings).toBe(before);
    // One read: the strict 逐行回读 (per-line read-back) is the whole gate, and nothing follows it.
    expect(reads).toBe(1);

    // The preconditions that blocked a mismatched form before the save still block the hand-over, under the hand-over's names.
    const drifted = await handOverApprovedPreview({
      approvedPreview: preview, approval, freshGate, fillResult,
      readCurrent: async () => readings(detailGrid(4), 'modify', 'FYBX-202609-1', { ok: true, reasons: [] }),
    });
    expect(drifted).toMatchObject({ status: 'blocked' });
    expect(drifted.problems?.[0]?.code).toBe('hand_over_precondition_failed');

    const unfilled = await handOverApprovedPreview({
      approvedPreview: preview, approval, freshGate, fillResult: null,
      readCurrent: async () => { throw new Error('the form must not be read without a fill read-back'); },
    });
    expect(unfilled).toMatchObject({ status: 'blocked' });
    expect(unfilled.problems?.some((problem) => problem.code === 'fill_result_missing')).toBe(true);
  });

  it('lets an approval cover only the complete final preview; editing the railway tax voids it', () => {
    const preview = makePreview();
    expect(approvalCovers({ digest: preview.previewDigest!, preview }, preview)).toBe(true);
    const changed = { ...preview, lines: preview.lines.map((line, index) => (index === 0 ? { ...line, taxAmount: '58.04' } : line)) };
    expect(approvalCovers({ digest: preview.previewDigest!, preview }, changed)).toBe(false);
  });
});
