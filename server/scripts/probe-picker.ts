// Read-only: why does `computerPickerPoint` (erp-executor/src/steps.ts) not find the 电脑端选取 entry on the live
// 发票无忧助手 (piaozone invoice assistant)? Dumps the caption node, its ancestors and every clickable descendant
// around it. Clicks nothing, uploads nothing, imports nothing, so it consumes no invoice and creates no 收票占用.

import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const SNIPPET = `(() => {
  const vis = (n) => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const desc = (n) => n ? {
    tag: n.tagName, id: n.id || null, cls: String(n.className || '').slice(0, 80),
    href: n.getAttribute ? n.getAttribute('href') : null, visible: vis(n),
    box: (() => { const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })(),
  } : null;

  const out = { url: location.href.split('?')[0] };

  // Every node whose own text is exactly the caption, visible or not.
  const all = [...document.querySelectorAll('body *')];
  const captions = all.filter((n) => own(n) === '电脑端选取');
  out.captionNodes = captions.map((n) => ({ ...desc(n), parents: (() => {
    const chain = []; let p = n.parentElement;
    for (let i = 0; i < 5 && p; i += 1) { chain.push(desc(p)); p = p.parentElement; }
    return chain;
  })() }));

  // What the current snippet decides.
  const caption = captions.find(vis) || null;
  out.snippetCaptionFound = Boolean(caption);
  if (caption) {
    const item = caption.closest('.accessItem');
    out.closestAccessItem = desc(item);
    const scope = item || caption.parentElement;
    out.scope = desc(scope);
    out.anchorsInScope = scope ? [...scope.querySelectorAll('a[href]')].map(desc) : [];
    out.allClickableInScope = scope ? [...scope.querySelectorAll('a,button,img,div[onclick],[role=button]')].map(desc) : [];
  }

  // Any element carrying accessItem-ish classes, to see what the real container is called.
  out.classesOnPage = [...new Set(all.map((n) => String(n.className || '')).filter((c) => typeof c === 'string' && c && c.length < 60))].slice(0, 60);
  return out;
})()`;

const all = await targets(cdpPortOf());
const target = all.find((t) => String(t.url).includes('piaozone'));
if (!target) {
  console.error('assistant iframe not open; targets:', all.map((t) => `${t.type} ${String(t.url).split('?')[0]}`));
  process.exit(1);
}
const session = await connect(target.webSocketDebuggerUrl!);
try {
  console.log(JSON.stringify(await evalIn(session, SNIPPET), null, 2));
} finally {
  session.close();
}
