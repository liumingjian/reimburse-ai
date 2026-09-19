// Throwaway read-only probe: when `writeHeader` says 「点了表头字段 FCAUSA 之后焦点没有落进这个控件」, what is
// actually at the point it clicked? Reads only — no click, no key, no navigation — so it can be pointed at a form
// left standing by a failed run and answer what that run saw.
import { connect, enableFocusEmulation, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { headerFieldSnippet } from '../src/erp/executor/header-locator';
import { dialogsSnippet } from '../src/erp/executor/tabs';

const key = process.argv[2] ?? 'FCAUSA';

const hitOf = (x: number, y: number) => `(() => {
  const hit = document.elementFromPoint(${x}, ${y});
  if (!hit) return { hit: null };
  const chain = [];
  for (let n = hit; n && n.nodeType === 1 && chain.length < 6; n = n.parentElement) {
    chain.push({ tag: n.tagName, id: n.id || null, cls: String(n.className || '').slice(0, 60), z: getComputedStyle(n).zIndex });
  }
  return { tag: hit.tagName, id: hit.id || null, text: String(hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), chain };
})()`;

const WINDOWS = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return [...document.querySelectorAll('.k-window')].filter(vis).map((n) => {
    const b = n.getBoundingClientRect();
    return { id: n.id || null, z: getComputedStyle(n).zIndex, rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      text: String(n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  });
})()`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  console.log('focus emulation:', JSON.stringify(await enableFocusEmulation(session)));
  console.log('visibility:', JSON.stringify(await evalIn(session, `({ v: document.visibilityState, f: document.hasFocus(), w: innerWidth, h: innerHeight })`)));
  console.log('dialogs:', JSON.stringify(await evalIn(session, dialogsSnippet)));
  console.log('windows:', JSON.stringify(await evalIn(session, WINDOWS), null, 1));
  // No scroll: a probe must not move the page a later run measures.
  const field = await evalIn<{ ok: boolean; x: number; y: number; [k: string]: unknown }>(session, headerFieldSnippet(key, { scroll: false }));
  console.log(`headerField ${key}:`, JSON.stringify(field));
  if (field?.ok) console.log('what is at that point:', JSON.stringify(await evalIn(session, hitOf(field.x, field.y)), null, 1));
  // Why did 处理结果 stay open? `importInvoices` clicks a single visible `[id$="-tbExit"]` and then discards the
  // result of its own «is it gone?» wait, so every 退出 candidate on the page is worth naming.
  console.log('tbExit candidates:', JSON.stringify(await evalIn(session, `(() => {
    const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    return [...document.querySelectorAll('[id$="-tbExit"]')].map((n) => {
      const b = n.getBoundingClientRect();
      const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
      const hit = document.elementFromPoint(x, y);
      const a = hit && hit.closest ? hit.closest('[id]') : null;
      return { id: n.id, visible: vis(n), text: String(n.textContent || '').trim().slice(0, 20),
        rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        hitTag: hit ? hit.tagName : null, hitId: a ? a.id : null };
    });
  })()`), null, 1));
  console.log('activeElement:', JSON.stringify(await evalIn(session, `(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id || null, cls: String(a.className || '').slice(0, 60) } : null; })()`)));
} finally {
  session.close();
}
