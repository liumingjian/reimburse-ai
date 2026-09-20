// Origin: 50931a3:kernel/test/erpreconcile.test.mjs and 50931a3:kernel/test/erpreconcile-strict.test.mjs (translated to Vitest;
// inputs and expected outputs kept). The kernel's readReconciliation cases are split: the read-only collection is
// the executor's readForm (queue fake session, no Input.* event), the sums and the bucket are the server's.
// The ego-transport refusal case is dropped with the ego adapter (ADR-0016).
import { describe, expect, it } from 'vitest';
import { readForm, protocolReadings } from './executor/reader';
import { fakeSession, inputs } from './executor/testing/fake-session';
import { RECONCILE_BUCKETS } from '@baox/contract';
import { ACTIONS, BUCKETS, classifyReconciliation, noFormOpen, reconcileReadings, requiredDetailCells, sumColumn, toCents, type ReconcileReadings } from './reconcile';
import { matchTaskLines } from './readback';

// A consistent form: receipts 703.00, detail 申请报销金额 703.00.
const R = (o: Partial<ReconcileReadings> = {}): ReconcileReadings => ({
  formMode: { readable: true, value: 'new' },
  billNo: { readable: true, value: null },
  receipts: { readable: true, totalCents: 70300, rowCount: 1 },
  detail: { readable: true, totalCents: 70300, rowCount: 1 },
  payable: { readable: true, totalCents: 70300 },
  // A form that is really ready to save has its 必填 cells filled; equal totals alone never made it saveable.
  detailRequired: { readable: true, blank: [] },
  ...o,
});
const saved = (o: Partial<ReconcileReadings> = {}) => R({ formMode: { readable: true, value: 'modify' },
  billNo: { readable: true, value: 'FYBX2026090007' }, ...o });

