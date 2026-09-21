// Page-side expressions. Every one is a MEASUREMENT: it reads the DOM and returns what it found. The single
// exception is `assignDataTransfer`, which is the thing #250 question (2) exists to test, and it touches nothing
// but the file input.
//
// The locators are ported from the server-side executor, where each was measured against the live ERP. The
// comments that explain WHY a locator has its shape live there (server/src/erp/executor/steps.ts and
// invoice-grid.ts); only the short version is repeated here.

const VIS = `(n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}`;

// Scroll into view, re-measure, and report what a real mouse event at the centre would reach. `onTarget` is the
// verdict; the caller refuses a point that does not have it.
const POINT_OF = `(n) => {
  const b0 = n.getBoundingClientRect();
  const inView = (b) => b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth;
  if (!inView(b0)) n.scrollIntoView({ block: 'center' });
  const b = n.getBoundingClientRect();
  const x = Math.round(b.left + b.width / 2);
  const y = Math.round(b.top + b.height / 2);
  const hit = document.elementFromPoint(x, y);
  return {
    ok: true, x, y, inView: inView(b),
    onTarget: Boolean(hit && (hit === n || n.contains(hit) || (hit.contains && hit.contains(n)))),
    hitTag: hit ? hit.tagName : null,
    hitText: hit ? String(hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
  };
}`;

/** The single visible leaf node whose text is exactly `text`, and where to click it. */
export const textPoint = (text) => `(() => {
  const vis = ${VIS};
  const at = ${POINT_OF};
  const wanted = ${JSON.stringify(String(text))};
  const nodes = [...document.querySelectorAll('body *')].filter((n) => {
    if (!vis(n) || n.children.length !== 0) return false;
    return String(n.textContent || '').replace(/\\s+/g, ' ').trim() === wanted;
  });
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  return at(nodes[0]);
})()`;

export const cssPoint = (selector) => `(() => {
  const vis = ${VIS};
  const at = ${POINT_OF};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  return at(nodes[0]);
})()`;

export const hasText = (text) => `(document.body ? String(document.body.innerText || '') : '').includes(${JSON.stringify(String(text))})`;

/** What the ERP page and its frames look like from the page target — the shape question (1) is asked about. */
export const FRAME_SNAPSHOT = `(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  iframes: [...document.querySelectorAll('iframe')].map((f) => {
    let sameOrigin = false;
    try { sameOrigin = Boolean(f.contentDocument); } catch { sameOrigin = false; }
    const b = f.getBoundingClientRect();
    return { src: f.src, id: f.id, name: f.name, sameOrigin, width: Math.round(b.width), height: Math.round(b.height) };
  }),
}))()`;

// 选择发票 is a Kendo split button; the wanted item is 不生成费用明细 (`tbNotFillEntry`), the only one of the three
// that leaves the 费用明细 grid alone. The item is identified by element id, never by caption proximity.
export const SPLIT_ARROW = 'div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow';
export const NOT_FILL_ENTRY = 'tbNotFillEntry';

export const importModePoint = (modeId = NOT_FILL_ENTRY) => `(() => {
  const vis = ${VIS};
  const at = ${POINT_OF};
  const ids = ['tbMergeFillEntry', 'tbMappingFillEntry', 'tbNotFillEntry'];
  const anchorsOf = (id) => [...document.querySelectorAll('a[id$="' + id + '"]')].filter(vis);
  const items = ids.flatMap((id) => anchorsOf(id).map((n) => n.id));
  const wanted = anchorsOf(${JSON.stringify(modeId)});
  if (wanted.length !== 1) return { ok: false, count: wanted.length, items };
  const point = at(wanted[0]);
  const hit = point.inView ? document.elementFromPoint(point.x, point.y) : null;
  const anchor = hit && hit.closest ? hit.closest('a[id]') : null;
  return { ...point, items, wantedId: wanted[0].id, hitId: anchor ? anchor.id : null };
})()`;

