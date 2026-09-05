import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCell, writeHeader, selectOption } from '../src/erpform.mjs';
import { pressKey, selectAll } from '../src/chrome.mjs';

// 假会话：Runtime.evaluate 按顺序吐预先排好的返回值，其余命令只记账。
// 要钉住的是"发了哪些输入事件、在什么坐标上发"，这跟浏览器无关。
function fakeSession(evaluations) {
  const sent = [];
  const queue = [...evaluations];
  return {
    sent,
    send(method, params) {
      sent.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (queue.length === 0) throw new Error('求值次数超出预期');
        return Promise.resolve({ result: { value: queue.shift() } });
      }
      return Promise.resolve({});
    },
    close() {},
  };
}
const inputs = (s) => s.sent.filter((c) => c.method.startsWith('Input.'));

test('单元格滚不进视口就不写 —— 看不见的地方一次都不点', async () => {
  const s = fakeSession([{ ok: true, column: '费用金额', text: '0.00', x: 2614, y: 400, inView: false }]);
  const r = await writeCell(s, { column: '费用金额', value: '18.25' , settleFirst: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不在视口/);
  assert.equal(inputs(s).length, 0, '拒绝写入时不该发出任何输入事件');
});

test('写单元格：点在回读到的坐标上，值一致才算 matched', async () => {
  const s = fakeSession([
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true },
    { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '费用金额', text: '18.25', x: 900, y: 420, inView: true },
  ]);
  const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false  });
  assert.deepEqual(
    { ok: r.ok, before: r.before, after: r.after, matched: r.matched },
    { ok: true, before: '0.00', after: '18.25', matched: true });
  const press = s.sent.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.deepEqual([press.params.x, press.params.y], [900, 420]);
});

test('F7 字段按编码写、回读出名称：预期由调用方给出，对得上才算写进去', async () => {
  const frames = () => [
    { ok: true, column: '费用项目', text: '', x: 500, y: 420, inView: true },
    { ok: true, column: '费用项目', text: '', x: 500, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '费用项目', text: '本地市内交通', x: 500, y: 420, inView: true },
  ];
  const named = fakeSession(frames());
  const r = await writeCell(named, { column: '费用项目', value: 'FY008001',
    expect: { mode: 'equals', value: '本地市内交通' }, clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
  assert.equal(r.ok, true);
  assert.equal(r.matched, true);

  // 没有预期出处就没法判断"本地市内交通"是不是 FY008001，只能算没通过。
  const blind = fakeSession(frames());
  assert.equal((await writeCell(blind, { column: '费用项目', value: 'FY008001',
    readyMs: 0, settleMs: 0 , settleFirst: false })).ok, false);
});

test('回读不出来的字段不算写成功', async () => {
  const s = fakeSession([
    { ok: true, column: '税额', text: '0.00', x: 700, y: 420, inView: true },
    { ok: true, column: '税额', text: '', x: 700, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: false, reason: '这个网格里没有「税额」列' },
  ]);
  const r = await writeCell(s, { column: '税额', value: '0.55', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false  });
  assert.equal(r.ok, false);
  assert.equal(r.after, null);
});

test('表头用 Tab 提交 —— 事由必须真实失焦，Enter 不算', async () => {
  const s = fakeSession([
    { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true },
    { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, focused: true },
    { ok: true, id: 'u-FCAUSA-EDITOR', value: '客户支持', x: 300, y: 200, inView: true },
  ]);
  const r = await writeHeader(s, 'FCAUSA', '客户支持', { readyMs: 0, settleMs: 0 });
  assert.equal(r.matched, true);
  const keys = s.sent.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.ok(keys.some((k) => k.params.code === 'Tab'), '应当用 Tab 让控件真实失焦');
  assert.ok(!keys.some((k) => k.params.code === 'Enter'));
});

test('全选不发 char 事件 —— 否则"全选"会变成往控件里输入一个 a', async () => {
  const s = fakeSession([]);
  await selectAll(s);
  const keys = s.sent.map((c) => c.params);
  assert.deepEqual(keys.map((k) => k.type), ['rawKeyDown', 'keyUp']);
  assert.ok(keys.every((k) => k.modifiers === 4 || k.modifiers === 2));
  // 光发修饰键不管用，实测控件不会全选；全选靠 commands 分发。
  assert.deepEqual(keys[0].commands, ['selectAll']);
});

test('不带修饰键的 Enter 仍然发 char —— 金蝶靠它提交单元格', async () => {
  const s = fakeSession([]);
  await pressKey(s, 'Enter');
  assert.deepEqual(s.sent.map((c) => c.params.type), ['rawKeyDown', 'char', 'keyUp']);
});

test('编辑态里 input 上看得见的值不算写成功', async () => {
  const s = fakeSession([
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, editing: false, editValue: null },
    { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, editing: true, focused: true, editorBound: true, editValue: null },
    { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, editing: true, editValue: '18.25' },
  ]);
  const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false  });
  assert.equal(r.matched, false, '编辑态的 input 值不能顶替非编辑态的单元格文本');
  assert.equal(r.editValue, '18.25');
  assert.equal(r.editing, true);
});

