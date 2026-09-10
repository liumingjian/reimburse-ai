import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cellMatches, clickEgo, selectAllEgo, writeCell, writeHeader } from '../src/erpform-ego.mjs';

const page = { transport: 'ego', taskSpace: 1, tabId: 'fixture-tab' };

const depsFor = (evaluations) => {
  const calls = [];
  const queue = [...evaluations];
  return {
    calls,
    deps: {
      evaluate: async (_page, expression) => {
        calls.push(['evaluate', expression]);
        if (!queue.length) throw new Error('evaluation queue exhausted');
        return queue.shift();
      },
      click: async (_page, x, y) => calls.push(['click', x, y]),
      selectAll: async () => calls.push(['selectAll']),
      type: async (_page, value) => calls.push(['type', value]),
      press: async (_page, key) => calls.push(['press', key]),
      sleep: async (ms) => calls.push(['sleep', ms]),
    },
  };
};

test('ego 单元格写入按定位、真实点击、全选、逐键、Enter、回读顺序执行', async () => {
  const { calls, deps } = depsFor([
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true },
    { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true,
      focused: true, editorBound: true, editing: true },
    { ok: true, column: '费用金额', text: '18.25', x: 900, y: 420, inView: true },
  ]);
  const result = await writeCell(page, { column: '费用金额', value: '18.25', clicks: 1,
    readyMs: 0, settleMs: 0, settleFirst: false }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter(([kind]) => kind !== 'evaluate'), [
    ['click', 900, 420], ['selectAll'], ['type', '18.25'], ['press', 'Enter'],
  ]);
  assert.equal(calls.filter(([kind]) => kind === 'evaluate').length, 3);
});

test('没有真实 input 焦点时停止，不能把字打进会静默丢弃的控件', async () => {
  const { calls, deps } = depsFor([
    { ok: true, column: '税额', text: '0.00', x: 700, y: 420, inView: true },
    { ok: true, column: '税额', text: '0.00', x: 700, y: 420, inView: true,
      focused: true, editorBound: false, focusTag: 'TD', editing: true },
  ]);
  const result = await writeCell(page, { column: '税额', value: '0.55', clicks: 1,
    readyMs: 0, settleMs: 0, settleFirst: false }, deps);

  assert.equal(result.ok, false);
  assert.ok(!calls.some(([kind]) => kind === 'selectAll' || kind === 'type' || kind === 'press'));
});

test('表头使用 Tab 真实失焦，回读一致才通过', async () => {
  const { calls, deps } = depsFor([
    { ok: true, id: 'form-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true },
    { ok: true, id: 'form-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, focused: true },
    { ok: true, id: 'form-FCAUSA-EDITOR', value: '客户支持', x: 300, y: 200, inView: true },
  ]);
  const result = await writeHeader(page, 'FCAUSA', '客户支持', { readyMs: 0, settleMs: 0 }, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter(([kind]) => kind !== 'evaluate'), [
    ['click', 300, 200], ['selectAll'], ['type', '客户支持'], ['press', 'Tab'], ['sleep', 0],
  ]);
});

test('项目和费用项目只接受完整预期名称，不接受名字后缀等于编码', () => {
  assert.equal(cellMatches('中国农业发展银行河南省分行-20-2614', '39163', {
    mode: 'endsWith', value: '-39163',
  }), false);
  assert.equal(cellMatches('中国农业发展银行河南省分行-20-2614', '39163', {
    mode: 'equals', value: '中国农业发展银行河南省分行-20-2614',
  }), true);
  assert.equal(cellMatches('本地市内交通', 'FY008001', null), false);
});

test('ego 字段适配不引入 Chrome/CDP 模块', () => {
  const source = fs.readFileSync(new URL('../src/erpform-ego.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("'./chrome.mjs'") && !source.includes("'./erpform.mjs'"));
});

test('ego 动作脚本先切到指定 task-space 页面，再执行点击', async () => {
  let script = null;
  await clickEgo(page, 12, 34, { run: async (body) => { script = body; return true; } });
  assert.match(script, /switchTab\(tab\.targetId \?\? tab\.id\)/);
  assert.match(script, /click\(\[12, 34\]\)/);
});

test('ego 全选使用带 selectAll 命令的 CDP 输入事件', async () => {
  let script = null;
  await selectAllEgo(page, { run: async (body) => { script = body; return true; } });
  assert.match(script, /cdp\('Input\.dispatchKeyEvent'/);
  assert.match(script, /commands: \['selectAll'\]/);
  assert.match(script, new RegExp(`modifiers: ${process.platform === 'darwin' ? 4 : 2}`));
  assert.doesNotMatch(script, /Control\+A|Meta\+A|doubleClick/);
});