describe('classifyReconciliation (对账中断点 reconcile buckets)', () => {
  it('uses the contract buckets verbatim', () => {
    expect(BUCKETS).toEqual(RECONCILE_BUCKETS);
    expect(ACTIONS).toEqual(['原地等待', '转人工']);
  });

  it('one case per bucket, action per the #36 mapping', () => {
    const cases: Array<[string, string, ReconcileReadings]> = [
      ['未知', '原地等待', R({ formMode: { readable: false, value: null, reason: '页面上没有打开的费用报销单' } })],
      ['未保存·导入前', '原地等待', R({ receipts: { readable: true, totalCents: 0, rowCount: 0 },
        detail: { readable: true, totalCents: 0, rowCount: 0 } })],
      ['未保存·已导入未写明细', '转人工', R({ detail: { readable: true, totalCents: 0, rowCount: 1 } })],
      ['未保存·就绪待保存', '原地等待', R()],
      ['已保存', '原地等待', saved()],
      ['不自洽', '转人工', R({ detail: { readable: true, totalCents: 70299, rowCount: 1 } })],
    ];
    for (const [bucket, action, readings] of cases) {
      const v = classifyReconciliation(readings);
      expect([v.bucket, v.action], `${bucket} misclassified`).toEqual([bucket, action]);
    }
  });

  it('hands off (转人工) in exactly three cases; everything else waits (原地等待)', () => {
    const byBucket: Record<string, ReconcileReadings> = {
      '未知': R({ billNo: { readable: false, value: null, reason: '没有可见实例' } }),
      '未保存·导入前': R({ receipts: { readable: true, totalCents: 0, rowCount: 0 } }),
      '未保存·已导入未写明细': R({ detail: { readable: true, totalCents: 0, rowCount: 1 } }),
      '未保存·就绪待保存': R(),
      '已保存': saved(),
      '不自洽': saved({ billNo: { readable: true, value: null } }),
    };
    const handoff = Object.entries(byBucket)
      .filter(([, readings]) => classifyReconciliation(readings).action === '转人工')
      .map(([bucket]) => bucket);
    expect(handoff.sort()).toEqual(['不自洽', '未保存·已导入未写明细'].sort());
    // The third is 已保存 with a failed identity: same bucket, the heavier action.
    expect(classifyReconciliation(saved({ detail: { readable: true, totalCents: 70299, rowCount: 1 } })).action).toBe('转人工');
  });

  it('evaluates 未知 first: three readings shaped like 已保存 do not pass when one is unreadable', () => {
    for (const missing of ['formMode', 'billNo', 'receipts', 'detail'] as const) {
      const v = classifyReconciliation(saved({ [missing]: { readable: false, value: null, totalCents: null, reason: '读不到' } } as never));
      expect(v.bucket, `${missing} unreadable must not give 已保存`).toBe('未知');
      expect(v.action).toBe('原地等待');
      expect(v.reasons.some((r) => /读不到/.test(r))).toBe(true);
    }
  });

  it('false-green counterexample: 0 receipt rows + empty detail cell never lands in 就绪待保存', () => {
    const v = classifyReconciliation(R({
      receipts: { readable: true, totalCents: 0, rowCount: 0 },
      detail: { readable: false, totalCents: null, rowCount: null, reason: '第 1 行的「申请报销金额」是空的' },
    }));
    expect(['未保存·导入前', '未知']).toContain(v.bucket);
    expect(v.action).toBe('原地等待');
  });

  it('receipts have rows but detail is unreadable -> 已导入未写明细, hand off', () => {
    const v = classifyReconciliation(R({
      detail: { readable: false, totalCents: null, rowCount: null, reason: '第 1 行的「申请报销金额」是空的' },
    }));
    expect([v.bucket, v.action]).toEqual(['未保存·已导入未写明细', '转人工']);
  });

  it('the identity is exact to the cent: one cent off is 不自洽', () => {
    const off = classifyReconciliation(R({ detail: { readable: true, totalCents: 70301, rowCount: 1 } }));
    expect(off.bucket).toBe('不自洽');
    expect({ equal: off.identity.equal, r: off.identity.receiptsCents, d: off.identity.detailCents })
      .toEqual({ equal: false, r: 70300, d: 70301 });
  });

  it('申请付款金额 is side evidence only: it never moves the bucket, it only enters the reasons', () => {
    const withOdd = classifyReconciliation(R({ payable: { readable: true, totalCents: 12345 } }));
    const clean = classifyReconciliation(R());
    expect([withOdd.bucket, withOdd.action]).toEqual([clean.bucket, clean.action]);
    expect(withOdd.reasons.some((r) => /申请付款金额/.test(r))).toBe(true);
  });

  it('已保存 with the identity holding waits; failing it hands off', () => {
    expect(classifyReconciliation(saved()).action).toBe('原地等待');
    expect(classifyReconciliation(saved({ receipts: { readable: true, totalCents: 70100, rowCount: 1 } })).action).toBe('转人工');
  });

  // The live state of 2026-09-19: 10 收票 imported into an unsaved 新增单, the ERP's own aggregated 明细 rows
  // (grouped by 发票类型) already carrying the whole 7,335.55, 项目 and 费用项目 empty on every row, no approved
  // preview to match against. Equal totals used to make this 未保存·就绪待保存 「差保存这一下」, and the ERP refuses
  // 保存 with 必填 errors on both columns (docs/research/erp-expense-flow/save-contract.md).
  describe('就绪待保存 requires evidence the bill is saveable, not two equal numbers', () => {
    const imported = (o: Partial<ReconcileReadings> = {}) => R({
      receipts: { readable: true, totalCents: 733555, rowCount: 10 },
      detail: { readable: true, totalCents: 733555, rowCount: 2 },
      payable: { readable: true, totalCents: 733555 },
      detailRequired: { readable: true, blank: [
        { row: 1, column: '项目' }, { row: 1, column: '费用项目' },
        { row: 2, column: '项目' }, { row: 2, column: '费用项目' },
      ] },
      ...o,
    });

    it('empty 必填 cells on every detail row are 已导入未写明细, never 就绪待保存', () => {
      const v = classifyReconciliation(imported());
      expect([v.bucket, v.action]).toEqual(['未保存·已导入未写明细', '转人工']);
      expect(v.identity).toEqual({ applicable: true, receiptsCents: 733555, detailCents: 733555, equal: true });
      expect(v.reasons.some((r) => /4 处必填项「项目」「费用项目」是空的/.test(r))).toBe(true);
      expect(v.reasons.some((r) => /差保存这一下/.test(r))).toBe(false);
    });

    it('one empty 必填 cell in an otherwise filled grid is enough', () => {
      const v = classifyReconciliation(imported({ detailRequired: { readable: true, blank: [{ row: 2, column: '费用项目' }] } }));
      expect(v.bucket).toBe('未保存·已导入未写明细');
    });

    it('unreadable 必填 columns refuse to conclude: 未知, not 就绪待保存', () => {
      const v = classifyReconciliation(imported({ detailRequired: { readable: false, blank: [], reason: '明细网格的表头里认不出「项目」列，判不出必填项填没填' } }));
      expect([v.bucket, v.action]).toEqual(['未知', '原地等待']);
      expect(v.reasons.some((r) => /认不出「项目」列/.test(r))).toBe(true);
    });

    it('filled 必填 cells with equal totals still reach 就绪待保存', () => {
      const v = classifyReconciliation(imported({ detailRequired: { readable: true, blank: [] } }));
      expect([v.bucket, v.action]).toEqual(['未保存·就绪待保存', '原地等待']);
    });

    it('a passing strict per-line match is the other evidence, and it does not need the 必填 reading', () => {
      const v = classifyReconciliation(imported({ taskMatch: { ok: true } }));
      expect([v.bucket, v.action]).toEqual(['未保存·就绪待保存', '原地等待']);
    });

    it('requiredDetailCells reads the live grid: two aggregated rows, both 必填 columns empty', () => {
      const cells = requiredDetailCells(details([
        data({ 项目: '', 费用项目: '', 申请报销金额: '3640.00' }),
        data({ 项目: '', 费用项目: '', 申请报销金额: '3695.55' }),
      ]));
      expect(cells).toEqual({ readable: true, blank: [
        { row: 1, column: '项目' }, { row: 1, column: '费用项目' },
        { row: 2, column: '项目' }, { row: 2, column: '费用项目' },
      ] });
      expect(requiredDetailCells({ ok: true, columns: columns('序号', '申请报销金额'), rows: [] }).readable).toBe(false);
      expect(requiredDetailCells({ ok: false, reason: '读不到' })).toMatchObject({ readable: false, reason: '读不到' });
      // A whitespace-only cell is empty, and a filled grid is readable with nothing blank.
      expect(requiredDetailCells(details([data({ 项目: ' ', 费用项目: '住宿' })])).blank).toEqual([{ row: 1, column: '项目' }]);
      expect(requiredDetailCells(details()).blank).toEqual([]);
    });
  });

  it('new with a bill number, or modify without one -> 不自洽, readings reported as-is', () => {
    const a = classifyReconciliation(R({ billNo: { readable: true, value: 'FYBX2026090007' } }));
    const b = classifyReconciliation(saved({ billNo: { readable: true, value: null } }));
    expect([a.bucket, a.action]).toEqual(['不自洽', '转人工']);
    expect([b.bucket, b.action]).toEqual(['不自洽', '转人工']);
  });
});