/** If the split button swallowed the arrow click, ask Kendo to open the menu itself. */
export const TOGGLE_SPLIT_MENU = `(() => {
  const wrapper = document.querySelector(${JSON.stringify(SPLIT_ARROW.replace(' > a.k-split-button-arrow', ''))});
  const split = wrapper && window.jQuery ? window.jQuery(wrapper).data() : null;
  if (!split || !split.splitButton || typeof split.splitButton.toggle !== 'function') return false;
  split.splitButton.toggle();
  return true;
})()`;

// ---- inside the assistant (piaozone) ----

// 电脑端选取's anchor reports a 76x0 rect: it is inline and its only child is a block <img>, so it contributes
// nothing to its own line box. Locate it structurally and measure whatever it actually paints.
export const COMPUTER_PICKER_POINT = `(() => {
  const vis = ${VIS};
  const at = ${POINT_OF};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const caption = [...document.querySelectorAll('body *')].find((n) => vis(n) && own(n) === '电脑端选取');
  if (!caption) return { ok: false, count: 0 };
  const item = caption.closest('.accessItem') || caption.parentElement;
  const anchors = item ? [...item.querySelectorAll('a[href]')] : [];
  if (anchors.length !== 1) return { ok: false, count: anchors.length };
  const painted = [anchors[0], ...anchors[0].querySelectorAll('*')]
    .find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!painted) return { ok: false, count: 0 };
  return at(painted);
})()`;

// Entry menu ready: document complete, all four entries painted, and 电脑端选取 — the only one this spike clicks —
// carrying a destination. Clicking before the assistant's own router takes over loads a route that never mounts.
export const ENTRY_READY = `(() => {
  if (document.readyState !== 'complete') return false;
  const vis = ${VIS};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const items = [...document.querySelectorAll('.accessItem')].filter(vis);
  if (items.length < 4) return false;
  const caption = [...document.querySelectorAll('body *')].find((n) => vis(n) && own(n) === '电脑端选取');
  const picker = caption ? caption.closest('.accessItem') : null;
  return Boolean(picker && picker.querySelector('a[href]'));
})()`;

/** Everything worth knowing about the file input BEFORE anything is assigned to it. */
export const FILE_INPUT_REPORT = `(() => {
  const inputs = [...document.querySelectorAll('input[type=file]')];
  return {
    count: inputs.length,
    inputs: inputs.map((input) => {
      const style = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      const ancestors = [];
      for (let n = input.parentElement, i = 0; n && i < 5; n = n.parentElement, i += 1) {
        ancestors.push(n.tagName + (n.className ? '.' + String(n.className).split(/\\s+/).slice(0, 3).join('.') : ''));
      }
      return {
        multiple: input.multiple,
        accept: input.accept,
        disabled: input.disabled,
        filesNow: input.files ? input.files.length : null,
        hidden: style.display === 'none' || style.visibility === 'hidden' || (box.width === 0 && box.height === 0),
        display: style.display,
        rect: { width: Math.round(box.width), height: Math.round(box.height) },
        ancestors,
        frameworkKeys: Object.keys(input).filter((k) => /^__react|^__vue|^_v/.test(k)),
      };
    }),
  };
})()`;

/** Stage one file's bytes in the page. Bytes come from the panel, exactly as production bytes come from a server. */
export const stageFile = (name, type, base64) => `(() => {
  const bin = atob(${JSON.stringify(base64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  window.__baoxSpikeStaged = window.__baoxSpikeStaged || [];
  window.__baoxSpikeStaged.push(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  return { staged: window.__baoxSpikeStaged.length, bytes: bytes.length };
})()`;

/**
 * Question (2), in fifteen lines: build a `DataTransfer` inside `Runtime.evaluate`, assign it to the hidden
 * `multiple` file input, fire `input` and `change`, and report what the input holds afterwards. Whether the
 * assistant then RECOGNISES the invoices is not decided here — it is read back from the grid a minute later.
 */
