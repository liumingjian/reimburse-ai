// Read-only: what a saved 费用报销单 actually is, read off the live ERP.
//
// It exists for the question V-51 left open — 26327000001570964156 (曹操出行) and 26427000000640558021 (风韵出行)
// are refused by every import because they are bound to 费用报销单-FYBX20260911000011, and before anyone can decide
// what to do about that bill someone has to read it: its 单据状态, who made it, what 项目 its 明细 rows carry, its
// 事由, its 收票信息 rows, and whether the ERP even offers a 删除 on it.
//
// It never mutates. The only clicks it makes are navigation — opening the 我的费用报销 list and opening a bill for
// reading. It clicks nothing on the never-click list (保存 / 提交 / 删除 / 下推 / 审核 / 付款 / 申请解绑 /
// 发票导入单据 / 清空列表), and the 删除 toolbar item is measured and reported, never pressed.
//
// Usage (each stage reads and prints; pick the next one from what came back):
//   tsx scripts/probe-bill.ts survey                 tabs, dialogs, where the ERP currently is
//   tsx scripts/probe-bill.ts list                   open 我的费用报销 and dump its grid
//   tsx scripts/probe-bill.ts open FYBX...           open one bill from the list by its 单据编号
//   tsx scripts/probe-bill.ts form                   dump the open form: header, 明细, 收票信息, toolbar
//   tsx scripts/probe-bill.ts ids <id-regex>          the form's own controls by id (制单人, 单据状态, …)
//   tsx scripts/probe-bill.ts query <fields> <filter> [formId]   ExecuteBillQuery, read-only (ADR-0008)
//   tsx scripts/probe-bill.ts list-toolbar FYBX...    what the list toolbar offers with that row selected
import { clickAt, connect, evalIn, targets, type CdpSession } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { sleep, waitFor } from '../src/erp/executor/pace';
import { queryRows } from '../src/erp/executor/catalog';

const VIS = `(n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }`;
const TXT = `(n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim()`;

// Where to click `n` so the click reaches IT. Same discipline as `steps.ts`: `Input.dispatchMouseEvent` hits
// viewport coordinates, so a point outside the viewport or under another element is a click that silently does
// nothing — and here a click that lands somewhere unintended is the thing we must not do.
const HIT = `(n) => {
  const inView = (b) => b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth;
  let b = n.getBoundingClientRect();
  if (!(b.width > 0 && b.height > 0)) return null;
  if (!inView(b)) { n.scrollIntoView({ block: 'center' }); b = n.getBoundingClientRect(); }
  if (!inView(b)) return null;
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === n || n.contains(hit) || hit.contains(n))) return null;
  return { x, y };
}`;

type Point = { x: number; y: number } | null;

const surveySnippet = `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  return {
    url: location.href.split('?')[0],
    dialogs: [...document.querySelectorAll('.k-window')].filter(vis).map((n) => txt(n).slice(0, 120)),
    tabs: [...document.querySelectorAll('li.k-item')].filter(vis)
      .filter((n) => n.querySelector('span.mainTabCloseButton'))
      .map((n) => ({ text: txt(n).slice(0, 40), active: n.className.includes('k-state-active') })),
    menuBarVisible: [...document.querySelectorAll('.kd_SystemMenu')].filter(vis).length,
    bodyHead: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
  };
})()`;

/** A visible leaf node whose whole text equals `text`, as a click point. */
const textPoint = (text: string) => `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const at = ${HIT};
  const nodes = [...document.querySelectorAll('body *')].filter((n) => vis(n) && n.children.length === 0 && txt(n) === ${JSON.stringify(text)});
  if (nodes.length !== 1) return null;
  return at(nodes[0]);
})()`;

const cssPoint = (selector: string) => `(() => {
  const vis = ${VIS};
  const at = ${HIT};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (nodes.length !== 1) return null;
  return at(nodes[0]);
})()`;

