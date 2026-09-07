import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTable, displayWidth, truncate } from '../src/table.mjs';

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