export const ASSIGN_DATATRANSFER = `(() => {
  const staged = window.__baoxSpikeStaged || [];
  if (!staged.length) return { ok: false, reason: '页面里没有暂存的文件' };
  const inputs = [...document.querySelectorAll('input[type=file]')];
  if (inputs.length !== 1) return { ok: false, reason: '文件控件不唯一', count: inputs.length };
  const input = inputs[0];
  const transfer = new DataTransfer();
  for (const file of staged) transfer.items.add(file);
  const built = { items: transfer.items.length, files: transfer.files.length };
  let assignError = null;
  try { input.files = transfer.files; } catch (error) { assignError = String(error && error.message || error); }
  const assigned = input.files ? [...input.files].map((f) => ({ name: f.name, size: f.size, type: f.type })) : null;
  const fired = [];
  for (const type of ['input', 'change']) {
    try { input.dispatchEvent(new Event(type, { bubbles: true })); fired.push(type); }
    catch (error) { fired.push(type + ':' + String(error && error.message || error)); }
  }
  return { ok: !assignError, built, assignError, assigned, fired };
})()`;

// ---- reading the recognised rows back ----

const GRID = `
  const vis = ${VIS};
  const text = (n) => String((n && n.innerText) || '').replace(/\\s+/g, ' ').trim();
  const tabs = () => [...document.querySelectorAll('.ant-tabs-tab')].filter(vis);
  const headers = () => [...document.querySelectorAll('thead th')].map(text);
  const numberCol = () => headers().findIndex((h) => h.includes('发票号码'));
  const rows = () => [...document.querySelectorAll('tbody tr')].filter((tr) => vis(tr) && !/measure-row/.test(String(tr.className)));
  const paneOf = (n, i) => {
    const caption = text(n);
    const m = /(\\d+)\\s*$/.exec(caption);
    return { index: i, caption, label: caption.replace(/\\s*\\d+\\s*$/, '').trim() || caption,
      count: m ? Number(m[1]) : null, active: /ant-tabs-tab-active/.test(String(n.className)) };
  };
`;

/**
 * The recognised rows of the pane on screen, plus every pane's caption count. The 票种 tab strip means the visible
 * rows are never all of them, so the total is summed across panes, exactly as the executor does it.
 */
export const RECOGNISED = `(() => { ${GRID}
  const panes = tabs().map(paneOf);
  const visibleRows = rows();
  const col = numberCol();
  return {
    processing: (document.body ? String(document.body.innerText || '') : '').includes('上传处理中'),
    panes,
    total: panes.length === 0 ? visibleRows.length
      : panes.reduce((sum, p) => sum + (p.count === null ? (p.active ? visibleRows.length : 0) : p.count), 0),
    headers: headers(),
    activePane: (panes.find((p) => p.active) || {}).label || null,
    rows: visibleRows.map((tr) => {
      const cells = [...tr.querySelectorAll('td')].map(text);
      const box = tr.querySelector('input.ant-checkbox-input');
      return { number: col < 0 ? null : (cells[col] || null), checked: Boolean(box && box.checked), cells };
    }),
  };
})()`;

/** Anything the assistant put on screen that is not a row — a 温馨提示 modal, an error toast, a rejection. */
export const ASSISTANT_NOTICES = `(() => {
  const vis = ${VIS};
  const text = (n) => String((n && n.innerText) || '').replace(/\\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('.ant-modal, .ant-message, .ant-notification, .ant-alert')].filter(vis);
  return nodes.map((n) => text(n).slice(0, 300));
})()`;

/**
 * The 温馨提示 announcement, which is an Ant Design modal at z-index 9999 covering the assistant's whole viewport
 * and is dismissed only by its 知道了 button. It is answered at the moment it blocks, never at a fixed step: it
 * has been measured up both on a first visit and in the middle of a run.
 */
export const NOTICE_POINT = `(() => {
  const vis = ${VIS};
  const at = ${POINT_OF};
  const buttons = [...document.querySelectorAll('button')].filter((n) => vis(n)
    && String(n.textContent || '').replace(/\\s+/g, ' ').trim() === '知道了');
  if (buttons.length !== 1) return { ok: false, count: buttons.length };
  return at(buttons[0]);
})()`;
