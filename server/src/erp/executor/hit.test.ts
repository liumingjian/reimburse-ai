// The hit-test rule, and the rule that keeps it from being bypassed.
//
// Two defects have recurred on this branch, three and four times each: a wait whose verdict is discarded, and a
// click on a point that was never hit-tested. The second one is not a call-site discipline any more — there is
// one function that clicks, it takes a measurement rather than coordinates, and it refuses a measurement that
// does not reach its target. The source scan below is what makes that structural instead of a convention.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HIT_JS, describeCover, reachProblem, type Reach } from './hit';

const here = fileURLToPath(new URL('.', import.meta.url));
const at = (over: Partial<Reach> = {}): Reach => ({ x: 10, y: 20, inView: true, onTarget: true, cover: null, ...over });

describe('the hit-tested click', () => {
  it('is the only door to clickAt: no other executor module calls it', () => {
    const files = readdirSync(here, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => !['cdp.ts', 'hit.ts'].includes(name));
    const callers = files.filter((name) => /\bclickAt\s*\(/.test(readFileSync(join(here, name), 'utf8')));
    // `cdp.ts` defines it and `hit.ts` is the one caller; a new call anywhere else is a click that nobody
    // hit-tested, which is how the 处理结果 window came to swallow the fill's first keystroke (V-54).
    expect(callers).toEqual([]);
  });

  it('refuses a point that is outside the viewport, and says so', () => {
    expect(reachProblem('表头字段 FCAUSA', at({ inView: false, onTarget: false }))).toContain('不在视口里');
  });

  it('refuses a covered point, naming what is at it rather than blaming the control', () => {
    const cover = { tag: 'SPAN', id: '', cls: 'k-window-message', text: '接收发票' };
    const problem = reachProblem('表头字段 FCAUSA', at({ onTarget: false, cover }));
    // The live message was 「焦点没有落进这个控件」, which sent a round looking at a control that was fine.
    expect(problem).toContain('SPAN「接收发票」');
    expect(problem).toContain('x=10 y=20');
  });

  it('allows a point that reaches its target', () => {
    expect(reachProblem('表头字段 FCAUSA', at())).toBe(null);
  });

  it('refuses a measurement that was never taken', () => {
    expect(reachProblem('表头字段 FCAUSA', null)).toContain('没有量到落点');
  });

  it('names an unnamed cover rather than saying nothing', () => {
    expect(describeCover(null)).toContain('读不出名字');
    expect(describeCover({ tag: 'DIV', id: 'result-window', cls: '', text: '' })).toBe('DIV#result-window');
  });

  it('measures and hit-tests in one page expression', () => {
    // The snippet is evaluated in the page, so the test drives it with a stand-in document.
    const rect = (y: number) => ({ x: 0, y, left: 0, right: 20, top: y, bottom: y + 10, width: 20, height: 10 });
    const cover = { tagName: 'SPAN', id: '', className: 'k-window-message', textContent: '接收发票', contains: () => false };
    const make = (top: unknown) => new Function('innerWidth', 'innerHeight', 'document', `return (${HIT_JS})`)(
      100, 100, { elementFromPoint: () => top });
    const node = { getBoundingClientRect: () => rect(0), contains: () => false };
    expect(make(node)(node)).toMatchObject({ x: 10, y: 5, inView: true, onTarget: true, cover: null });
    expect(make(cover)(node)).toMatchObject({ onTarget: false, cover: { tag: 'SPAN', text: '接收发票' } });
    // A node laid out past the bottom of the viewport is not clicked at all: a real mouse event reaches nothing
    // there, and `elementFromPoint` answers null (measured live 2026-09-19 at y=1237 in a viewport 908 high).
    const below = { getBoundingClientRect: () => rect(900), contains: () => false };
    expect(make(null)(below)).toMatchObject({ inView: false, onTarget: false });
  });
});
