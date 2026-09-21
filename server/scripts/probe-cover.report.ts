// Measure why the 收票信息 section anchor was unreachable: window size, the anchor's rect, and what sits on it.
//   pnpm --filter @baox/server exec tsx scripts/probe-cover.report.ts
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const SNIPPET = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const out = { window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, anchors: [], toolbar: [] };
  for (const n of document.querySelectorAll('*')) {
    if (n.children.length !== 0 || !vis(n)) continue;
    const t = n.textContent.trim();
    if (['基本信息', '付款信息', '明细信息', '收票信息'].includes(t) && n.getBoundingClientRect().y <= 260) {
      const b = n.getBoundingClientRect();
      const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
      const hit = document.elementFromPoint(x, y);
      // Every point inside the anchor's own box, not just its centre: a cover over the middle does not mean the
      // whole target is out of reach.
      const free = [];
      for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) for (const fy of [0.25, 0.5, 0.75]) {
        const px = Math.round(b.x + b.width * fx), py = Math.round(b.y + b.height * fy);
        const h = document.elementFromPoint(px, py);
        if (h === n || n.contains(h)) free.push([px, py]);
      }
      out.anchors.push({ label: t, x, y, rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)], free,
        hit: hit ? { tag: hit.tagName, text: String(hit.textContent).trim().slice(0, 12), cls: String(hit.className).slice(0, 40) } : null });
    }
    if (['审核', '保存', '提交', '新增'].includes(t)) {
      const b = n.getBoundingClientRect();
      out.toolbar.push({ label: t, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
    }
  }
  return JSON.stringify(out);
})()`;

const port = cdpPortOf(process.env);
const page = (await targets(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)[0];
if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 ERP 页面');
const session = await connect(page.webSocketDebuggerUrl);
try { console.log(await evalIn<string>(session, SNIPPET)); } finally { session.close(); }