// ---- The three fail-closed rules of summing a column ----

type Row = { kind: 'data' | 'total'; values: Record<string, string> };
const grid = (rows: Row[], column = '价税合计', extraColumns: string[] = []) => ({
  ok: true as const,
  columns: [{ label: '序号' }, { label: column }, ...extraColumns.map((label) => ({ label }))],
  rowCount: rows.filter((r) => r.kind !== 'total').length,
  rows,
});
const dataRow = (values: Record<string, string>): Row => ({ kind: 'data', values });
const totalRow = (values: Record<string, string>): Row => ({ kind: 'total', values });

describe('sumColumn', () => {
  it('parses money to cents without floating point', () => {
    expect(['¥18.80', '1,234.56', '703', '0.05', '-1.20'].map(toCents)).toEqual([1880, 123456, 70300, 5, -120]);
    expect(['', '  ', '-', '一百', null].map(toCents)).toEqual([null, null, null, null, null]);
    expect(sumColumn(grid([dataRow({ '价税合计': '0.10' }), dataRow({ '价税合计': '0.20' })]), '价税合计').totalCents).toBe(30);
  });

  it('an empty cell makes the grid unreadable, never 0', () => {
    const r = sumColumn(grid([dataRow({ '价税合计': '18.80' }), dataRow({ '价税合计': '' })]), '价税合计');
    expect(r.readable).toBe(false);
    expect(r.totalCents).toBeNull();
    expect(r.reason).toMatch(/空|不当 0/);
  });

  it('an unrecognised column makes the whole grid unreadable', () => {
    const r = sumColumn(grid([dataRow({ '价税合计': '18.80' })]), '申请报销金额');
    expect(r.readable).toBe(false);
    expect(r.reason).toMatch(/认不出/);
  });

  it('the total row is not summed; if it disagrees with the rows the grid is unreadable', () => {
    const good = sumColumn(grid([dataRow({ '价税合计': '644.95' }), dataRow({ '价税合计': '58.05' }),
      totalRow({ '价税合计': '703.00' })]), '价税合计');
    expect([good.readable, good.totalCents, good.rowCount]).toEqual([true, 70300, 2]);
    const bad = sumColumn(grid([dataRow({ '价税合计': '644.95' }), totalRow({ '价税合计': '703.00' })]), '价税合计');
    expect(bad.readable).toBe(false);
    expect(bad.reason).toMatch(/合计行/);
  });

  it('an unreadable grid makes the reading unreadable, carrying its reason', () => {
    const r = sumColumn({ ok: false, reason: '有 2 个可见网格的表头都有「价税合计」列，认不出该读哪个' }, '价税合计');
    expect([r.readable, r.totalCents]).toEqual([false, null]);
    expect(r.reason).toMatch(/认不出该读哪个/);
  });
});