/**
 * Every visible grid on the page, as header row + data rows of cell text. K3Cloud draws a list as a kdgrid whose
 * frozen ("fixed") columns are a SECOND table over the same rows, so a naive row dump double-counts; each table is
 * reported separately with its own id so the caller can tell which is which rather than being handed a merged lie.
 */
const gridsSnippet = (limit: number) => `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const cells = (tr) => [...tr.children].map((td) => txt(td));
  return [...document.querySelectorAll('table')].filter(vis).map((t) => {
    const head = [...t.querySelectorAll('thead tr')].map(cells);
    const body = [...t.querySelectorAll('tbody tr')].map(cells);
    return { id: t.id || null, cls: String(t.className || '').slice(0, 60), head, rows: body.length, body: body.slice(0, ${limit}) };
  }).filter((g) => g.rows > 0 || g.head.length > 0);
})()`;

/** The bill number cell of `billNo` in the list, as a click point (opening a bill is a read). */
const billPoint = (billNo: string) => `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const at = ${HIT};
  const cells = [...document.querySelectorAll('td, a, span')].filter((n) => vis(n) && n.children.length === 0 && txt(n) === ${JSON.stringify(billNo)});
  if (!cells.length) return null;
  return at(cells[0]);
})()`;

/**
 * The open form, read whole: every labelled header field, every visible grid, and the state of every toolbar item.
 *
 * Toolbar items are reported with `disabled` from both the DOM (`k-state-disabled`, `disabled`, `aria-disabled`)
 * and `pointerEvents`, because K3Cloud greys a forbidden action without removing it. NOTHING here is clicked:
 * the 删除 entry exists in this output only as a measurement.
 */
const formSnippet = `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const value = (n) => (n.value !== undefined && n.value !== null && String(n.value) !== '' ? String(n.value) : txt(n));

  // Header fields: K3Cloud labels a field with a .kd_label-ish node next to its input wrapper. Rather than guess
  // the class, pair each visible input/textarea with the nearest preceding visible text that looks like a label.
  const fields = [];
  for (const el of [...document.querySelectorAll('input, textarea')].filter(vis)) {
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file' || el.closest('tbody')) continue;
    let label = null;
    let node = el.closest('div[id]');
    for (let i = 0; i < 6 && node && !label; i += 1) {
      const found = [...node.querySelectorAll('label, span, div')].filter((n) => vis(n) && n.children.length === 0 && /^[\\u4e00-\\u9fa5A-Za-z（）()\\/]{2,12}$/.test(txt(n)));
      if (found.length) label = txt(found[0]);
      node = node.parentElement?.closest('div[id]') || null;
    }
    const v = value(el);
    if (v) fields.push({ id: el.id || null, label, value: v.slice(0, 200) });
  }

  const cells = (tr) => [...tr.children].map((td) => txt(td));
  const grids = [...document.querySelectorAll('table')].filter(vis).map((t) => {
    const head = [...t.querySelectorAll('thead tr')].map(cells);
    const body = [...t.querySelectorAll('tbody tr')].map(cells);
    return { id: t.id || null, head, rows: body.length, body: body.slice(0, 40) };
  }).filter((g) => g.rows > 0 || g.head.length > 0);

  const toolbar = [...document.querySelectorAll('a, div[id*="-tb"], span.k-button')].filter(vis)
    .map((n) => {
      const t = txt(n);
      if (!t || t.length > 8) return null;
      const s = getComputedStyle(n);
      return {
        text: t, id: n.id || null,
        disabled: n.className.includes('k-state-disabled') || n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true' || Boolean(n.closest('.k-state-disabled')),
        pointerEvents: s.pointerEvents, opacity: s.opacity,
      };
    }).filter(Boolean);

  return {
    url: location.href.split('?')[0],
    tabs: [...document.querySelectorAll('li.k-item')].filter(vis).filter((n) => n.querySelector('span.mainTabCloseButton')).map((n) => ({ text: txt(n).slice(0, 40), active: n.className.includes('k-state-active') })),
    text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    fields, grids, toolbar,
    dialogs: [...document.querySelectorAll('.k-window')].filter(vis).map((n) => txt(n).slice(0, 120)),
  };
})()`;

