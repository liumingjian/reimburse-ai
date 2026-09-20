// The notices ERP and its invoice assistant raise BY THEMSELVES, and the one way this executor is allowed to
// answer them.
//
// Both halves of the product paint panels nobody asked for, over controls a run must click, and neither goes away
// on its own. Measured live 2026-09-20, both inside one hour:
//
//   1. ERP's session idle prompt — a Kendo `k-window` titled 金蝶提示 reading 系统闲置时间过长，即将自动退出，
//      请确认是否退出？, with a `k-overlay` under it spanning (0,0)-(412,120): exactly the header menu strip.
//      Two runs died at 打开空白报销单 ten days apart, both naming «(x=96 y=61) 上盖着DIV» (V-61).
//   2. The assistant's release announcement — an Ant Design modal (`div.ant-modal-wrap`, z-index 9999) at
//      (0,0)-(800,530), i.e. the WHOLE assistant viewport, titled 温馨提示 and explaining that the two upload
//      buttons were merged into one. The run died on it with «发票助手里「数电票」里的发票 …7691 的勾选框上面
//      盖着DIV「温馨提示…」，点不到它，没有导入任何发票».
//
// The hit test was right every time. What was missing was a way to clear what it correctly refused to click
// through — and on an UNATTENDED run there is nobody to clear it.
//
// THE RULE: a notice is answered by the CAPTION of its dismissal, never by its position, never by «the panel's
// only button», and never by closing the panel some other way. `DISMISSALS` is the mirror image of the
// never-click list: a caption goes in only when the word itself cannot move a 单据 — 不退出 keeps a session,
// 知道了 acknowledges an announcement. Neither can save, submit, approve, import or delete anything, so clicking
// one is safe even if the panel that carries it turns out to be a panel nobody has seen yet. A caption whose
// meaning depends on which panel it is in does not belong here.
//
// Recognising by caption rather than by the panel's wording is also what keeps this from rotting: the assistant's
// announcement text will change with its next release, and 知道了 will not.

import { evalIn, type CdpSession } from './cdp';
import { HIT_JS, clickReach, type Reach } from './hit';

/** A caption this executor may click to make a notice go away, and why that word is safe to click blind. */
export type Dismissal = { caption: string; why: string };

export const DISMISSALS: readonly Dismissal[] = [
  { caption: '不退出', why: 'ERP 闲置退出提示的「留下」。它只保住会话；相邻的「继续退出」会退出登录，所以绝不按位置选。' },
  { caption: '知道了', why: '发票助手版本公告的确认。它只关掉公告，不碰任何发票、单据或按钮。' },
];

const VISIBLE = `(n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}`;

/**
 * Where the dismissal captioned `caption` is, and whether a mouse event sent there would reach it.
 *
 * Exactly one match, or nothing: two nodes carrying the same caption mean the page is not the page this was
 * measured against, and a click would be a guess. Ant Design paints the caption on the `button` AND on a `span`
 * inside it, which is one control and two matches — so a match that CONTAINS another match is dropped, leaving
 * the outermost node. That is a shape, not a framework; Kendo's plain `button` survives it unchanged.
 */
export const dismissalPoint = (caption: string) => `(() => {
  const vis = ${VISIBLE};
  const hitOf = ${HIT_JS};
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const wanted = ${JSON.stringify(caption)};
  const hits = [...document.querySelectorAll('body *')].filter(vis).filter((n) => txt(n) === wanted);
  const outer = hits.filter((n) => !hits.some((m) => m !== n && m.contains(n)));
  if (outer.length !== 1) return { ok: false, count: outer.length };
  return { ok: true, ...hitOf(outer[0]) };
})()`;

type Point = Partial<Reach> & { ok: boolean; count?: number };
const reachable = (point: Point | null | undefined) => point?.ok === true && point.onTarget === true;

/**
 * Answer whichever known notice is up in this document, and say which caption was clicked.
 *
 * It never throws and it never reports a problem. A document with no notice is the normal case; a notice this
 * cannot reach is not this function's refusal to make — the caller is already on its way to reporting one of its
 * own, with the cover named, and all this does is remove a cause of it that HAS a name. When nothing is
 * dismissed, nothing was clicked, and the caller's refusal stands exactly as it did before.
 */
export async function dismissNotice(session: CdpSession): Promise<string | null> {
  for (const { caption } of DISMISSALS) {
    const point = await evalIn<Point>(session, dismissalPoint(caption)).catch(() => null);
    if (!reachable(point)) continue;
    await clickReach(session, point as Reach, `「${caption}」`, 'CHROMIUM_TARGET_OBSTRUCTED');
    return caption;
  }
  return null;
}
