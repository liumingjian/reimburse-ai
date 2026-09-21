// Read-only: dump what the 发票无忧助手 (piaozone invoice assistant) iframe actually shows, so the `steps.ts`
// selectors can be matched against reality. Evaluates one expression; clicks nothing, uploads nothing, imports
// nothing, so it consumes no invoice and creates no 收票占用.

import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';

const SNIPPET = `(() => {
  const vis = (n) => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const out = {};

  out.bodyHasUploadText = (document.body?.innerText || '').includes('上传发票影像');
  // What clickText would see: visible nodes whose own text is exactly 上传发票影像.
  out.exactUploadNodes = [...document.querySelectorAll('body *')]
    .filter((n) => vis(n) && own(n) === '上传发票影像')
    .map((n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 60) }));

  // Exactly what assistantEntryReady in steps.ts asks for, term by term, so a false verdict can be read
  // rather than guessed: readyState, the visible .accessItem entries, and whether each carries an a[href].
  out.entryReady = (() => {
    const items = [...document.querySelectorAll('.accessItem')];
    const visible = items.filter(vis);
    return {
      ready: document.readyState,
      accessItemTotal: items.length,
      accessItemVisible: visible.length,
      withAnchor: visible.filter((n) => n.querySelector('a[href]')).length,
      verdict: document.readyState === 'complete' && visible.length >= 4 && visible.every((n) => n.querySelector('a[href]')),
      entries: visible.slice(0, 6).map((n) => ({
        cls: String(n.className || '').slice(0, 50),
        text: String(n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
        anchors: n.querySelectorAll('a').length,
        anchorsWithHref: n.querySelectorAll('a[href]').length,
      })),
    };
  })();

  // Every visible node carrying short own-text: the menu of what can be clicked.
  const seen = new Map();
  for (const n of document.querySelectorAll('body *')) {
    const t = own(n);
    if (!t || t.length > 18 || !vis(n)) continue;
    if (!seen.has(t)) seen.set(t, { text: t, tag: n.tagName, cls: String(n.className || '').slice(0, 50), count: 0 });
    seen.get(t).count += 1;
  }
  out.clickable = [...seen.values()].slice(0, 80);

  out.fileInputs = [...document.querySelectorAll('input[type=file]')].map((n) => ({
    accept: n.getAttribute('accept'),
    multiple: n.hasAttribute('multiple'),
    visible: vis(n),
    parentText: (n.parentElement?.innerText || '').trim().slice(0, 40),
  }));

  out.url = location.href.split('?')[0];
  out.title = document.title;
  return out;
})()`;

const all = await targets(cdpPortOf());
const target = all.find((t) => String(t.url).includes('piaozone'));
if (!target) {
  console.error('assistant iframe not open');
  process.exit(1);
}
const session = await connect(target.webSocketDebuggerUrl!);
try {
  console.log(JSON.stringify(await evalIn(session, SNIPPET), null, 2));
} finally {
  session.close();
}
