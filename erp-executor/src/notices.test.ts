// The rule for answering a notice, driven with a stand-in document the way `hit.test.ts` drives `HIT_JS`.
//
// Two things are worth pinning here, and neither is reachable from a job-level test: what happens when the
// caption appears TWICE (Ant Design paints it on the button and on a span inside it — one control, two matches),
// and what happens when it appears twice in earnest (two separate panels, which is not a page this was ever
// measured against, and a click would be a guess).
import { describe, expect, it } from 'vitest';
import { DISMISSALS, dismissalPoint } from './notices';

/** A node the snippet can measure: `vis` needs a rect and a style, `hitOf` needs a rect and `contains`. */
const node = (text: string, { x = 0, y = 0, inside = [] as any[] } = {}) => {
  const self: any = {
    textContent: text,
    getBoundingClientRect: () => ({ x, y, left: x, right: x + 20, top: y, bottom: y + 10, width: 20, height: 10 }),
    contains: (other: unknown) => other === self || inside.includes(other),
  };
  return self;
};

const evaluate = (caption: string, nodes: any[], topAt: (x: number, y: number) => any) =>
  new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return ${dismissalPoint(caption)}`)(
    { querySelectorAll: () => nodes, elementFromPoint: topAt },
    () => ({ visibility: 'visible', display: 'block' }),
    1000, 1000,
  );

describe('answering a notice', () => {
  it('measures the one node carrying the caption, and says it can be clicked', () => {
    const button = node('知道了');
    expect(evaluate('知道了', [button], () => button)).toMatchObject({ ok: true, onTarget: true });
  });

  it('takes the OUTERMOST node when one control paints the caption twice', () => {
    // Live shape: `button.ant-btn > span`, both reading 知道了. Picking the span would still work by luck; picking
    // «the first match» would depend on document order, which is not something this may depend on.
    const span = node('知道了', { x: 10, y: 10 });
    const button = node('知道了', { x: 0, y: 0, inside: [span] });
    const point = evaluate('知道了', [button, span], () => button);
    expect(point).toMatchObject({ ok: true, x: 10, y: 5 });
  });

  it('refuses when two separate panels carry the caption, rather than picking one', () => {
    const first = node('知道了', { x: 0, y: 0 });
    const second = node('知道了', { x: 100, y: 100 });
    expect(evaluate('知道了', [first, second], () => first)).toMatchObject({ ok: false, count: 2 });
  });

  it('refuses when the caption is nowhere on the page', () => {
    expect(evaluate('不退出', [node('继续退出')], () => null)).toMatchObject({ ok: false, count: 0 });
  });

  it('refuses a caption whose point belongs to something else, rather than clicking through it', () => {
    const button = node('知道了');
    const cover = node('别的东西');
    expect(evaluate('知道了', [button], () => cover)).toMatchObject({ ok: true, onTarget: false });
  });

  it('never matches a caption by prefix: 不退出 is not 继续退出', () => {
    expect(evaluate('不退出', [node('继续退出'), node('不退出')], (_x, _y) => null).count).not.toBe(2);
  });

  it('lists only captions that cannot move a 单据, each with its reason', () => {
    // The mirror image of the never-click list. A caption gets in on what the WORD can do, not on which panel it
    // happens to sit in today — that is what makes clicking it safe on a panel nobody has seen yet.
    expect(DISMISSALS.map((d) => d.caption)).toEqual(['不退出', '知道了']);
    for (const { caption, why } of DISMISSALS) {
      expect(why.length).toBeGreaterThan(10);
      for (const forbidden of ['保存', '提交', '审核', '删除', '导入', '付款', '下推']) {
        expect(caption).not.toContain(forbidden);
      }
    }
  });
});
