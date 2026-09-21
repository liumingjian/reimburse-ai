// Read-only: the geometry and structure of the recognised-invoice rows in the 发票无忧助手, so the row selection in
// `uploadInvoices` can be matched against reality. Clicks nothing and imports nothing.

import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const SNIPPET = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const box = (n) => { const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const d = (n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 70), box: box(n), visible: vis(n),
    op: getComputedStyle(n).opacity, pos: getComputedStyle(n).position, pe: getComputedStyle(n).pointerEvents });

  const inputs = [...document.querySelectorAll('input.ant-checkbox-input')];
  const out = {
    total: inputs.length,
    inThead: inputs.filter((n) => n.closest('thead')).length,
    whatStepsSees: inputs.filter((n) => vis(n) && !n.closest('thead')).length,
  };
  out.samples = inputs.slice(0, 3).map((n) => ({
    input: d(n),
    checked: n.checked,
    disabled: n.disabled,
    inThead: Boolean(n.closest('thead')),
    wrapper: n.parentElement ? d(n.parentElement) : null,
    label: n.closest('label') ? d(n.closest('label')) : null,
    cell: n.closest('td') ? d(n.closest('td')) : null,
    topAtCentre: (() => {
      const b = n.getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
      return el ? { tag: el.tagName, cls: String(el.className || '').slice(0, 70) } : null;
    })(),
  }));
  // Is there a select-all in the header, and what is it?
  out.headerCheckbox = inputs.filter((n) => n.closest('thead')).map(d);
  out.rowCount = document.querySelectorAll('tbody tr').length;
  return out;
})()`;

const target = (await targets(cdpPortOf())).find((t) => String(t.url).includes('piaozone'));
if (!target) { console.error('assistant not open'); process.exit(1); }
const session = await connect(target.webSocketDebuggerUrl!);
try { console.log(JSON.stringify(await evalIn(session, SNIPPET), null, 1)); } finally { session.close(); }