// ---- Read-only collection (executor readForm) + server-side readings ----

// The real 费用明细 grid carries 项目 and 费用项目 as columns of its own; 对账 reads whether they are filled off this
// same grid, so a fixture without them is not a form the ERP would save.
const detailGrid = (rows: Row[]) => ({ ok: true, matchedGrids: 1,
  columns: [{ label: '序号' }, { label: '项目' }, { label: '费用项目' }, { label: '费用金额' }, { label: '税额' }, { label: '申请报销金额' }, { label: '申请付款金额' }],
  rowCount: rows.length, rows });

/** readForm evaluates tabs, the FBILLNO header, then the receipt and the detail grid, in that order. */
const collect = async ({ tabs, bill, receipts, detail }: { tabs: unknown; bill: unknown; receipts: unknown; detail: unknown }) => {
  const session = fakeSession([tabs, bill, receipts, detail]);
  const readings = protocolReadings(await readForm(session));
  return { session, readings, reconcile: reconcileReadings(readings) };
};

describe('reconcile readings (readReconciliation)', () => {
  it('collects the four readings with read-only evaluations and classifies them on the server', async () => {
    const receipts = { ok: true, matchedGrids: 1, columns: [{ label: '序号' }, { label: '价税合计' }],
      rowCount: 1, rows: [{ kind: 'data', values: { '序号': '1', '价税合计': '¥703.00' } }] };
    const detail = detailGrid([dataRow({ '序号': '1', '项目': '某某项目-20-2614', '费用项目': '住宿', '费用金额': '¥644.95',
      '税额': '¥58.05', '申请报销金额': '¥703.00', '申请付款金额': '¥703.00' })]);
    const { session, readings, reconcile } = await collect({
      tabs: [{ label: '费用报销单-新增', mode: 'new', x: 100, y: 40 }],
      bill: { ok: true, id: 'aaa-FBILLNO-EDITOR', instance: 'aaa', value: '', instances: 1, visibleInstances: 1 },
      receipts, detail,
    });
    expect(reconcile.formMode).toEqual({ readable: true, value: 'new' });
    expect(reconcile.billNo).toEqual({ readable: true, value: null });
    expect([reconcile.receipts.readable, reconcile.receipts.totalCents, reconcile.receipts.rowCount]).toEqual([true, 70300, 1]);
    expect([reconcile.detail.readable, reconcile.detail.totalCents]).toEqual([true, 70300]);
    expect(reconcile.payable).toEqual({ readable: true, totalCents: 70300 });
    expect(readings.receiptsGrid).toEqual(receipts);
    expect(readings.detailGrid).toEqual(detail);
    expect(session.sent.map((c) => c.method)).toEqual(['Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate', 'Runtime.evaluate']);
    expect(inputs(session)).toEqual([]);
    const v = classifyReconciliation(reconcile);
    expect([v.bucket, v.action]).toEqual(['未保存·就绪待保存', '原地等待']);
  });

  it('two form tabs open at once -> form mode unreadable -> 未知', async () => {
    const { session, reconcile } = await collect({
      tabs: [{ label: '费用报销单-新增', mode: 'new' }, { label: '费用报销单-修改', mode: 'modify' }],
      bill: { ok: true, instance: 'aaa', value: 'FYBX2026090007' },
      receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 0, rows: [] },
      detail: detailGrid([]),
    });
    expect(reconcile.formMode.readable).toBe(false);
    expect(reconcile.formMode.reason).toMatch(/同时开着 2 个/);
    expect(classifyReconciliation(reconcile).bucket).toBe('未知');
    expect(inputs(session)).toEqual([]);
  });

  it('no 费用报销单 open at all is its own reading, told apart from two open at once', async () => {
    const gone = '页面上没有打开的费用报销单（既没有「新增」也没有「修改」页签）';
    const { reconcile } = await collect({
      tabs: [],
      bill: { ok: false, reason: '页面上找不到表头字段 FBILLNO' },
      receipts: { ok: false, matchedGrids: 0, reason: '页面上没有哪个可见网格的表头有「价税合计」列' },
      detail: { ok: false, matchedGrids: 0, reason: '页面上没有哪个可见网格的表头有「申请报销金额」列' },
    });
    expect(reconcile.formMode.reason).toBe(gone);
    expect(noFormOpen(reconcile)).toBe(true);
    expect(classifyReconciliation(reconcile).bucket).toBe('未知');
    const twoOpen = await collect({
      tabs: [{ label: '费用报销单-新增', mode: 'new' }, { label: '费用报销单-修改', mode: 'modify' }],
      bill: { ok: false, reason: '表头字段 FBILLNO 有 2 个可见实例，认不出是哪一张单的' },
      receipts: { ok: false, reason: '认不出该读哪个' },
      detail: { ok: false, reason: '认不出该读哪个' },
    });
    expect(noFormOpen(twoOpen.reconcile)).toBe(false);
  });

  it('a header field without exactly one visible instance -> bill number unreadable', async () => {
    const { reconcile } = await collect({
      tabs: [{ label: '费用报销单-修改', mode: 'modify' }],
      bill: { ok: false, reason: '表头字段 FBILLNO 有 2 个可见实例，认不出是哪一张单的', visibleInstances: 2 },
      receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 0, rows: [] },
      detail: detailGrid([]),
    });
    expect(reconcile.billNo.readable).toBe(false);
    expect(reconcile.billNo.reason).toMatch(/2 个可见实例/);
    expect(classifyReconciliation(reconcile).bucket).toBe('未知');
  });

  it('a detail grid not rendered yet is unreadable; reconcile does not open it', async () => {
    const { session, reconcile } = await collect({
      tabs: [{ label: '费用报销单-新增', mode: 'new' }],
      bill: { ok: true, instance: 'aaa', value: '' },
      receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 1,
        rows: [{ kind: 'data', values: { '价税合计': '¥703.00' } }] },
      detail: { ok: false, matchedGrids: 0, reason: '页面上没有哪个可见网格的表头有「申请报销金额」列' },
    });
    expect(reconcile.detail.readable).toBe(false);
    expect(inputs(session)).toEqual([]);
    const v = classifyReconciliation(reconcile);
    expect([v.bucket, v.action]).toEqual(['未保存·已导入未写明细', '转人工']);
  });
});

