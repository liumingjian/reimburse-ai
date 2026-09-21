// Origin: 50931a3:kernel/test/erpform.test.mjs (translated to Vitest; inputs and expected outputs kept). The selectOption
// cases drop the kernel's unused `clicks`/`settleFirst` options, which selectOption never read.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { pressKey, selectAll } from './cdp';
import { headerField, selectOption, writeCell, writeHeader } from './erpform';
import { expressions, fakeSession, inputs } from './testing/fake-session';

const mousePresses = (s: ReturnType<typeof fakeSession>) => s.sent.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');

describe('erpform write primitives on a fake CDP session', () => {
  it('does not write a cell that cannot scroll into view: no click where nothing is visible', async () => {
    const s = fakeSession([{ ok: true, column: '费用金额', text: '0.00', x: 2614, y: 400, inView: false }]);
    const r = await writeCell(s, { column: '费用金额', value: '18.25', settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/不在视口/);
    expect(inputs(s).length, 'a refused write sends no input event').toBe(0);
  });

  it('clicks at the read-back coordinates and counts as matched only when the value agrees', async () => {
    const s = fakeSession([
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: true, column: '费用金额', text: '18.25', x: 900, y: 420, inView: true, onTarget: true },
    ]);
    const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect({ ok: r.ok, before: r.before, after: r.after, matched: r.matched }).toEqual({ ok: true, before: '0.00', after: '18.25', matched: true });
    const press = mousePresses(s)[0]!;
    expect([press.params.x, press.params.y]).toEqual([900, 420]);
  });

  it('writes an F7 field by code and reads back a name: only a caller-given expectation makes it pass', async () => {
    const frames = () => [
      { ok: true, column: '费用项目', text: '', x: 500, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用项目', text: '', x: 500, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: true, column: '费用项目', text: '本地市内交通', x: 500, y: 420, inView: true, onTarget: true },
    ];
    const named = fakeSession(frames());
    const r = await writeCell(named, { column: '费用项目', value: 'FY008001', expect: { mode: 'equals', value: '本地市内交通' }, clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(true);
    const blind = fakeSession(frames());
    expect((await writeCell(blind, { column: '费用项目', value: 'FY008001', readyMs: 0, settleMs: 0, settleFirst: false })).ok).toBe(false);
  });

  it('does not count an unreadable field as written', async () => {
    const s = fakeSession([
      { ok: true, column: '税额', text: '0.00', x: 700, y: 420, inView: true, onTarget: true },
      { ok: true, column: '税额', text: '', x: 700, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: false, reason: '这个网格里没有「税额」列' },
    ]);
    const r = await writeCell(s, { column: '税额', value: '0.55', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.after).toBeNull();
  });

  it('commits a header with Tab: the purpose must really blur, Enter does not count', async () => {
    const s = fakeSession([
      { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, onTarget: true },
      { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, onTarget: true, focused: true },
      { ok: true, id: 'u-FCAUSA-EDITOR', value: '客户支持', x: 300, y: 200, inView: true, onTarget: true },
    ]);
    const r = await writeHeader(s, 'FCAUSA', '客户支持', { readyMs: 0, settleMs: 0 });
    expect(r.matched).toBe(true);
    const keys = s.sent.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keys.some((k) => k.params.code === 'Tab'), 'Tab makes the control really blur').toBe(true);
    expect(keys.some((k) => k.params.code === 'Enter')).toBe(false);
  });

  it('sends no char event for select-all, or it would type an "a" into the control', async () => {
    const s = fakeSession([]);
    await selectAll(s);
    const keys = s.sent.map((c) => c.params);
    expect(keys.map((k) => k.type)).toEqual(['rawKeyDown', 'keyUp']);
    expect(keys.every((k) => k.modifiers === 4 || k.modifiers === 2)).toBe(true);
    expect(keys[0]!.commands).toEqual(['selectAll']);
  });

  it('still sends char for an unmodified Enter: Kingdee commits a cell on it', async () => {
    const s = fakeSession([]);
    await pressKey(s, 'Enter');
    expect(s.sent.map((c) => c.params.type)).toEqual(['rawKeyDown', 'char', 'keyUp']);
  });

  it('does not count a value visible in an editing input as written', async () => {
    const s = fakeSession([
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: true, editing: false, editValue: null },
      { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true, editValue: null },
      { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, onTarget: true, editing: true, editValue: '18.25' },
    ]);
    const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.matched, 'the input value must not stand in for the non-editing cell text').toBe(false);
    expect(r.editValue).toBe('18.25');
    expect(r.editing).toBe(true);
  });

  it('stops when the dropdown has no exactly-equal option instead of picking a look-alike', async () => {
    const s = fakeSession([
      { ok: true, column: '发票类型', text: '普通发票', x: 594, y: 286, inView: true, onTarget: true },
      [{ text: '普通发票', x: 594, y: 341, inView: true, onTarget: true }, { text: '增值税发票', x: 594, y: 365, inView: true, onTarget: true }],
      { ok: true, column: '发票类型', text: '普通发票', x: 594, y: 286, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    ]);
    const r = await selectOption(s, { column: '发票类型', option: '其他运输票', readyMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.options).toEqual(['普通发票', '增值税发票']);
    expect(mousePresses(s).length, 'only opened the dropdown, picked nothing').toBe(1);
    expect(s.sent.some((c) => c.params?.code === 'Escape'), 'leaves no dropdown open').toBe(true);
  });

  it('does not guess between several same-named options', async () => {
    const s = fakeSession([
      { ok: true, column: '发票类型', text: '', x: 594, y: 286, inView: true, onTarget: true },
      [{ text: '其他', x: 1, y: 2, inView: true, onTarget: true }, { text: '其他', x: 1, y: 3, inView: true, onTarget: true }],
      { ok: true, column: '发票类型', text: '', x: 594, y: 286, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    ]);
    const r = await selectOption(s, { column: '发票类型', option: '其他', readyMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/选哪个都是猜/);
  });

  it("clicks the chosen option's own coordinates, and a stale read-back means nothing was written", async () => {
    const base = (text: string) => ({ ok: true, column: '发票类型', text, x: 594, y: 286, inView: true, onTarget: true, editing: true, focused: true, editorBound: true });
    const list = [{ text: '普通发票', x: 594, y: 341, inView: true, onTarget: true }, { text: '其他运输票', x: 594, y: 436, inView: true, onTarget: true }];
    const ok = fakeSession([base('普通发票'), list, base('普通发票'), base('其他运输票')]);
    const r = await selectOption(ok, { column: '发票类型', option: '其他运输票', readyMs: 0, settleMs: 0 });
    expect(r.ok).toBe(true);
    expect(mousePresses(ok).map((c) => [c.params.x, c.params.y])).toEqual([[594, 286], [594, 436]]);

    const dropped = fakeSession([base('普通发票'), list, base('普通发票'), base('普通发票')]);
    const d = await selectOption(dropped, { column: '发票类型', option: '其他运输票', readyMs: 0, settleMs: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/回读仍然是/);
  });

  it('accepts a currency sign on money read-backs, but normalises only number shapes', async () => {
    const money = fakeSession([
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用金额', text: '', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true, onTarget: true },
    ]);
    expect((await writeCell(money, { column: '费用金额', value: '18.25', readyMs: 0, settleMs: 0, settleFirst: false })).matched).toBe(true);
    const textCell = fakeSession([
      { ok: true, column: '费用项目', text: '', x: 900, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用项目', text: '', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: true, column: '费用项目', text: '本地市内交通', x: 900, y: 420, inView: true, onTarget: true },
    ]);
    expect((await writeCell(textCell, { column: '费用项目', value: 'FY008001', readyMs: 0, settleMs: 0, settleFirst: false })).matched).toBe(false);
  });

  // V-54: a 处理结果 window floating at z-index 10005 with no 遮罩 owns every point under it, so a click aimed at
  // the cell is delivered to the report and the cell never enters edit mode. Refused before the click, naming the
  // cover — 「这一格里没有绑好的编辑控件」 was an accusation against a cell that was exactly where it said it was.
  it('does not click a cell a floating window is sitting on, and names what is at the point', async () => {
    const s = fakeSession([
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: false,
        cover: { tag: 'SPAN', id: '', cls: 'k-window-message', text: '接收发票 成功' } },
    ]);
    const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('SPAN「接收发票 成功」');
    expect(inputs(s).length, 'a covered cell is not clicked at all').toBe(0);
  });

  it('types nothing when the cell has no bound editor: typed keys would be dropped silently', async () => {
    const s = fakeSession([
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用金额', text: '0.00', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, focusTag: 'TD', editorBound: false },
    ]);
    const r = await writeCell(s, { column: '费用金额', value: '18.25', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/没有绑好的编辑控件/);
    expect(s.sent.some((c) => c.method === 'Input.dispatchKeyEvent'), 'not a single key').toBe(false);
  });

  it('treats a stale old value as not written, even when the cell already had one', async () => {
    const s = fakeSession([
      { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true, onTarget: true },
      { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
      { ok: true, column: '费用金额', text: '¥18.25', x: 900, y: 420, inView: true, onTarget: true },
    ]);
    const r = await writeCell(s, { column: '费用金额', value: '644.95', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/对不上/);
  });

  it('passes a rewrite of the value already present; it is not "no change"', async () => {
    const same = { ok: true, column: '项目', text: '某某项目-25-111454', x: 900, y: 420, inView: true, onTarget: true };
    const s = fakeSession([same, { ...same, editing: true, focused: true, editorBound: true }, same]);
    const r = await writeCell(s, { column: '项目', value: '111454', expect: { mode: 'endsWith', value: '-111454' }, clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(true);
  });

  it('types nothing into a header control that did not take focus', async () => {
    const s = fakeSession([
      { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, onTarget: true },
      { ok: true, id: 'u-FCAUSA-EDITOR', value: '', x: 300, y: 200, inView: true, onTarget: true, focused: false },
    ]);
    const r = await writeHeader(s, 'FCAUSA', '客户支持', { readyMs: 0, settleMs: 0 });
    expect(r.ok).toBe(false);
    expect(s.sent.some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(false);
  });
});

// headerField's fail-closed rules live in the JS sent into the page, so the expression is run on a fake DOM.
type FakeHeaderNode = { id: string; visible?: boolean; value?: string; tag?: string };

const fakeNode = (
  { id, visible = true, value = 'X', tag = 'INPUT' }: FakeHeaderNode,
  { scrolled, all }: { scrolled: string[]; all: FakeHeaderNode[] },
) => ({
  id,
  tagName: tag,
  value,
  innerText: value,
  getBoundingClientRect: () => (visible
    ? { width: 120, height: 22, x: 60, y: 30, left: 0, right: 120, top: 20, bottom: 42 }
    : { width: 0, height: 0, x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0 }),
  matches: (selector: string) => selector === 'input,textarea' && tag === 'INPUT',
  // A wrapper's nested controls are the other fake nodes whose id starts with its own, as the live DOM nests them.
  querySelectorAll: () => (tag === 'INPUT' ? [] : all.filter((n) => n.id !== id && n.id.startsWith(id))
    .map((n) => fakeNode(n, { scrolled, all }))),
  contains: () => false,
  scrollIntoView: () => scrolled.push(id),
});

/**
 * A stand-in for whatever is painted at the field's point. `null` models a clear form: a node that contains
 * everything, which is what the real page answers when the control's own wrapper is on top. `cover` models the
 * V-54 shape — a report window owning the point instead.
 */
const TOP_OF_THE_STACK = { tagName: 'DIV', id: '', className: '', textContent: '', contains: () => true };
const COVERING_REPORT = { tagName: 'SPAN', id: '', className: 'k-window-message', textContent: '接收发票 成功', contains: () => false };

async function runHeaderField(nodes: FakeHeaderNode[], { scroll = true, key = 'FBILLNO', covered = false } = {}) {
  const probe = fakeSession([null]);
  await headerField(probe, key, { scroll });
  const [expression] = expressions(probe);
  const scrolled: string[] = [];
  const built = nodes.map((n) => fakeNode(n, { scrolled, all: nodes }));
  const ctx = {
    document: { querySelectorAll: () => built, activeElement: null,
      elementFromPoint: () => (covered ? COVERING_REPORT : TOP_OF_THE_STACK) },
    getComputedStyle: (n: { id: string }) => {
      const hidden = nodes.find((x) => x.id === n.id)?.visible === false;
      return { visibility: hidden ? 'hidden' : 'visible', display: hidden ? 'none' : 'block' };
    },
    innerWidth: 1440, innerHeight: 900,
  };
  return { result: vm.runInNewContext(expression!, ctx), scrolled };
}

describe('headerField fails closed (issue #36 backlog)', () => {
  it('zero visible instances -> ok:false, no silent fall-back to a stale instance', async () => {
    const { result } = await runHeaderField([{ id: 'aaa-FBILLNO-EDITOR', visible: false, value: 'FYBX2025120001' }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/没有可见实例/);
    expect(result.visibleInstances).toBe(0);
  });

  it('several visible instances -> ok:false, any pick is a guess', async () => {
    const { result } = await runHeaderField([{ id: 'aaa-FBILLNO-EDITOR', value: 'FYBX2025120001' }, { id: 'bbb-FBILLNO-EDITOR', value: 'FYBX2026090007' }]);
    expect(result.ok).toBe(false);
    expect(result.visibleInstances).toBe(2);
  });

  // Live 2026-09-19, FCAUSA on one open form: a wrapper and an -EDITOR control, two visible nodes under one
  // form-instance prefix. Counting nodes called that "2 个可见实例" and refused the write, microseconds after the
  // read path had read the same field successfully.
  it('accepts the wrapper and the -EDITOR control of ONE form instance as one instance', async () => {
    const { result } = await runHeaderField([
      { id: 'aaa-FCAUSA', tag: 'DIV', value: '' },
      { id: 'aaa-FCAUSA-EDITOR', value: '广州本地用车' },
    ], { key: 'FCAUSA' });
    expect(result.reason).toBeUndefined();
    expect([result.ok, result.visibleInstances, result.visibleNodes]).toEqual([true, 1, 2]);
    expect([result.id, result.instance, result.value]).toEqual(['aaa-FCAUSA-EDITOR', 'aaa', '广州本地用车']);
  });

  // The locator is asked one more question than «where is it»: what a mouse event sent there would reach. Live
  // 2026-09-19 the answer was a SPAN「接收发票」 inside the 处理结果 window floating over the form, and the write
  // that followed blamed the control for not taking focus.
  it('reports what is at the field\'s point, so a covered field is never typed into', async () => {
    const nodes = [{ id: 'aaa-FCAUSA-EDITOR', value: '' }];
    expect(await runHeaderField(nodes, { key: 'FCAUSA' }).then((r) => r.result.onTarget)).toBe(true);
    const { result } = await runHeaderField(nodes, { key: 'FCAUSA', covered: true });
    expect(result.ok, 'the field is still found: being covered is not being missing').toBe(true);
    expect([result.onTarget, result.cover.tag, result.cover.text]).toEqual([false, 'SPAN', '接收发票 成功']);
  });

  it('gives a value only for exactly one visible instance; the read-only probe never scrolls', async () => {
    const nodes = [{ id: 'aaa-FBILLNO-EDITOR', value: 'FYBX2026090007' }];
    const write = await runHeaderField(nodes);
    expect([write.result.ok, write.result.value]).toEqual([true, 'FYBX2026090007']);
    expect(write.scrolled, 'a write scrolls the field back into view').toEqual(['aaa-FBILLNO-EDITOR']);
    const read = await runHeaderField(nodes, { scroll: false });
    expect(read.result.value).toBe('FYBX2026090007');
    expect(read.scrolled, 'no scroll on the reconcile path').toEqual([]);
  });
});

// The 开始日期 defect of 2026-09-19, measured on the live control 2026-09-20 (`server/scripts/probe-date.ts`):
// the editor is a Kendo datepicker the ERP opens pre-filled with today, it ignores select-all, and the typed
// date is appended to today's — which the datepicker then parses off the front, keeping today.
describe('emptying a pre-filled editor before typing', () => {
  const dateFrames = (cleared: string) => [
    { ok: true, column: '开始日期', text: '2026/9/20', x: 400, y: 850, inView: true, onTarget: true },
    { ok: true, column: '开始日期', text: '', editValue: '2026/9/20', x: 400, y: 850, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '开始日期', text: '', editValue: cleared, x: 400, y: 850, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    // Twice over, because the commit is not pressed until the editor has been READ holding the typed value: one
    // reading could still be a value mid-reformat. This is the datepicker answering that it has taken the date.
    { ok: true, column: '开始日期', text: '', editValue: '2026/9/6', x: 400, y: 850, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '开始日期', text: '', editValue: '2026/9/6', x: 400, y: 850, inView: true, onTarget: true, editing: true, focused: true, editorBound: true },
    { ok: true, column: '开始日期', text: '2026/9/6', x: 400, y: 850, inView: true, onTarget: true },
  ];

  it('backspaces the pre-filled date away and types only after the editor reads empty', async () => {
    const s = fakeSession(dateFrames(''));
    const r = await writeCell(s, { column: '开始日期', value: '2026/9/6', expect: { mode: 'equals', value: '2026/9/6' }, clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect({ ok: r.ok, before: r.before, after: r.after }).toEqual({ ok: true, before: '2026/9/20', after: '2026/9/6' });
    const keys = inputs(s).filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type !== 'keyUp');
    const backspaces = keys.filter((c) => c.params.key === 'Backspace');
    expect(backspaces.length, 'one Backspace per character, plus one for a live selection').toBe('2026/9/20'.length + 1);
    expect(keys.filter((c) => c.params.key === 'Delete').length, 'and as many Deletes, for what sits right of the caret').toBe('2026/9/20'.length + 1);
    const firstTyped = keys.findIndex((c) => typeof c.params.text === 'string' && c.params.text === '2');
    const lastClearing = keys.map((c) => c.params.key).lastIndexOf('Delete');
    expect(lastClearing, 'nothing is typed until the old value is gone').toBeLessThan(firstTyped);
  });

  it('refuses to type into an editor it could not empty, instead of appending to what is there', async () => {
    // Two rounds of Backspace, both read back the untouched value: the control is not answering.
    const stuck = dateFrames('2026/9/20');
    const s = fakeSession([stuck[0], stuck[1], stuck[2], stuck[2]]);
    const r = await writeCell(s, { column: '开始日期', value: '2026/9/6', clicks: 1, readyMs: 0, settleMs: 0, settleFirst: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/清不空/);
    expect(inputs(s).some((c) => c.params.text === '6'), 'no character of the new date was typed').toBe(false);
  });
});
