import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryRows, verifyExpenseItems, verifyProject, isSafeKey } from '../src/erpcatalog.mjs';
import { CATEGORIES } from '../src/categories.mjs';

// ERP 只读查询的报文形状取自 2026-09-05 实测：
// 成功时外层数组直接就是行集，每行按 FieldKeys 顺序排列。
const rowsOf = (rows) => async () => ({ ok: true, rows });
const failWith = (reason) => async () => ({ ok: false, reason });

const erpRow = (code, name, doc = 'C', forbid = 'A') => [code, name, doc, forbid];
const allGood = () => Object.values(CATEGORIES)
  .filter((c) => c.expenseItemCode)
  .map((c) => erpRow(c.expenseItemCode, c.expenseItemName));

test('对照表里的四个费用项目编码在 ERP 目录里逐一确认', async () => {
  const r = await verifyExpenseItems(null, { run: rowsOf(allGood()) });
  assert.equal(r.ok, true);
  assert.equal(r.problems.length, 0);
  assert.equal(r.checked.length, 4);
  assert.ok(r.checked.every((c) => c.verdict === 'confirmed'));
});

test('编码对得上但名字对不上，是错位，不是小差异', async () => {
  const rows = allGood();
  rows[0] = erpRow(rows[0][0], '别的什么费用');
  const r = await verifyExpenseItems(null, { run: rowsOf(rows) });
  const bad = r.problems.find((p) => p.verdict === 'name_mismatch');
  assert.ok(bad);
  assert.match(bad.note, /不要改名字将就/);
});

test('被禁用或未审核的费用项目不能引用', async () => {
  const forbidden = allGood().map((row, i) => (i === 0 ? [...row.slice(0, 3), 'B'] : row));
  assert.equal((await verifyExpenseItems(null, { run: rowsOf(forbidden) }))
    .problems[0].verdict, 'unusable');
  const draft = allGood().map((row, i) => (i === 0 ? [row[0], row[1], 'A', 'A'] : row));
  assert.equal((await verifyExpenseItems(null, { run: rowsOf(draft) }))
    .problems[0].verdict, 'unusable');
});

test('ERP 目录里查不到的编码要点名，不是默默略过', async () => {
  const r = await verifyExpenseItems(null, { run: rowsOf(allGood().slice(1)) });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].verdict, 'missing');
});

test('查询本身失败不等于核对通过', async () => {
  const r = await verifyExpenseItems(null, { run: failWith('业务对象不存在') });
  assert.equal(r.ok, false);
  assert.equal(r.problems, undefined);
});

test('项目号唯一命中才算确认', async () => {
  const r = await verifyProject(null, '111454',
    { run: rowsOf([erpRow('111454', '某某项目')]) });
  assert.equal(r.verdict, 'confirmed');
  assert.equal(r.name, '某某项目');
});

test('项目号查不到、或对上多条，都不放行且都不替用户挑', async () => {
  assert.equal((await verifyProject(null, '999999', { run: rowsOf([]) })).verdict, 'missing');
  const dup = await verifyProject(null, '111454',
    { run: rowsOf([erpRow('111454', 'A'), erpRow('111454', 'B')]) });
  assert.equal(dup.verdict, 'ambiguous');
  assert.match(dup.note, /不替你挑/);
});

test('项目号里的引号在到达 ERP 之前就被挡掉', async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true, rows: [] }; };
  const r = await verifyProject(null, "111454' or '1'='1", { run: spy });
  assert.equal(r.ok, false);
  assert.equal(called, false, '不安全的项目号不应该发出任何查询');
  assert.equal(isSafeKey("111454' or '1'='1"), false);
  assert.equal(isSafeKey('111454'), true);
});

test('正式默认浏览器 page 可承载只读目录查询，旧 wsUrl 仍阻塞', async () => {
  const page = {
    transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
    windowId: '7', tabId: '11', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
    origin: 'http://erp.antute.com.cn',
  };
  const calls = [];
  const result = await queryRows(page, {
    formId: 'BD_Expense', fieldKeys: 'FNumber,FName', filter: '', limit: 5,
  }, {
    evaluate: async (receivedPage, expression, options) => {
      calls.push({ receivedPage, expression, options });
      return { parsed: [['FY008001', '本地市内交通']] };
    },
  });
  assert.deepEqual(result, { ok: true, rows: [['FY008001', '本地市内交通']] });
  assert.equal(calls[0].receivedPage, page);
  assert.equal(calls[0].options.timeoutMs, 30000);
  assert.equal(calls[0].options.origin, 'http://erp.antute.com.cn');
  assert.match(calls[0].expression, /ExecuteBillQuery/);

  const blocked = await queryRows({ transport: 'chrome', wsUrl: 'ws://legacy' }, {
    formId: 'BD_Expense', fieldKeys: 'FNumber', limit: 1,
  });
  assert.equal(blocked.code, 'EGO_REQUIRED');
});