// ---- Strict per-line match (origin: 50931a3:kernel/test/erpreconcile-strict.test.mjs) ----

const identity = [
  ['m-rail', '26427000000640558021', 'SPD202609040022', '703.00', '644.95', '58.05'],
  ['m-ride-a', '26327000001570964156', 'SPD202609020037', '51.63', '50.12', '1.51'],
  ['m-ride-b', '26342000002661673906', 'SPD202608220132', '18.80', '18.25', '0.55'],
  ['m-hotel', '26349119423005877606', 'SPD202609020039', '3640.00', '3433.96', '206.04'],
] as const;
const project = '中华联合财产保险股份有限公司黑龙江分公司-网络维保-20-2614';
const lines = identity.map(([materialId, invoiceNumber, , total, net, tax], index) => ({
  lineId: `ev-0${index + 1}`,
  eventId: `ev-0${index + 1}`,
  voucherMaterialId: materialId,
  kind: ['rail_eticket', 'passenger_transport', 'passenger_transport', 'vat_common'][index],
  category: ['long_distance', 'local_city_transport', 'local_city_transport', 'accommodation'][index],
  projectCode: ['39163', '38480', '38480', '37269'][index],
  projectName: index === 0 ? project : '天津银行股份有限公司泸州分行-2020泸州分行存储维保项目-20-1961',
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  expenseItemCode: index === 0 ? 'FY010003' : index === 3 ? 'FY010001' : 'FY008001',
  expenseItemName: index === 0 ? '长途交通' : index === 3 ? '住宿' : '本地市内交通',
  date: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-09'][index],
  endDate: ['2026-08-22', '2026-08-27', '2026-08-22', '2026-08-22'][index],
  invoiceType: ['普通发票', '普通发票', '普通发票', '增值税发票'][index],
  invoiceTypeSource: 'fixture_confirmed',
  netAmount: index === 0 ? null : net as string | null,
  taxAmount: index === 0 ? null : tax as string | null,
  totalAmount: total as string,
  invoiceNumber,
}));
type Line = (typeof lines)[number];

