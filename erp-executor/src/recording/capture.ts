// What the recorder reads off a live ERP page: the DOM as a tree of elements with their relevant attributes, each
// element's box, the frame structure, and the few page globals the executor reads (`window.KDResVer`, the
// `k3cloudloginInfo` localStorage entry). Read-only: the snippets here navigate nowhere and click nothing.
//
// Two decisions shape the tree, both so that a recording replays faithfully in jsdom, which has no CSS:
//   - an element whose computed `display` is `none` keeps its own tag and attributes and loses its subtree
//     (`pruned` counts what was dropped). Nothing in a hidden subtree is visible, clickable or in `innerText`, and a
//     replay never reveals it — the next page of a recording is a new recording — so dropping it changes no
//     executor read, while it keeps the fixtures small and shrinks what redaction has to get right;
//   - computed visibility is carried as the element's only style (`display:none` or `visibility:hidden`), because
//     live style comes from stylesheets the recording does not keep.

export type CapturedNode = {
  /** Lower-case tag name. */
  t: string;
  /** Kept attributes, after the page's own values (an input's `value` is its live value, not its attribute). */
  a: Record<string, string>;
  /** `getBoundingClientRect()` rounded: x, y, width, height in viewport pixels. */
  b: [number, number, number, number];
  /** Computed visibility, when it hides the element. */
  s?: 'display:none' | 'visibility:hidden';
  /** Children in document order; text nodes are strings, whitespace-only text collapsed to one space. */
  c: Array<CapturedNode | string>;
};

export type CapturedFrame = { path: string; src: string; box: [number, number, number, number] };

export type CapturedPage = {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  /** `window.KDResVer`, where K3Cloud publishes its front-end build (probe.ts COMPATIBILITY_SNIPPET). */
  resVer: string | null;
  /** `localStorage.k3cloudloginInfo`, parsed; it survives logout (probe.ts fact 3). */
  loginInfo: Record<string, unknown> | null;
  body: CapturedNode;
  frames: CapturedFrame[];
  /** Elements kept and elements dropped under `display:none`. */
  count: number;
  pruned: number;
};

/**
 * Attributes a recording keeps. Everything else (inline style, src, event handlers) is dropped. `href` is kept as its
 * path alone (or its scheme, for `javascript:` and the like): the executor finds the assistant's pick-from-computer (电脑端选取) entry as
 * the one `a[href]` in its item, and a query string may carry a session token.
 */
export const KEPT_ATTRIBUTE = /^(id|class|type|name|role|readonly|disabled|checked|placeholder|title|for|href|colspan|rowspan|tabindex|contenteditable|aria-[a-z]+|data-[a-z0-9-]+)$/;

/** The mark `markClickTarget` puts on the element a click is about to land on, for the replay to find. */
export const CLICK_MARK = 'data-rec-click';

/**
 * Reads the whole page. Returns a JSON string: a large object crosses CDP faster as one string, and `evalIn`
 * returns strings unchanged.
 */
export const CAPTURE_SNIPPET = `(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
  const KEEP = ${KEPT_ATTRIBUTE.toString()};
  const safe = (value) => { try { const u = new URL(String(value), location.href); return u.origin + u.pathname; } catch { return ''; } };
  const pathOnly = (value) => { try { const u = new URL(String(value), location.href); return /^https?:$/.test(u.protocol) ? u.pathname : u.protocol; } catch { return ''; } };
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const index = n.parentElement ? [...n.parentElement.children].indexOf(n) + 1 : 1;
      parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : ':nth-child(' + index + ')'));
      if (n.id) break;
    }
    return parts.join(' > ');
  };
  let count = 0;
  let pruned = 0;
  const frames = [];
  const walk = (node) => {
    if (node.nodeType === 3) { const text = node.nodeValue || ''; return text.trim() ? text : (text ? ' ' : null); }
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return null;
    count += 1;
    const tag = node.tagName.toLowerCase();
    const a = {};
    for (const attr of node.attributes) if (KEEP.test(attr.name) && attr.value.length <= 200) a[attr.name] = attr.name === 'href' ? pathOnly(attr.value) : attr.value;
    if (tag === 'input' || tag === 'textarea') {
      a.value = String(node.value ?? '');
      if (node.type === 'checkbox' || node.type === 'radio') { if (node.checked) a.checked = ''; else delete a.checked; }
    }
    const style = getComputedStyle(node);
    const s = style.display === 'none' ? 'display:none' : style.visibility === 'hidden' ? 'visibility:hidden' : undefined;
    const out = { t: tag, a, b: box(node), c: [] };
    if (s) out.s = s;
    if (tag === 'iframe' || tag === 'frame') { frames.push({ path: pathOf(node), src: safe(node.src), box: out.b }); return out; }
    if (tag === 'svg' || s === 'display:none') { pruned += node.querySelectorAll('*').length; return out; }
    for (const child of node.childNodes) { const kept = walk(child); if (kept !== null) out.c.push(kept); }
    return out;
  };
  let loginInfo = null;
  try { loginInfo = JSON.parse(localStorage.getItem('k3cloudloginInfo') || 'null'); } catch {}
  const body = walk(document.body);
  return JSON.stringify({
    url: safe(location.href), title: document.title, readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    resVer: window.KDResVer === undefined ? null : String(window.KDResVer),
    loginInfo: loginInfo && typeof loginInfo === 'object' ? loginInfo : null,
    body, frames, count, pruned,
  });
})()`;

/**
 * Marks the element a mouse press at (x, y) will land on and describes it, so the recorder can refuse a click that
 * crosses a consumption boundary before it is sent, and the replay can advance on the same element.
 */
export const markClickTarget = (x: number, y: number) => `(() => {
  const hit = document.elementFromPoint(${Number(x)}, ${Number(y)});
  if (!hit) return JSON.stringify(null);
  hit.setAttribute(${JSON.stringify(CLICK_MARK)}, '');
  const control = hit.closest('a, button, [role=button], li, [id]') || hit;
  return JSON.stringify({
    tag: hit.tagName.toLowerCase(), id: hit.id || '', controlId: control.id || '',
    text: String(hit.innerText || hit.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    controlText: String(control.innerText || control.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
  });
})()`;

export const UNMARK_SNIPPET = `(() => { for (const n of document.querySelectorAll('[${CLICK_MARK}]')) n.removeAttribute('${CLICK_MARK}'); return true; })()`;

export type ClickTarget = { tag: string; id: string; controlId: string; text: string; controlText: string };
