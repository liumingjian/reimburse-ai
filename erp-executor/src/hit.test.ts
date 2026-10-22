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
    expect(describeCover({ tag: 'DIV', id: '', cls: 'kd-ui-blockingExtention-item other', text: '' })).toBe('DIV.kd-ui-blockingExtention-item');
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

  // Measured live 2026-09-20: the ERP painted a SECOND 审核 over the middle of the 收票信息 section anchor
  // (82x30 at x=271, y=130) and left it there — three reads apart, the same cover — while the left fifth of that
  // very anchor was free the whole time. The whole 去报销 stopped on a target it could have reached. This is what
  // stops anyone going back to measuring the centre alone.
  it('finds a free point inside a target whose centre is covered, rather than giving up on it', () => {
    // The live geometry: the cover owns x >= 306 of an anchor running 271..353.
    const anchorRect = { x: 271, y: 130, left: 271, right: 353, top: 130, bottom: 160, width: 82, height: 30 };
    const node = { getBoundingClientRect: () => anchorRect, contains: () => false };
    const cover = { tagName: 'SPAN', id: '', className: 'k-link', textContent: '审核', contains: () => false };
    const hit = new Function('innerWidth', 'innerHeight', 'document', `return (${HIT_JS})`)(
      2048, 1035, { elementFromPoint: (x: number) => (x >= 306 ? cover : node) })(node);
    expect(hit).toMatchObject({ inView: true, onTarget: true, cover: null });
    // The point it settled on is one the hit test really answered with the anchor.
    expect(hit.x).toBeLessThan(306);
    expect(hit.x).toBeGreaterThanOrEqual(271);
    expect(hit.y).toBeGreaterThanOrEqual(130);
    expect(hit.y).toBeLessThanOrEqual(160);
  });

  it('still refuses a target that is covered everywhere, and still names the cover', () => {
    const rect30 = { x: 0, y: 0, left: 0, right: 80, top: 0, bottom: 30, width: 80, height: 30 };
    const node = { getBoundingClientRect: () => rect30, contains: () => false };
    const cover = { tagName: 'DIV', id: 'result-window', className: '', textContent: '处理结果', contains: () => false };
    const hit = new Function('innerWidth', 'innerHeight', 'document', `return (${HIT_JS})`)(
      2048, 1035, { elementFromPoint: () => cover })(node);
    expect(hit).toMatchObject({ onTarget: false, cover: { tag: 'DIV', id: 'result-window' } });
  });
});