const expected = {
  projectSource: 'erp_catalog_confirmed',
  projectsFrom: 'project_book',
  lines,
  receiptBindings: identity.map(([voucherMaterialId, invoiceNumber, receiptNumber, gross]) => ({
    voucherMaterialId, identityKey: `einvoice-20:${invoiceNumber}`, invoiceNumber, receiptNumber, grossAmount: gross,
  })) as Array<Record<string, string>> | undefined,
};

const columns = (...labels: string[]) => labels.map((label) => ({ label }));
const strictGrid = (columns_: Array<{ label: string }>, rows: Row[]) => ({ ok: true as const, columns: columns_, rows });
const data = (values: Record<string, string>): Row => ({ kind: 'data', values });

const receipts = strictGrid(columns('序号', '收票单', '发票号码', '不含税金额', '税额', '价税合计'),
  identity.map(([materialId, invoiceNumber, receiptNumber, gross, net, tax], index) => data({
    '序号': String(index + 1),
    '收票单': receiptNumber,
    // The exact mask saved alongside the real receipt identity.
    '发票号码': `${invoiceNumber.slice(0, 4)}************${invoiceNumber.slice(-4)}`,
    '不含税金额': net,
    '税额': tax,
    '价税合计': gross,
    materialId,
  })));

const detailValues = (line: Line, overrides: Record<string, string> = {}) => ({
  '申请报销金额': line.totalAmount,
  '费用金额': line.netAmount ?? (line.lineId === 'ev-01' ? '644.95' : ''),
  '税额': line.taxAmount ?? (line.lineId === 'ev-01' ? '58.05' : ''),
  '发票类型': line.invoiceType!,
  '项目': line.projectName,
  '费用项目': line.expenseItemName,
  '开始日期': line.date!,
  '结束日期': line.endDate!,
  '收票单号': expected.receiptBindings!.find((binding) => binding.voucherMaterialId === line.voucherMaterialId)!.receiptNumber!,
  ...overrides,
});
const details = (rows: Row[] = lines.map((line) => data(detailValues(line)))) => strictGrid(columns(
  '序号', '项目', '费用项目', '开始日期', '结束日期', '发票类型', '费用金额', '税额', '申请报销金额', '收票单号',
), rows.map((row, index) => ({ ...row, values: { 序号: String(index + 1), ...row.values } })));

