// Read-only: catch the 发票无忧助手's 温馨提示 announcement while it is on screen, and name its dismiss control.
//
// The live stop it exists for (2026-09-20): a fill that had just got past 打开空白报销单 died in the assistant
// with «「数电票」里的发票 …7691 的勾选框上面盖着DIV「温馨提示本次更新后，功能增强。原【上传单张发票】按钮和
// 【上传含多张发票的PDF】」，点不到它，没有导入任何发票». Same shape as V-61: a notice nobody answered, sitting
// over a control the run must click. The guard was right; what is missing is the name of the thing to dismiss.
//
// The assistant only exists while a run has it open, so this WAITS for the piaozone target to appear rather than
// requiring one. It clicks nothing, uploads nothing and imports nothing.
//   pnpm --filter @baox/server exec tsx scripts/probe-notice.ts [waitSeconds]
import { autoAttach, connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';
import { sleep } from '@baox/erp-executor/pace';
import { DISMISSALS, dismissalPoint } from '@baox/erp-executor/notices';

const NOTICE = '温馨提示';
const SNIPPET = `(() => {
  const vis = (n) => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const txt = (n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim();
  const box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const all = [...document.querySelectorAll('body *')].filter(vis);
  // The OUTERMOST visible node carrying the notice wording is the panel; its descendants repeat the text.
  const carriers = all.filter((n) => txt(n).includes(${JSON.stringify(NOTICE)}));
  const panels = carriers.filter((n) => !carriers.some((m) => m !== n && m.contains(n)));
  return {
    url: location.href,
    size: [innerWidth, innerHeight],
    panelCount: panels.length,
    panels: panels.map((p) => {
      const cs = getComputedStyle(p);
      return {
        tag: p.tagName, id: p.id || null, cls: String(p.className || '').slice(0, 90),
        z: cs.zIndex, pos: cs.position, rect: box(p), text: txt(p).slice(0, 220),
        // Anything inside it that a person would click to make it go away, by its own visible words.
        controls: [...p.querySelectorAll('button, a, span, div, i')].filter(vis)
          .filter((b) => { const t = txt(b); return t.length > 0 && t.length <= 8 && !b.querySelector('button, a'); })
          .map((b) => ({ tag: b.tagName, cls: String(b.className || '').slice(0, 60), text: txt(b), rect: box(b) })),
        // Close affordances carry no text at all, so they are looked for separately.
        closers: [...p.querySelectorAll('[class*="close"], [aria-label*="lose"], [class*="Close"]')].filter(vis)
          .map((b) => ({ tag: b.tagName, cls: String(b.className || '').slice(0, 60), text: txt(b).slice(0, 12), rect: box(b) })),
      };
    }),
  };
})()`;

const waitSeconds = Number(process.argv[2] ?? 180);
// The assistant is not a `page` in /json/list: it is an auto-attached child target of the ERP page, which is how
// `steps.ts` reaches it too. So this attaches to the ERP page FIRST and waits for the child to appear — start it
// before the run that opens the assistant, or there is nothing to catch.
const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const page = await connect(erp.webSocketDebuggerUrl!);
const children = await autoAttach(page);
console.log('attached to ERP page, waiting for 发票无忧助手 …');
const session = await children.waitFor((url: string) => url.includes('piaozone'), { timeout: waitSeconds * 1000, interval: 500 });
if (!session) { console.error(`no 发票无忧助手 child target appeared within ${waitSeconds}s`); process.exit(1); }
console.log('assistant attached');
try {
  // Sampled repeatedly: the notice is painted by the assistant's own render, not on load.
  for (let i = 0; i < 40; i += 1) {
    const out = await evalIn<any>(session, SNIPPET).catch((error) => ({ error: String(error) }));
    console.log(`[${i}]`, JSON.stringify(out));
    // What the PRODUCTION rule makes of this same page, verbatim — a refusal here is the thing to explain.
    for (const { caption } of DISMISSALS) {
      const point = await evalIn<any>(session, dismissalPoint(caption)).catch((error) => ({ thrown: String(error).slice(0, 200) }));
      console.log(`[${i}] rule ${caption}:`, JSON.stringify(point));
    }
    if (out?.panelCount > 0) break;
    await sleep(1000);
  }
} finally { page.close(); }
