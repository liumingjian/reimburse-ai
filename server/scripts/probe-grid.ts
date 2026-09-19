// Read-only: what the recognised-invoice grid in the 发票无忧助手 (invoice assistant, 原文 发票无忧助手) actually is.
// It clicks nothing, ticks nothing and imports nothing — it only reads what is already painted.
//
// It exists because the row selection in `uploadInvoices` aborts with `INVOICE_SELECTION_UNCONFIRMED`, and every
// explanation on offer is still a guess: the claim that the grid "groups by 票种 and shows one group at a time"
// comes from the assistant's own summary text (数电票 10, 数电票（铁路电子客票）2), never from counting rendered
// rows. Pagination, a virtualised body, a 票种 filter, or two rows below the fold all fit that same evidence.
//
// One pass answers all of it, because a live iteration is expensive: a spent page instance cannot take a second
// upload, so each run costs a fresh 费用报销单-新增 tab plus `reset-erp-tabs.ts`.
//
// Invoice numbers (发票号码) are masked: the probe reports structure, not the documents.
import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';

const SNIPPET = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const box = (n) => { const b = n.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const d = (n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 70), box: box(n), visible: vis(n),
    op: getComputedStyle(n).opacity, pos: getComputedStyle(n).position, pe: getComputedStyle(n).pointerEvents });
  const mask = (s) => { s = String(s || '').trim(); if (!s) return null;
    return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2); };
  const text = (n) => String(n && n.innerText || '').replace(/\\s+/g, ' ').trim();

  // Q1: is input.ant-checkbox-input duplicated? antd renders a fixed-left selection column twice.
  const inputs = [...document.querySelectorAll('input.ant-checkbox-input')];
  const bodyRows = [...document.querySelectorAll('tbody tr')].filter((r) => !r.className.includes('measure-row'));
  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    url: location.origin + location.pathname,
    counts: {
      total: inputs.length,
      inThead: inputs.filter((n) => n.closest('thead')).length,
      whatStepsSees: inputs.filter((n) => vis(n) && !n.closest('thead')).length,
      tbodyRows: bodyRows.length,
    },
  };

  // 发票号码 lives in some cell; find the column by its header caption so rows can be keyed by identity.
  const headers = [...document.querySelectorAll('thead th')].map((th) => text(th));
  out.headers = headers;
  const numberCol = headers.findIndex((h) => h.includes('发票号码'));
  out.numberColumn = numberCol;

  // Q2/Q3/Q4: per row — where it is, whether it is reachable, and what is on top of it.
  out.rows = bodyRows.slice(0, 20).map((tr, i) => {
    const input = tr.querySelector('input.ant-checkbox-input');
    const cells = [...tr.querySelectorAll('td')];
    const key = numberCol >= 0 && cells[numberCol] ? mask(text(cells[numberCol])) : null;
    if (!input) return { i, key, noInput: true };
    const b = input.getBoundingClientRect();
    const cx = Math.round(b.x + b.width / 2), cy = Math.round(b.y + b.height / 2);
    const top = document.elementFromPoint(cx, cy);
    return {
      i, key, checked: input.checked, disabled: input.disabled,
      point: { x: cx, y: cy },
      // The guard erpform.ts already applies and this grid never did.
      inView: b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth,
      input: d(input),
      wrapper: input.parentElement ? d(input.parentElement) : null,
      topAtCentre: top ? { tag: top.tagName, cls: String(top.className || '').slice(0, 70),
        isTheInput: top === input, isOwnWrapper: top === input.parentElement || top.contains(input) } : null,
    };
  });

  // Q5: what could switch panes — tabs, pagination, radios, a 票种 select, or nothing at all.
  const switchers = (sel, kind) => [...document.querySelectorAll(sel)].filter(vis)
    .slice(0, 12).map((n) => ({ kind, text: text(n).slice(0, 40), cls: String(n.className || '').slice(0, 70), box: box(n) }));
  out.switchers = [
    ...switchers('.ant-tabs-tab', 'tab'),
    ...switchers('.ant-pagination-item, .ant-pagination-next, .ant-pagination-prev', 'pagination'),
    ...switchers('input[type=radio]', 'radio'),
    ...switchers('.ant-select-selector', 'select'),
  ];

  // Q7: the footer that carries 已选取N张发票 — the second witness a tick is supposed to move.
  const footer = [...document.querySelectorAll('body *')].filter(vis)
    .filter((n) => /已选取|已选\\d+份附件|价税合计/.test(text(n)))
    .sort((a, b) => text(a).length - text(b).length)[0];
  out.footer = footer ? text(footer).slice(0, 200) : null;

  // Is the body inside an inner scroller, i.e. are rows hiding below the fold rather than in another group?
  const scroller = document.querySelector('.ant-table-body, .ant-table-content');
  out.scroller = scroller
    ? { clientH: scroller.clientHeight, scrollH: scroller.scrollHeight, scrollTop: scroller.scrollTop,
        hidesRows: scroller.scrollHeight > scroller.clientHeight + 4 }
    : null;

  // Anything masking the grid — the 温馨提示 dialog swallows clicks on the rows behind it.
  out.overlays = [...document.querySelectorAll('.ant-modal-mask, .ant-modal-wrap, .ant-modal, [class*=mask]')]
    .filter(vis).slice(0, 6).map((n) => ({ cls: String(n.className || '').slice(0, 70), box: box(n), text: text(n).slice(0, 60) }));

  return out;
})()`;

const target = (await targets(cdpPortOf())).find((t) => String(t.url).includes('piaozone'));
if (!target) { console.error('assistant not open: run this while the 发票助手 grid is showing recognised rows'); process.exit(1); }
const session = await connect(target.webSocketDebuggerUrl!);
try { console.log(JSON.stringify(await evalIn(session, SNIPPET), null, 1)); } finally { session.close(); }
