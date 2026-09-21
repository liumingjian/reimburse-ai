// The one question `probe-grid.ts` cannot answer by reading: does a tick SURVIVE a pane switch?
//
// That fork decides the whole design of row selection. If a tick survives, the executor can walk the panes and
// tick every row before the single 发票导入单据 click. If it does not, group-by-group selection is impossible and
// the honest move is to refuse a task whose invoices span more than one pane — because one import click per pane
// would mean several irreversible acts, which is an ADR-0025 decision, not a code change.
//
// Ticking is free and reversible: ADR-0025 puts consumption at the 发票导入单据 click, which this never reaches.
// This script ticks ONE row, reports what moved, switches pane, reports whether the tick held, switches back and
// unticks. It never touches 发票导入单据, 继续采集, 保存, 提交, 审核, 下推, 付款, 删除发票, 申请解绑 or 清空列表.
//
// Pass `--dry` to print the plan — which row, which switcher — and exit without clicking anything.
import { clickAt, connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf } from '@baox/erp-executor/chromium';

const dry = process.argv.includes('--dry');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const text = (n) => String(n && n.innerText || '').replace(/\\s+/g, ' ').trim();
  const mask = (s) => { s = String(s || '').trim(); if (!s) return null;
    return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2); };
  const headers = [...document.querySelectorAll('thead th')].map(text);
  const numberCol = headers.findIndex((h) => h.includes('发票号码'));
  const bodyRows = () => [...document.querySelectorAll('tbody tr')].filter((r) => !r.className.includes('measure-row'));
  const keyOf = (tr) => { const c = [...tr.querySelectorAll('td')][numberCol]; return c ? mask(text(c)) : null; };
  const footer = () => { const n = [...document.querySelectorAll('body *')].filter(vis)
    .filter((x) => /已选取/.test(text(x))).sort((a, b) => text(a).length - text(b).length)[0];
    return n ? text(n).slice(0, 120) : null; };
  const state = () => ({ footer: footer(), rows: bodyRows().map((tr) => {
    const i = tr.querySelector('input.ant-checkbox-input');
    return { key: keyOf(tr), checked: i ? i.checked : null }; }) });
`;

// The state read back after every step: which row is ticked, by identity, plus the assistant's own counter.
const STATE = `(() => { ${HELPERS} return state(); })()`;

// The first row's checkbox, measured at the moment of use — never from a stale snapshot.
const TARGET = `(() => { ${HELPERS}
  const tr = bodyRows()[0];
  if (!tr) return { ok: false, why: 'no rows' };
  const input = tr.querySelector('input.ant-checkbox-input');
  if (!input) return { ok: false, why: 'row has no checkbox' };
  input.scrollIntoView({ block: 'center' });
  const b = input.getBoundingClientRect();
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  const top = document.elementFromPoint(x, y);
  return { ok: true, key: keyOf(tr), x, y, checked: input.checked,
    inView: b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth,
    topIsCheckbox: top === input || (top ? top.contains(input) : false),
    topAtCentre: top ? { tag: top.tagName, cls: String(top.className || '').slice(0, 70) } : null };
})()`;

// A pane switcher that is NOT the current one. Tabs and pagination only; never a business control.
const SWITCHER = `(() => { ${HELPERS}
  const cand = [
    ...[...document.querySelectorAll('.ant-tabs-tab')].map((n) => ({ kind: 'tab', n,
      active: n.className.includes('active') })),
    ...[...document.querySelectorAll('.ant-pagination-item')].map((n) => ({ kind: 'page', n,
      active: n.className.includes('active') })),
  ].filter((c) => vis(c.n));
  const other = cand.find((c) => !c.active);
  if (!other) return { ok: false, why: 'no inactive tab or page control is visible', count: cand.length };
  const b = other.n.getBoundingClientRect();
  return { ok: true, kind: other.kind, text: text(other.n).slice(0, 40),
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`;

const target = (await targets(cdpPortOf())).find((t) => String(t.url).includes('piaozone'));
if (!target) { console.error('assistant not open: run this while the 发票助手 grid is showing recognised rows'); process.exit(1); }
const session = await connect(target.webSocketDebuggerUrl!);
const show = (label: string, value: unknown) => console.log(label, JSON.stringify(value));

try {
  const row = await evalIn<any>(session, TARGET);
  const switcher = await evalIn<any>(session, SWITCHER);
  show('target: ', row);
  show('switcher:', switcher);
  show('before:  ', await evalIn(session, STATE));
  if (dry || !row?.ok) { console.log(dry ? '--dry: clicked nothing' : 'no usable row: clicked nothing'); process.exit(0); }
  if (!row.inView) { console.log('row is out of the viewport even after scrollIntoView: refusing to click blind'); process.exit(0); }

  await clickAt(session, row.x, row.y);
  await sleep(1500);
  show('after tick:', await evalIn(session, STATE));

  if (switcher?.ok) {
    await clickAt(session, switcher.x, switcher.y);
    await sleep(2000);
    show('after switch away:', await evalIn(session, STATE));
    const back = await evalIn<any>(session, SWITCHER);
    if (back?.ok) {
      await clickAt(session, back.x, back.y);
      await sleep(2000);
      show('after switch back:', await evalIn(session, STATE));
    }
  }

  // Leave the grid exactly as it was found.
  const again = await evalIn<any>(session, TARGET);
  if (again?.ok && again.checked) {
    await clickAt(session, again.x, again.y);
    await sleep(1000);
  }
  show('restored:', await evalIn(session, STATE));
} finally { session.close(); }
