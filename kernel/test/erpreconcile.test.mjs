import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReconciliation, readReconciliation, sumColumn, toCents,
  BUCKETS, ACTIONS } from '../src/erpreconcile.mjs';

// 钉的是外部行为：给定四项读数得到哪一格、哪一种处置；
// 给定只读 reader 返回，发出了哪些（有没有发出）读取动作。
// 不断言 DOM 查询串长什么样 —— 那是 erpread 的适配层职责。

// 一张对得上的单：收票 703.00，明细申请报销金额 703.00。
const R = (o = {}) => ({
  formMode: { readable: true, value: 'new' },
  billNo: { readable: true, value: null },
  receipts: { readable: true, totalCents: 70300, rowCount: 1 },
  detail: { readable: true, totalCents: 70300, rowCount: 1 },
  payable: { readable: true, totalCents: 70300 },
  ...o,
});
const saved = (o = {}) => R({ formMode: { readable: true, value: 'modify' },
  billNo: { readable: true, value: 'FYBX2026090007' }, ...o });

test('六格各一例，处置照 #36 的映射表', () => {
  const cases = [
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
    assert.deepEqual([v.bucket, v.action], [bucket, action], `${bucket} 判错了`);
    assert.ok(BUCKETS.includes(v.bucket) && ACTIONS.includes(v.action));
  }
});