/**
 * Every node whose id matches `pattern`, with its value and text. 制单人 / 制单日期 / 单据状态 are K3Cloud system
 * fields (FCREATORID / FCREATEDATE / FDOCUMENTSTATUS) that the 费用报销单 layout does not put on any visible tab, so
 * the only way to read them without opening menus is to go at the form's own controls by id.
 */
const idsSnippet = (pattern: string) => `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const re = new RegExp(${JSON.stringify(pattern)}, 'i');
  return [...document.querySelectorAll('[id]')].filter((n) => re.test(n.id)).map((n) => ({
    id: n.id, tag: n.tagName, visible: vis(n),
    value: n.value !== undefined && n.value !== null ? String(n.value).slice(0, 120) : null,
    text: txt(n).slice(0, 120),
  })).filter((n) => n.value || n.text);
})()`;

/** The list row of `billNo`: its selection checkbox as a click point. Selecting a row reads nothing and writes nothing. */
const rowCheckPoint = (billNo: string) => `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const at = ${HIT};
  const cell = [...document.querySelectorAll('td')].filter((n) => vis(n) && txt(n) === ${JSON.stringify(billNo)})[0];
  const tr = cell && cell.closest('tr');
  if (!tr) return null;
  const box = [...tr.querySelectorAll('input[type=checkbox], span.k-checkbox, div.k-checkbox')].filter(vis)[0];
  return box ? at(box) : at(tr.children[0] || tr);
})()`;

/** Every visible toolbar item of the page, with how disabled it is. Measured, never clicked. */
const toolbarSnippet = `(() => {
  const vis = ${VIS};
  const txt = ${TXT};
  const seen = new Set();
  const out = [];
  for (const n of [...document.querySelectorAll('a, div[id*="-tb"], span.k-button, li')].filter(vis)) {
    const t = txt(n);
    if (!t || t.length > 6) continue;
    const s = getComputedStyle(n);
    const disabled = n.className.includes('k-state-disabled') || n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true' || Boolean(n.closest('.k-state-disabled'));
    const key = t + '|' + (n.id || '') + '|' + disabled;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: t, id: n.id || null, cls: String(n.className || '').slice(0, 60), disabled, pointerEvents: s.pointerEvents, opacity: s.opacity });
  }
  return out;
})()`;

const out = (label: string, value: unknown) => console.log(`\n### ${label}\n${JSON.stringify(value, null, 1)}`);

async function click(session: CdpSession, snippet: string, label: string): Promise<boolean> {
  const point = await waitFor(() => evalIn<Point>(session, snippet), Boolean, 15_000, 500);
  if (!point) { console.error(`not clickable: ${label}`); return false; }
  await clickAt(session, point.x, point.y);
  await sleep(2000);
  return true;
}

