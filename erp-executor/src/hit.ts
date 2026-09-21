// The one rule for turning an element into a point a real mouse event can reach, and the only place in the
// executor that is allowed to call `clickAt`.
//
// `Input.dispatchMouseEvent` hits VIEWPORT coordinates and nothing else. Two different things can therefore go
// wrong with a point that was read off a perfectly good element, and both are silent:
//
//   1. OUT OF VIEW. A point outside the viewport hits nothing at all. Measured live 2026-09-19 while the assistant
//      refused to open: 选择发票 sat at y=1237 and 不生成费用明细 at y=941 in a viewport 908 high,
//      `document.elementFromPoint` returned null at both, and both clicks were lost.
//   2. COVERED. A point inside the viewport belongs to whatever is painted on top of it. Measured live
//      2026-09-19 (V-54): the 处理结果 window survived the import's 退出 and floated over the form at z-index
//      10005 with no 遮罩, so `elementFromPoint(371, 334)` — the centre of the 事由 header field — answered a
//      `SPAN「接收发票」` inside the report. The click went to the report, the field never took focus, and
//      `writeHeader` blamed the control.
//
// `visible` answers neither question: an element can be laid out, painted and entirely unreachable. So every
// click in this executor goes through `clickReach`, which takes a measurement that ALREADY carries the hit test
// and refuses to click when the point does not belong to the intended element. Passing coordinates is not
// possible: the only argument it accepts is a `Reach`, and a `Reach` can only come from `HIT_JS`.
// `hit.test.ts` keeps `clickAt` out of every other module, so remembering to hit-test is not a call-site duty.

import { clickAt, type CdpSession } from './cdp';
import { ExecutorError } from './chromium';

/** What was found at the point when the target was not. */
export type Cover = { tag: string; id: string; cls: string; text: string };
/** A measured, hit-tested point. `onTarget` is the whole contract: false means DO NOT CLICK. */
export type Reach = { x: number; y: number; inView: boolean; onTarget: boolean; cover: Cover | null };

/**
 * `hitOf(n)` — where to click `n`, and what a mouse event sent there would actually reach.
 *
 * Embedded into a page expression as a function literal, the way `VIS` and `GRID_JS` are. It never scrolls:
 * scrolling is a side effect and belongs to the caller, which knows whether a write is about to happen (the
 * reconcile probe must have none). The answer is only valid for the instant it was taken, so it is taken again
 * before every click and callers poll on it.
 *
 * A hit inside the target, the target itself, or an ancestor of it all count as on target: a Kingdee control
 * paints text nodes, wrappers and overlays of its own, and the event reaches the control through any of them.
 */
export const HIT_JS = `(n) => {
  const b = n.getBoundingClientRect();
  const x = Math.round(b.x + b.width / 2);
  const y = Math.round(b.y + b.height / 2);
  // A 0x0 rect is a node that paints nothing; its centre is somebody else's point. An inline element whose only
  // child is a block box measures 0 HIGH and is real (the assistant's 电脑端选取 anchor: 76x0 live), so either
  // dimension counts as painted.
  const painted = b.width > 0 || b.height > 0;
  const inView = painted
    && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;
  if (!inView) return { x, y, inView: false, onTarget: false, cover: null };
  const reaches = (top) => !!top && (top === n || n.contains(top) || top.contains(n));
  let px = x, py = y;
  let top = document.elementFromPoint(px, py);
  if (!reaches(top)) {
    // The centre is not the only point on a target. Measured live 2026-09-20: the ERP painted a SECOND 审核 over
    // the middle of the 收票信息 section anchor (82x30 at x=271) and left it there — three reads apart, the same
    // cover — while the left fifth of that very anchor was free the whole time. The run stopped on a target it
    // could have reached, and the other three section anchors beside it were fine. So a covered centre is a
    // reason to look at the rest of the element's own box, not a reason to give up.
    //
    // The contract does not move: a point is only ever returned as on target when the hit test at THAT point
    // resolves to the target. Nothing is clicked on a guess; the search just stops throwing away the points that
    // would have worked. Ordered outwards from the centre, so the point picked is the most central free one.
    const spots = [];
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) for (const fy of [0.5, 0.3, 0.7]) spots.push([fx, fy]);
    for (const [fx, fy] of spots) {
      const cx = Math.round(b.x + b.width * fx);
      const cy = Math.round(b.y + b.height * fy);
      const here = document.elementFromPoint(cx, cy);
      if (reaches(here)) { px = cx; py = cy; top = here; break; }
    }
  }
  const onTarget = reaches(top);
  return { x: px, y: py, inView: true, onTarget,
    cover: top && !onTarget ? { tag: String(top.tagName), id: String(top.id || ''),
      cls: String(top.className || '').slice(0, 70),
      text: String(top.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) } : null };
}`;

/** The cover in the employee's words: what is in the way, not just that something is. */
export const describeCover = (cover: Cover | null | undefined) =>
  cover ? `${cover.tag}${cover.id ? `#${cover.id}` : ''}${cover.text ? `「${cover.text}」` : ''}` : '一个读不出名字的元素';

/**
 * Why this point must not be clicked, in one sentence, or null when it may be. The sentence names what is at the
 * point, because "the control did not take focus" sent a live round looking at the control for four hours while
 * the report window sat on top of it.
 */
export function reachProblem(label: string, reach: Partial<Reach> | null | undefined): string | null {
  if (!reach || typeof reach.x !== 'number' || typeof reach.y !== 'number') return `${label}没有量到落点`;
  if (!reach.inView) return `${label}滚动之后仍然不在视口里（x=${reach.x} y=${reach.y}），不在看不见的地方点击`;
  if (!reach.onTarget) {
    return `${label}的落点（x=${reach.x} y=${reach.y}）上盖着${describeCover(reach.cover)}，`
      + '点下去会点到它，所以没有点';
  }
  return null;
}

/** Click a point that has been proved to reach its target. The only `clickAt` caller in the executor. */
export async function clickReach(session: CdpSession, reach: Partial<Reach> | null | undefined, label: string, code = 'CLICK_POINT_UNREACHABLE') {
  const problem = reachProblem(label, reach);
  if (problem) throw new ExecutorError(code, problem);
  const { x, y } = reach as Reach;
  await clickAt(session, x, y);
  return { x, y };
}
