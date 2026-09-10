import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readErpForm, readFormTabs, readGridByColumn, readHeaderField } from '../src/erpread.mjs';

const page = { transport: 'ego', taskSpace: 1, tabId: 'fixture-tab' };

test('只读适配层通过 ego evaluator 读取快照，不发点击或滚动动作', async () => {
  const calls = [];
  const evaluate = async (receivedPage, expression, options) => {
    calls.push({ receivedPage, expression, options });
    assert.doesNotThrow(() => new Function(`return ${expression}`), 'generated page expression must parse');
    if (expression.includes('费用报销单-(新增|修改)')) {
      return [{ label: '费用报销单-新增', mode: 'new', x: 100, y: 40 }];
    }
    if (expression.includes('const want =')) return [{ label: '明细信息', x: 10, y: 40 }];
    if (expression.includes('const key = "FBILLNO"')) return { ok: true, value: '' };
    if (expression.includes('申请报销金额')) return {
      ok: true, matchedGrids: 1, columns: [{ label: '申请报销金额' }], rowCount: 1,
      rows: [{ kind: 'data', values: { '申请报销金额': '¥703.00' } }],
    };
    if (expression.includes('价税合计')) return {
      ok: true, matchedGrids: 1, columns: [{ label: '价税合计' }], rowCount: 1,
      rows: [{ kind: 'data', values: { '价税合计': '¥703.00' } }],
    };
    throw new Error('unexpected expression');
  };

  const snapshot = await readErpForm(page, { evaluate });
  assert.equal(snapshot.formTabs[0].mode, 'new');
  assert.equal(snapshot.billNo.value, '');
  assert.equal(snapshot.detail.rows[0].values['申请报销金额'], '¥703.00');
  assert.equal(snapshot.receipts.rows[0].values['价税合计'], '¥703.00');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ receivedPage }) => receivedPage === page));
  assert.ok(calls.every(({ options }) => options.timeoutMs === 15_000));
  assert.ok(calls.every(({ expression }) => !/scrollIntoView|click\s*\(|Input\./.test(expression)));
});

test('只读适配层按唯一表头列定位网格，不接受旧 Chrome 页面句柄', async () => {
  const expressions = [];
  const evaluate = async (_page, expression) => {
    expressions.push(expression);
    return { ok: false, reason: 'fixture' };
  };

  await readGridByColumn(page, '价税合计', { evaluate });
  await readHeaderField(page, 'FBILLNO', { evaluate });
  assert.ok(expressions[0].includes('const label = "价税合计"'));
  assert.ok(expressions[0].includes('hits.length > 1'));
  assert.ok(!expressions[0].includes('scrollIntoView'));
  assert.ok(!expressions[1].includes('scrollIntoView'));

  await assert.rejects(
    () => readFormTabs({ transport: 'chrome', wsUrl: 'ws://legacy' }),
    (error) => error.code === 'EGO_PAGE_REQUIRED',
  );
});

test('默认 evaluator 没有 ego page 时直接拒绝，不尝试旧 session', async () => {
  await assert.rejects(
    () => readGridByColumn({ transport: 'chrome', wsUrl: 'ws://legacy' }, '价税合计'),
    (error) => error.code === 'EGO_PAGE_REQUIRED',
  );
});

const box = (visible = true) => visible
  ? { width: 120, height: 22, x: 60, y: 30, left: 0, right: 120, top: 20, bottom: 42 }
  : { width: 0, height: 0, x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0 };

const headerNode = (id, { visible = true, child = null } = {}) => ({
  id,
  innerText: '',
  tagName: 'DIV',
  getBoundingClientRect: () => box(visible),
  matches: () => false,
  querySelectorAll: () => child ? [child] : [],
});

const headerInput = (value = '') => ({
  id: 'unused-input-id',
  tagName: 'INPUT',
  value,
  getBoundingClientRect: () => box(),
  matches: (selector) => selector.includes('input'),
  querySelectorAll: () => [],
});

async function runHeaderExpression(nodes) {
  let expression;
  await readHeaderField(page, 'FBILLNO', {
    evaluate: async (_page, script) => { expression = script; },
  });
  return vm.runInNewContext(expression, {
    document: { querySelectorAll: () => nodes },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    innerWidth: 1440,
    innerHeight: 900,
  });
}

test('表头 wrapper、EDITOR 和内部 input 属于一个 form 实例，回读实际 input', async () => {
  const input = headerInput('');
  const editor = headerNode('form-a-FBILLNO-EDITOR', { child: input });
  const wrapper = headerNode('form-a-FBILLNO', { child: editor });
  const result = await runHeaderExpression([wrapper, editor]);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'form-a-FBILLNO-EDITOR');
  assert.equal(result.tag, 'INPUT');
  assert.equal(result.visibleInstances, 1);
  assert.equal(result.visibleNodes, 2);
});

test('两个不同 form prefix 的真实可见 input 仍拒绝，不能选第一个', async () => {
  const inputA = headerInput('A');
  const editorA = headerNode('form-a-FBILLNO-EDITOR', { child: inputA });
  const wrapperA = headerNode('form-a-FBILLNO', { child: editorA });
  const inputB = headerInput('B');
  const editorB = headerNode('form-b-FBILLNO-EDITOR', { child: inputB });
  const wrapperB = headerNode('form-b-FBILLNO', { child: editorB });
  const result = await runHeaderExpression([wrapperA, editorA, wrapperB, editorB]);
  assert.equal(result.ok, false);
  assert.equal(result.visibleInstances, 2);
  assert.match(result.reason, /2 个可见表单实例/);
});