const [stage = 'survey', arg] = process.argv.slice(2);
const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  if (stage === 'survey') {
    out('survey', await evalIn(session, surveySnippet));
  } else if (stage === 'list') {
    const survey = await evalIn<{ tabs: Array<{ text: string; active: boolean }> }>(session, surveySnippet);
    const open = survey.tabs.find((t) => t.text.includes('我的费用报销'));
    if (open && !open.active) await click(session, textPoint('我的费用报销'), '我的费用报销 tab');
    if (!open) {
      await click(session, cssPoint('.kd_SystemMenu'), 'ERP 主菜单');
      await click(session, textPoint('员工服务'), '员工服务');
      await click(session, textPoint('我的费用报销'), '我的费用报销');
    }
    await sleep(3000);
    out('after-navigation', await evalIn(session, surveySnippet));
    out('grids', await evalIn(session, gridsSnippet(Number(arg ?? 40))));
  } else if (stage === 'open') {
    if (!arg) { console.error('open needs a 单据编号'); process.exit(1); }
    const point = await waitFor(() => evalIn<Point>(session, billPoint(arg)), Boolean, 15_000, 500);
    if (!point) { console.error(`bill ${arg} not found in the visible list`); process.exit(1); }
    // A K3Cloud list row opens on double-click; the number cell is also a link in some layouts.
    await clickAt(session, point.x, point.y);
    await sleep(600);
    await clickAt(session, point.x, point.y, { clickCount: 2 });
    await sleep(5000);
    out('after-open', await evalIn(session, surveySnippet));
  } else if (stage === 'form') {
    out('form', await evalIn(session, formSnippet));
  } else if (stage === 'detail') {
    // A form read too soon undercounts its rows, silently. Measured live on 2026-09-19: the first dump of
    // FYBX20260911000011 gave THREE 明细 rows with a footer of 3,710.43; the same form re-read later gave FOUR and
    // 4,413.43, the footer having summed only what was painted. The row count is not settled until two reads of a
    // settled form agree — so this stage exists to take the second read, and reports before/after rather than one
    // number. The scroll is a scroll: it reads, and changes nothing.
    const scrollSnippet = `(() => {
      const panel = document.querySelector('[id$="FENTITY-gridPanel"]') || document.querySelector('[id$="FENTITY-c"]');
      if (!panel) return { found: false };
      const boxes = [panel, ...panel.querySelectorAll('div')].filter((n) => n.scrollHeight > n.clientHeight + 2);
      for (const n of boxes) n.scrollTop = n.scrollHeight;
      return { found: true, scrollers: boxes.map((n) => ({ id: n.id || null, scrollH: n.scrollHeight, clientH: n.clientHeight })) };
    })()`;
    const rowsSnippet = `(() => {
      const vis = ${VIS};
      const txt = ${TXT};
      const panel = document.querySelector('[id$="FENTITY-gridPanel"]') || document.querySelector('[id$="FENTITY-c"]');
      if (!panel) return null;
      return [...panel.querySelectorAll('table')].filter(vis).map((t) => ({
        rows: [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => txt(td))),
      }));
    })()`;
    out('before-scroll', await evalIn(session, rowsSnippet));
    out('scroll', await evalIn(session, scrollSnippet));
    await sleep(2000);
    out('after-scroll', await evalIn(session, rowsSnippet));
  } else if (stage === 'query') {
    // 制单人 / 制单日期 / 审核人 are K3Cloud system fields that the 费用报销单 layout puts on no visible tab, so they
    // are read the way ADR-0008 reads master data: Kingdee's own read-only `ExecuteBillQuery`, same logged-in
    // session, nothing written. `fields` first, `filter` second.
    const [fields, filter, formId = 'ER_ExpReimbursement'] = [arg!, process.argv[4] ?? '', process.argv[5]];
    out('query', await queryRows(session, { formId, fieldKeys: fields, filter, limit: 60 }));
  } else if (stage === 'ids') {
    out('ids', await evalIn(session, idsSnippet(arg ?? 'CREATOR|CREATEDATE|DOCUMENTSTATUS|APPROVE|AUDIT|MODIF|CANCEL|BILLSTATUS')));
  } else if (stage === 'list-toolbar') {
    // Back to the list, select the row, and measure what the toolbar then offers. Selecting a row is not a mutation;
    // 删除 is reported with its enabled state and is NOT clicked.
    await click(session, textPoint('我的费用报销'), '我的费用报销 tab');
    await sleep(2000);
    out('toolbar-before-select', await evalIn(session, toolbarSnippet));
    if (arg && (await click(session, rowCheckPoint(arg), `row ${arg}`))) {
      await sleep(1500);
      out('toolbar-after-select', await evalIn(session, toolbarSnippet));
    }
  } else {
    console.error(`unknown stage ${stage}`);
    process.exit(1);
  }
} finally {
  session.close();
}