test('转人工恰好只有三格 —— 其余一律原地等待', () => {
  const byBucket = {
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
  assert.deepEqual(handoff.sort(), ['不自洽', '未保存·已导入未写明细'].sort());
  // 第三格是 `已保存` + 恒等式不成立 —— 它和 `已保存` + 成立 是同一格的两种处置。
  assert.equal(classifyReconciliation(saved({ detail: { readable: true, totalCents: 70299, rowCount: 1 } })).action, '转人工');
});

test('未知最先求值：其它三项凑成"已保存"的形状也不放行', () => {
  for (const missing of ['formMode', 'billNo', 'receipts', 'detail']) {
    const v = classifyReconciliation(saved({ [missing]: { readable: false, value: null, totalCents: null, reason: '读不到' } }));
    assert.equal(v.bucket, '未知', `${missing} 读不到时不该给出 已保存`);
    assert.equal(v.action, '原地等待');
    assert.ok(v.reasons.some((r) => /读不到/.test(r)), '要说清楚是哪一项读不到');
  }
});

test('假绿反例：收票 0 行 + 明细空单元格，不能落到"就绪待保存"', () => {
  const v = classifyReconciliation(R({
    receipts: { readable: true, totalCents: 0, rowCount: 0 },
    detail: { readable: false, totalCents: null, rowCount: null, reason: '第 1 行的「申请报销金额」是空的' },
  }));
  assert.ok(['未保存·导入前', '未知'].includes(v.bucket), `不该是 ${v.bucket}`);
  assert.equal(v.action, '原地等待');
});

test('收票有行、明细读不出来 -> 已导入未写明细，转人工', () => {
  const v = classifyReconciliation(R({
    detail: { readable: false, totalCents: null, rowCount: null, reason: '第 1 行的「申请报销金额」是空的' },
  }));
  assert.deepEqual([v.bucket, v.action], ['未保存·已导入未写明细', '转人工']);
});

test('恒等式按分零容差：差 1 分就是不自洽', () => {
  const off = classifyReconciliation(R({ detail: { readable: true, totalCents: 70301, rowCount: 1 } }));
  assert.equal(off.bucket, '不自洽');
  assert.deepEqual(
    { equal: off.identity.equal, r: off.identity.receiptsCents, d: off.identity.detailCents },
    { equal: false, r: 70300, d: 70301 });
});

test('申请付款金额只是旁证：不改中断点，只进证据', () => {
  const withOdd = classifyReconciliation(R({ payable: { readable: true, totalCents: 12345 } }));
  const clean = classifyReconciliation(R());
  assert.deepEqual([withOdd.bucket, withOdd.action], [clean.bucket, clean.action]);
  assert.ok(withOdd.reasons.some((r) => /申请付款金额/.test(r)), '旁证不等要留在证据里');
});

test('已保存 + 恒等式成立 -> 原地等待；不成立 -> 转人工', () => {
  assert.equal(classifyReconciliation(saved()).action, '原地等待');
  assert.equal(classifyReconciliation(saved({ receipts: { readable: true, totalCents: 70100, rowCount: 1 } })).action, '转人工');
});

test('新增却有单号、修改却无单号 -> 不自洽，原样报读数', () => {
  const a = classifyReconciliation(R({ billNo: { readable: true, value: 'FYBX2026090007' } }));
  const b = classifyReconciliation(saved({ billNo: { readable: true, value: null } }));
  assert.deepEqual([a.bucket, a.action], ['不自洽', '转人工']);
  assert.deepEqual([b.bucket, b.action], ['不自洽', '转人工']);
});

// —— 逐行相加的三条 fail-closed 判据 ——

const grid = (rows, column = '价税合计', extraColumns = []) => ({
  ok: true,
  columns: [{ label: '序号' }, { label: column }, ...extraColumns.map((label) => ({ label }))],
  rowCount: rows.filter((r) => r.kind !== 'total').length,
  rows,
});
const dataRow = (values) => ({ kind: 'data', values });
const totalRow = (values) => ({ kind: 'total', values });

test('金额按分解析，不走浮点', () => {
  assert.deepEqual(['¥18.80', '1,234.56', '703', '0.05', '-1.20'].map(toCents), [1880, 123456, 70300, 5, -120]);
  assert.deepEqual(['', '  ', '-', '一百', null].map(toCents), [null, null, null, null, null]);
  // 0.1 + 0.2 这类误差在分的整数上不存在。
  assert.equal(sumColumn(grid([dataRow({ '价税合计': '0.10' }), dataRow({ '价税合计': '0.20' })]), '价税合计').totalCents, 30);
});

test('空单元格判不可读，绝不当 0', () => {
  const r = sumColumn(grid([dataRow({ '价税合计': '18.80' }), dataRow({ '价税合计': '' })]), '价税合计');
  assert.equal(r.readable, false);
  assert.equal(r.totalCents, null);
  assert.match(r.reason, /空|不当 0/);
});

test('认不出这一列 -> 整个网格不可读', () => {
  const r = sumColumn(grid([dataRow({ '价税合计': '18.80' })]), '申请报销金额');
  assert.equal(r.readable, false);
  assert.match(r.reason, /认不出/);
});

test('合计行不进加总；它和逐行相加对不上时整个网格不可读', () => {
  const good = sumColumn(grid([dataRow({ '价税合计': '644.95' }), dataRow({ '价税合计': '58.05' }),
    totalRow({ '价税合计': '703.00' })]), '价税合计');
  assert.deepEqual([good.readable, good.totalCents, good.rowCount], [true, 70300, 2]);

  const bad = sumColumn(grid([dataRow({ '价税合计': '644.95' }), totalRow({ '价税合计': '703.00' })]), '价税合计');
  assert.equal(bad.readable, false);
  assert.match(bad.reason, /合计行/);
});

test('网格自己读不出来 -> 这一项不可读，原因原样带出来', () => {
  const r = sumColumn({ ok: false, reason: '有 2 个可见网格的表头都有「价税合计」列，认不出该读哪个' }, '价税合计');
  assert.deepEqual([r.readable, r.totalCents], [false, null]);
  assert.match(r.reason, /认不出该读哪个/);
});

// —— 只读采集：一次输入事件都不发 ——

const detailGrid = (rows) => ({ ok: true, matchedGrids: 1,
  columns: [{ label: '序号' }, { label: '费用金额' }, { label: '税额' },
    { label: '申请报销金额' }, { label: '申请付款金额' }],
  rowCount: rows.length, rows });

const readFixture = ({ tabs, bill, receipts, detail }) => {
  const page = { transport: 'ego', taskSpace: 1, tabId: 'fixture-tab' };
  const calls = [];
  return { page, calls, receipts, detail, options: {
    readTabs: async (p) => { calls.push(['tabs', p]); return tabs; },
    readHeader: async (p, key) => { calls.push(['header', p, key]); return bill; },
    readGrid: async (p, column) => {
      calls.push(['grid', p, column]);
      return column === '价税合计' ? receipts : detail;
    },
  } };
};

test('readReconciliation 采四项读数，且只调用只读 reader', async () => {
  const fixture = readFixture({
    tabs: [{ label: '费用报销单-新增', mode: 'new', x: 100, y: 40 }],
    bill: { ok: true, id: 'aaa-FBILLNO-EDITOR', value: '', instances: 1, visibleInstances: 1 },
    receipts: { ok: true, matchedGrids: 1, columns: [{ label: '序号' }, { label: '价税合计' }],
      rowCount: 1, rows: [{ kind: 'data', values: { '序号': '1', '价税合计': '¥703.00' } }] },
    detail: detailGrid([{ kind: 'data', values: { '序号': '1', '费用金额': '¥644.95', '税额': '¥58.05',
      '申请报销金额': '¥703.00', '申请付款金额': '¥703.00' } }]),
  });
  const readings = await readReconciliation(fixture.page, fixture.options);

  assert.deepEqual(readings.formMode, { readable: true, value: 'new' });
  assert.deepEqual(readings.billNo, { readable: true, value: null });
  assert.deepEqual([readings.receipts.readable, readings.receipts.totalCents, readings.receipts.rowCount], [true, 70300, 1]);
  assert.deepEqual([readings.detail.readable, readings.detail.totalCents], [true, 70300]);
  assert.deepEqual(readings.payable, { readable: true, totalCents: 70300 });
  assert.equal(readings.receiptsGrid, fixture.receipts);
  assert.equal(readings.detailGrid, fixture.detail);

  assert.deepEqual(fixture.calls.map(([kind, , value]) => [kind, value]), [
    ['tabs', undefined], ['header', 'FBILLNO'], ['grid', '价税合计'], ['grid', '申请报销金额'],
  ]);

  const v = classifyReconciliation(readings);
  assert.deepEqual([v.bucket, v.action], ['未保存·就绪待保存', '原地等待']);
});

test('页面上同时开着两个单据页签 -> 页签模式不可读，回未知', async () => {
  const fixture = readFixture({
    tabs: [{ label: '费用报销单-新增', mode: 'new' }, { label: '费用报销单-修改', mode: 'modify' }],
    bill: { ok: true, value: 'FYBX2026090007' },
    receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 0, rows: [] },
    detail: detailGrid([]),
  });
  const readings = await readReconciliation(fixture.page, fixture.options);
  assert.equal(readings.formMode.readable, false);
  assert.match(readings.formMode.reason, /同时开着 2 个/);
  assert.equal(classifyReconciliation(readings).bucket, '未知');
  assert.equal(fixture.calls.filter(([kind]) => kind === 'input').length, 0);
});