test('下拉里没有完全一致的候选项就停下，不挑个像的凑合', async () => {
  const s = fakeSession([
    { ok: true, column: '发票类型', text: '普通发票', x: 594, y: 286, inView: true },
    [{ text: '普通发票', x: 594, y: 341 }, { text: '增值税发票', x: 594, y: 365 }],
    { ok: true, column: '发票类型', text: '普通发票', x: 594, y: 286, inView: true, editing: true, focused: true, editorBound: true },
  ]);
  const r = await selectOption(s, { column: '发票类型', option: '其他运输票', readyMs: 0 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.options, ['普通发票', '增值税发票']);
  const clicks = s.sent.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.equal(clicks.length, 1, '只点开了下拉，没有点中任何一项');
  assert.ok(s.sent.some((c) => c.params?.code === 'Escape'), '不留一个张着的下拉');
});

test('同名候选项有多个也不猜', async () => {
  const s = fakeSession([
    { ok: true, column: '发票类型', text: '', x: 594, y: 286, inView: true },
    [{ text: '其他', x: 1, y: 2 }, { text: '其他', x: 1, y: 3 }],
    { ok: true, column: '发票类型', text: '', x: 594, y: 286, inView: true, editing: true, focused: true, editorBound: true },
  ]);
  const r = await selectOption(s, { column: '发票类型', option: '其他', readyMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /选哪个都是猜/);
});

test('选中之后点的是那一项自己的坐标，回读对不上就算没写进去', async () => {
  const base = (text) => ({ ok: true, column: '发票类型', text, x: 594, y: 286, inView: true, editing: true, focused: true, editorBound: true });
  const list = [{ text: '普通发票', x: 594, y: 341 }, { text: '其他运输票', x: 594, y: 436 }];
  const ok_ = fakeSession([base('普通发票'), list, base('普通发票'), base('其他运输票')]);
  const r = await selectOption(ok_, { column: '发票类型', option: '其他运输票', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
  assert.equal(r.ok, true);
  const clicks = ok_.sent.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  assert.deepEqual(clicks.map((c) => [c.params.x, c.params.y]), [[594, 286], [594, 436]]);

  // 下拉是照着文本点的，回读还是旧值就是被静默丢掉了 —— 这必须报失败，不是"值不一样"。
  const dropped = fakeSession([base('普通发票'), list, base('普通发票'), base('普通发票')]);
  const d = await selectOption(dropped, { column: '发票类型', option: '其他运输票', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
  assert.equal(d.ok, false);
  assert.match(d.reason, /回读仍然是/);
});

test('金额回读带货币符号也算写对了，但只对数字形状归一化', async () => {
  const money = fakeSession([
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true },
    { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true },
  ]);
  assert.equal((await writeCell(money, { column: '费用金额', value: '18.25', readyMs: 0, settleMs: 0 , settleFirst: false })).matched, true);
  const text = fakeSession([
    { ok: true, column: '费用项目', text: '', x: 900, y: 420, inView: true },
    { ok: true, column: '费用项目', text: '', x: 900, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '费用项目', text: '本地市内交通', x: 900, y: 420, inView: true },
  ]);
  assert.equal((await writeCell(text, { column: '费用项目', value: 'FY008001', readyMs: 0, settleMs: 0 , settleFirst: false })).matched, false);
});

test('这一格里没有绑好的编辑控件就不打字 —— 打进去的字会被静默丢掉', async () => {
  const s = fakeSession([
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true },
    { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true,
      editing: true, focused: true, focusTag: 'TD', editorBound: false },
  ]);
  const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有绑好的编辑控件/);
  assert.ok(!s.sent.some((c) => c.method === 'Input.dispatchKeyEvent'), '一个键都不该敲出去');
});

test('回读还是老值就是没写进去 —— 哪怕这一格本来就有值', async () => {
  const s = fakeSession([
    { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true },
    { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true },
  ]);
  const r = await writeCell(s, { column: '费用金额', value: '644.95', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /对不上/);
});

test('本来就已经是要写的值，重写一遍算通过，不算"没变化"', async () => {
  const same = { ok: true, column: '项目', text: '某某项目-25-111454', x: 900, y: 420, inView: true };
  const s = fakeSession([same, { ...same, editing: true, focused: true, editorBound: true }, same]);
  const r = await writeCell(s, { column: '项目', value: '111454',
    expect: { mode: 'endsWith', value: '-111454' }, clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
  assert.equal(r.ok, true);
});

test('表头控件没拿到焦点也不打字', async () => {
  const s = fakeSession([
    { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true },
    { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, focused: false },
  ]);
  const r = await writeHeader(s, 'FCAUSA', '客户支持', { readyMs: 0, settleMs: 0 });
  assert.equal(r.ok, false);
  assert.ok(!s.sent.some((c) => c.method === 'Input.dispatchKeyEvent'));
});