// The comparison is per-receipt by identity and per-form by totals. Detail rows are NOT matched one to one with
// task lines any more (the owner's decision, 2026-09-20): the employee reads the bill before saving it, and what
// must not drift is the money. Field-by-field exactness is still enforced where the value is written — `writeCell`
// reads back the very cell it typed into (`erpform.ts`), so a project that resolved to the wrong name fails there.
describe('matchTaskLines (reconcile: receipts by identity, form by totals)', () => {
  it('passes when four lines match by receipt identity and by totals; the rail net/tax comes from its receipt', () => {
    const result = matchTaskLines(details(), expected, receipts);
    expect(result.ok, result.reasons.join('; ')).toBe(true);
    expect(result.amountSources[0]).toEqual({ line: 1, net: 'erp_receipt', tax: 'erp_receipt' });
  });

  it('refuses money that drifted: one wrong 税额 and the form no longer adds up to the task', () => {
    const wrong = lines.map((line, index) => data(detailValues(line, index === 3 ? { 税额: '206.03' } : {})));
    const result = matchTaskLines(details(wrong), expected, receipts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /「税额」合计/.test(reason))).toBe(true);
  });

  it('refuses a detail row ERP left without a 发票类型: that is a field the fill failed to write', () => {
    const blank = lines.map((line, index) => data(detailValues(line, index === 2 ? { 发票类型: '' } : {})));
    const result = matchTaskLines(details(blank), expected, receipts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /第 3 行没有发票类型/.test(reason))).toBe(true);
  });

  // The loosening, stated as a test rather than left implicit: these three rows differ from the preview in
  // project, date and expense item, and the form still passes because every total agrees. Each of those values was
  // read back at the moment it was written; the reconcile's job is the money.
  it('accepts rows whose project, date or expense item differ from the preview, as long as the totals agree', () => {
    const drifted = lines.map((line, index) => data(detailValues(line, index === 0
      ? { 项目: '别的项目' }
      : index === 1 ? { 开始日期: '2026-09-09' } : index === 2 ? { 费用项目: '住宿' } : {})));
    const result = matchTaskLines(details(drifted), expected, receipts);
    expect(result.ok, result.reasons.join('; ')).toBe(true);
  });

  it('an equal-amount wrong invoice or receipt number cannot stand in for the binding', () => {
    const wrongReceipt = receipts.rows.map((row, index) => (index === 0 ? data({ ...row.values, 发票号码: '26327000001570964156' }) : row));
    const result = matchTaskLines(details(), expected, { ...receipts, rows: wrongReceipt });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /发票号与预览不一致|没有唯一对应/.test(reason))).toBe(true);
    const forgedMask = receipts.rows.map((row, index) => (index === 0 ? data({ ...row.values, 发票号码: '2642foo8021' }) : row));
    expect(matchTaskLines(details(), expected, { ...receipts, rows: forgedMask }).ok).toBe(false);
  });

  it('stays blocked without an end date, receipt bindings, or the rail receipt net/tax', () => {
    const noEndDate = { ...expected, lines: lines.map((line, index) => (index === 3 ? (({ endDate: _e, ...rest }) => rest)(line) : line)) };
    expect(matchTaskLines(details(), noEndDate, receipts).ok).toBe(false);
    expect(matchTaskLines(details(), { ...expected, receiptBindings: undefined }, receipts).ok).toBe(false);
    const noRailNetTax = { ...receipts, rows: receipts.rows.map((row, index) => (index === 0 ? data({ ...row.values, 不含税金额: '', 税额: '' }) : row)) };
    const result = matchTaskLines(details(), expected, noRailNetTax);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /对应收票没有可读值|收票不含税金额/.test(reason))).toBe(true);
  });

  it('only an explicit rail e-ticket may leave face net and tax unknown', () => {
    const missingFaceTax = { ...expected, lines: lines.map((line, index) => (index === 1 ? { ...line, netAmount: null, taxAmount: null } : line)) };
    const result = matchTaskLines(details(), missingFaceTax, receipts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /不是铁路客票.*缺少票面/.test(reason))).toBe(true);
  });

  it('real-sample shape: four receipts but three detail rows is refused even if the whole-form totals match', () => {
    const result = matchTaskLines(details(lines.slice(0, 3).map((line) => data(detailValues(line)))), expected, receipts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => /要求 4 条明细，ERP 实际为 3 条/.test(reason))).toBe(true);
  });

  it('a failed match never reports a new form as 就绪待保存; a saved form is handed off', () => {
    const wrong = details(lines.map((line, index) => data(detailValues(line, index === 0 ? { 税额: '206.03' } : {}))));
    const readings = { formMode: { readable: true, value: 'new' as const }, billNo: { readable: true, value: null },
      receiptsGrid: receipts, detailGrid: wrong };
    expect(classifyReconciliation(reconcileReadings(readings, expected))).toMatchObject({ bucket: '不自洽', action: '转人工' });
    const savedReadings = { ...readings, formMode: { readable: true, value: 'modify' as const }, billNo: { readable: true, value: 'FYBX1' } };
    expect(classifyReconciliation(reconcileReadings(savedReadings, expected))).toMatchObject({ bucket: '已保存', action: '转人工' });
  });
});