test('表头字段没有恰好一个可见实例 -> 单据编号不可读', async () => {
  const fixture = readFixture({
    tabs: [{ label: '费用报销单-修改', mode: 'modify' }],
    bill: { ok: false, reason: '表头字段 FBILLNO 有 2 个可见实例，认不出是哪一张单的', visibleInstances: 2 },
    receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 0, rows: [] },
    detail: detailGrid([]),
  });
  const readings = await readReconciliation(fixture.page, fixture.options);
  assert.equal(readings.billNo.readable, false);
  assert.match(readings.billNo.reason, /2 个可见实例/);
  assert.equal(classifyReconciliation(readings).bucket, '未知');
});

test('明细网格还没渲染出来 -> 明细不可读，对账不去点开它', async () => {
  const fixture = readFixture({
    tabs: [{ label: '费用报销单-新增', mode: 'new' }],
    bill: { ok: true, value: '' },
    receipts: { ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 1,
      rows: [{ kind: 'data', values: { '价税合计': '¥703.00' } }] },
    detail: { ok: false, matchedGrids: 0, reason: '页面上没有哪个可见网格的表头有「申请报销金额」列' },
  });
  const readings = await readReconciliation(fixture.page, fixture.options);
  assert.equal(readings.detail.readable, false);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'input').length, 0,
    '懒渲染的明细也不点开 —— 点开是页面副作用');
  const v = classifyReconciliation(readings);
  assert.deepEqual([v.bucket, v.action], ['未保存·已导入未写明细', '转人工']);
});

test('旧浏览器 session 不能进入 erp-reconcile 只读路径', async () => {
  await assert.rejects(
    () => readReconciliation({ transport: 'chrome', wsUrl: 'ws://legacy' }),
    (error) => error.code === 'BROWSER_PAGE_REQUIRED',
  );
});
