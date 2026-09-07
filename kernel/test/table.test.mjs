import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTable, renderQuestions, displayWidth, truncate } from '../src/table.mjs';

// 表格是用户做判断用的界面。它渲染在内核，所以「好不好读」这件事
// 和模型是谁无关 —— 这一层测的就是它对齐得住、截得住、渲染两遍一模一样。

const COLS = [
  { key: 'material', label: '材料', max: 20 },
  { key: 'field', label: '字段', max: 12 },
  { key: 'value', label: '我读到的', max: 24 },
];

test('中文按两格算宽，整张表每一行等宽', () => {
  const out = renderTable(COLS, [
    { material: 'invoice.png（发票）', field: '发票号码', value: '26427000000640558021' },
    { material: '', field: '价税合计', value: '18.80' },
    { material: '打车.png（发票）', field: '开票日期', value: '2026-09-04' },
  ]);
  const lines = out.split('\n');
  const widths = new Set(lines.map(displayWidth));
  assert.equal(widths.size, 1, `每一行的显示宽度应当一致，实际有 ${[...widths].join('/')}`);
  assert.ok(out.includes('26427000000640558021'), '发票号码不能被截断 —— 用户要比对的就是它');
});

test('同一份读数渲染两次，一个字节都不差', () => {
  const rows = [{ material: 'a.png（发票）', field: '价税合计', value: '18.80' }];
  assert.equal(renderTable(COLS, rows), renderTable(COLS, rows));
});

test('太长的值按显示宽度截断，不按字符数', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('ab'), 2);
  assert.equal(truncate('一二三四五', 6), '一二…');
  assert.equal(truncate('短', 6), '短');
  // 宽字符凑不满最后一格是常事，超出上限才是错 —— 超出会把整张表挤歪。
  assert.ok(displayWidth(truncate('一二三四五', 6)) <= 6);
  assert.ok(displayWidth(truncate('abcdefgh', 5)) <= 5);
});

test('缺的值渲染成空白，不渲染成 undefined', () => {
  const out = renderTable(COLS, [{ field: '价税合计' }]);
  assert.ok(!out.includes('undefined'));
});

test('没有一行时也渲染得出表头 —— 空表也是一个要说清楚的结果', () => {
  const out = renderTable(COLS, []);
  assert.ok(out.includes('我读到的'));
  assert.equal(out.split('\n').length, 4);
});

// —— 问题块 ——
// 问题和表格一个道理：它是给用户做判断的界面，所以整块由内核渲染，模型只搬运。
// 不走任何提问工具 —— 用户可以把那种工具关掉，别的 Agent 也未必有它。

const QS = [
  { id: 'q-1', header: '第 1 段', question: '曹操.pdf：望京 → 北京南站的价税合计是多少？',
    options: [
      { label: '26.69', description: '行程单第 1 行写的就是这个数' },
      { label: '这张票我认不出', description: '整张退回待办' },
      { label: '其他', description: '这一段的价税合计我直接告诉你' },
    ],
    multiSelect: false },
  { id: 'q-2', header: '第 2 段', question: '曹操.pdf：第 2 段的价税合计是多少？',
    options: [{ label: '这张票我认不出' }, { label: '其他' }], multiSelect: false },
];

test('每个选项都带编号，末项那个「其他」不会被吞掉', () => {
  const out = renderQuestions(QS);
  assert.match(out, /1\) 26\.69/);
  assert.match(out, /3\) 其他/);
  assert.ok(out.includes('行程单第 1 行写的就是这个数'), '选项的说明也要贴出去');
  assert.ok(out.includes('第 1 段') && out.includes('第 2 段'), '两题都在');
  assert.ok(!out.includes('undefined'), '没有 description 的选项不许渲染出 undefined');
});

test('同一批问题渲染两次一模一样 —— 界面只跟内容有关', () => {
  assert.equal(renderQuestions(QS), renderQuestions(QS));
});

test('末尾要告诉用户怎么答，否则他不知道说编号就行', () => {
  assert.match(renderQuestions(QS), /编号/);
  assert.match(renderQuestions([QS[0]]), /编号/);
});

test('可多选的题要说出来 —— 用户看不见控件，只能靠这句话', () => {
  const out = renderQuestions([{ ...QS[0], multiSelect: true }]);
  assert.match(out, /可以选多个/);
  assert.doesNotMatch(renderQuestions(QS), /可以选多个/);
});
