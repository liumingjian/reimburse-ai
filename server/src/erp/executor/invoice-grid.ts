// Row selection in the 发票无忧助手 (invoice assistant, 原文 发票无忧助手): walk every 票种 pane, tick every
// recognised row by identity, and refuse anything less. Nothing here consumes an invoice — ADR-0025 puts the
// consumption boundary at the 发票导入单据 click, which lives in `steps.ts` and is never reached from this file.
//
// What `server/scripts/probe-grid.ts` and `probe-tick.ts` measured live on 2026-09-19, on the real 报销系统 with a
// 12-invoice task, at the moment the old loop aborted with INVOICE_SELECTION_UNCONFIRMED:
//
//   1. The grid GROUPS BY 票种, as an antd tab strip: `数电票 10` and `数电票（铁路电子客票） 2`, the active one
//      carrying `ant-tabs-tab-active`. Only one pane's rows are on screen, so "the rows" was never all of them.
//   2. A tick SURVIVES a tab switch (ticked 4 of 10, switched away, switched back, still 4). So selection can walk
//      every pane, tick everything, and then perform ONE 发票导入单据 click — no ADR-0025 amendment is needed.
//   3. The iframe viewport is 800x530 and the table has no inner scroller. Rows 0-4 were inside it and ticked;
//      row 5 sat at the bottom edge with an IMG painted over its tick point; rows 6-9 were outside it entirely,
//      where `document.elementFromPoint` answers null and a real `Input.dispatchMouseEvent` reaches nothing.
//      The old loop snapshotted every row's coordinates once and clicked them blind — the same defect as 461f95b.
//   4. The footer 「已选取N张发票」 is NOT a selection witness: it read 已选取12张发票 unchanged through a tick, an
//      untick and two switches. It counts what was uploaded into the assistant. Nothing here reads it.
//   5. Rows carry 发票号码 (column index 2), so a row has an identity and a confirmation can name it.
//
// So every act here is measured at the moment of use, in the idiom `erpform.ts` has used from the start: scroll it
// into view, re-measure, refuse with a reason if it is still not reachable, act, and read the result back on the
// same identity. A relocation is diagnosis, so a row gets at most one; a loop would be denial.

import { clickAt, evalIn, type CdpSession } from './cdp';
import { ExecutorError } from './chromium';
import { DEFAULT_PACE, sleep, waitFor, type Pace } from './pace';

export type GridPage = { pace?: Pace };
const paceOf = (page: GridPage) => page.pace ?? DEFAULT_PACE;
const cap = (page: GridPage, ms: number) => Math.min(ms, paceOf(page).longMs);
/** Every refusal ends the same way, because that is the fact the employee needs first. */
const NOTHING_IMPORTED = '没有导入任何发票。';

const HELPERS = `
  const vis = (n) => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const text = (n) => String(n && n.innerText || '').replace(/\\s+/g, ' ').trim();
  const tabs = () => [...document.querySelectorAll('.ant-tabs-tab')].filter(vis);
  const numberCol = () => [...document.querySelectorAll('thead th')].map(text).findIndex((h) => h.includes('发票号码'));
  const rows = () => [...document.querySelectorAll('tbody tr')].filter((tr) => vis(tr) && !/measure-row/.test(String(tr.className)));
  const keyOf = (tr) => { const col = numberCol(); const cell = col < 0 ? null : [...tr.querySelectorAll('td')][col]; return cell ? text(cell) : null; };
  const inView = (b) => b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth;
  const at = (n) => { const b = n.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), inView: inView(b) }; };
  // A tab's caption is the 票种 plus its count (\`数电票 10\`); the count is the assistant's own, not a row count.
  const paneOf = (n, i) => { const caption = text(n); const m = /(\\d+)\\s*$/.exec(caption);
    return { index: i, caption, label: caption.replace(/\\s*\\d+\\s*$/, '').trim() || caption,
      count: m ? Number(m[1]) : null, active: /ant-tabs-tab-active/.test(String(n.className)) }; };
`;

export type Pane = { index: number; caption: string; label: string; count: number | null; active: boolean };
export type PaneRow = { key: string | null; checked: boolean };
export type RowTarget = {
  ok: boolean; reason?: string; count?: number; checked?: boolean; disabled?: boolean;
  x?: number; y?: number; inView?: boolean; onTop?: { tag: string; cls: string; isTarget: boolean } | null;
};

/** The 票种 tab strip. An assistant with no tab strip is one pane, and the walk below is a walk of length one. */
export const readPanes = (assistant: CdpSession) =>
  evalIn<Pane[]>(assistant, `(() => { ${HELPERS} return tabs().map(paneOf); })()`);

/** The rows of whichever pane is showing, by identity. Rows in a hidden pane are not visible and not read. */
export const readPane = (assistant: CdpSession) =>
  evalIn<{ active: string | null; rows: PaneRow[] }>(assistant, `(() => { ${HELPERS}
    const current = tabs().map(paneOf).find((p) => p.active) || null;
    return { active: current ? current.label : null,
      rows: rows().map((tr) => { const input = tr.querySelector('input.ant-checkbox-input');
        return { key: keyOf(tr), checked: Boolean(input && input.checked) }; }) };
  })()`);

/**
 * How many invoices the assistant holds across ALL 票种, which is the only number that can say whether an upload
 * batch has been recognised. Counting the visible rows cannot: with panes, a second batch lands in a pane that is
 * not showing while the first batch keeps the visible row count above zero, so the wait returns at once and the
 * executor proceeds as if the batch had been recognised. When there is no tab strip, the visible rows are all of
 * them; when a tab has no count in its caption, its rows are counted only if it is the one showing.
 */
export const recognisedTotal = (assistant: CdpSession) =>
  evalIn<number>(assistant, `(() => { ${HELPERS}
    const panes = tabs().map(paneOf);
    if (panes.length === 0) return rows().length;
    return panes.reduce((sum, p) => sum + (p.count === null ? (p.active ? rows().length : 0) : p.count), 0);
  })()`);

/** One row's checkbox, measured at the moment of use: scrolled into view, re-measured, and hit-tested. */
const rowTarget = (assistant: CdpSession, key: string, { scroll = true } = {}) =>
  evalIn<RowTarget>(assistant, `(() => { ${HELPERS}
    const want = ${JSON.stringify(key)};
    const hit = rows().filter((tr) => keyOf(tr) === want);
    if (hit.length !== 1) return { ok: false, reason: 'rows', count: hit.length };
    const input = hit[0].querySelector('input.ant-checkbox-input');
    if (!input) return { ok: false, reason: 'checkbox', count: 0 };
    if (${scroll ? 'true' : 'false'}) input.scrollIntoView({ block: 'center' });
    const point = at(input);
    // The table has no inner scroller, so scrollIntoView scrolls the assistant's own document, and this is the
    // answer a real mouse event would get at that point.
    const top = point.inView ? document.elementFromPoint(point.x, point.y) : null;
    return { ok: true, checked: input.checked, disabled: input.disabled, ...point,
      onTop: top ? { tag: top.tagName, cls: String(top.className || '').slice(0, 70),
        isTarget: top === input || top === input.parentElement || top.contains(input) } : null };
  })()`);

const tabTarget = (assistant: CdpSession, label: string) =>
  evalIn<RowTarget & { caption?: string }>(assistant, `(() => { ${HELPERS}
    const want = ${JSON.stringify(label)};
    const hit = tabs().filter((n, i) => paneOf(n, i).label === want);
    if (hit.length !== 1) return { ok: false, reason: 'tabs', count: hit.length };
    hit[0].scrollIntoView({ block: 'center' });
    return { ok: true, caption: text(hit[0]), ...at(hit[0]) };
  })()`);

const where = (pane: string | null, key: string) => (pane ? `「${pane}」里的发票 ${key}` : `发票 ${key}`);

/**
 * Tick one row and confirm THAT row reads back ticked. Refusals name the row, its 票种 and what stopped it.
 * The one permitted retry is a re-measure: if the point moved, the first click went somewhere stale and the new
 * point is worth a click. If it did not move, the point is already known to be wrong and is not clicked again.
 */
async function ensureTicked(page: GridPage, assistant: CdpSession, pane: string | null, key: string) {
  const pace = paceOf(page);
  const confirmed = () => waitFor(() => rowTarget(assistant, key, { scroll: false }),
    (value) => value?.ok === true && value.checked === true, cap(page, 5000), pace.pollMs);

  let clickedAt: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = await rowTarget(assistant, key);
    if (!target?.ok) {
      throw new ExecutorError('INVOICE_SELECTION_UNCONFIRMED',
        `发票助手里${where(pane, key)}${target?.reason === 'checkbox' ? '这一行没有勾选框' : `找到 ${target?.count ?? 0} 行，认不出该勾哪一行`}，${NOTHING_IMPORTED}`);
    }
    if (target.checked) return { key, clicked: attempt > 0 };
    if (!target.inView) {
      throw new ExecutorError('INVOICE_SELECTION_UNCONFIRMED',
        `发票助手里${where(pane, key)}滚动之后仍然不在可见范围内（y=${target.y}），不在看不见的地方点击，${NOTHING_IMPORTED}`);
    }
    if (!target.onTop || !target.onTop.isTarget) {
      throw new ExecutorError('INVOICE_SELECTION_OBSTRUCTED',
        `发票助手里${where(pane, key)}的勾选框上面盖着${target.onTop ? `另一个元素（${target.onTop.tag}${target.onTop.cls ? ` class=${target.onTop.cls}` : ''}）` : '空白'}，点不到它，${NOTHING_IMPORTED}`);
    }
    // The relocation is the diagnosis: a point already known not to have worked is not clicked a second time.
    if (clickedAt && target.x === clickedAt.x && target.y === clickedAt.y) break;
    clickedAt = { x: target.x!, y: target.y! };
    await clickAt(assistant, clickedAt.x, clickedAt.y);
    const after = await confirmed();
    if (after?.ok && after.checked) return { key, clicked: true };
  }
  throw new ExecutorError('INVOICE_SELECTION_UNCONFIRMED',
    `发票助手里${where(pane, key)}点过之后仍然没有勾上，${NOTHING_IMPORTED}`);
}

/** Bring one 票种 pane to the front and wait until it is the active one. */
async function switchTo(page: GridPage, assistant: CdpSession, label: string) {
  const pace = paceOf(page);
  const target = await tabTarget(assistant, label);
  if (!target?.ok || !target.inView) {
    throw new ExecutorError('INVOICE_GROUP_SWITCH_FAILED',
      `发票助手里「${label}」这一类发票的页签${target?.ok ? '不在可见范围内' : `匹配到 ${target?.count ?? 0} 个`}，切不过去，${NOTHING_IMPORTED}`);
  }
  await clickAt(assistant, target.x!, target.y!);
  const shown = await waitFor(() => readPane(assistant), (value) => value?.active === label, cap(page, 15_000), pace.pollMs);
  if (shown?.active !== label) {
    throw new ExecutorError('INVOICE_GROUP_SWITCH_FAILED',
      `发票助手里点了「${label}」这一类发票的页签，显示的仍然是「${shown?.active ?? '读不出'}」，${NOTHING_IMPORTED}`);
  }
  await sleep(pace.settleMs);
  return shown;
}

/**
 * Tick every recognised row in every 票种 pane, and refuse to go on unless `expected` of them are confirmed
 * ticked by 发票号码. `expected` is the task's invoice count: this repo treats one file as one invoice as one
 * 收票行, and `job.ts` already posts `receiptRowCount = plan.invoices.length` as the import postcondition.
 *
 * The walk is bounded by the number of panes and keyed by a visited set, so termination never depends on the
 * assistant signalling "no more groups" — a signal it does not have.
 */
export async function selectRecognisedInvoices(page: GridPage, assistant: CdpSession, expected: number) {
  const panes = await readPanes(assistant);
  const visited = new Set<string>();
  const ticked = new Set<string>();
  const seen = new Set<string>();

  for (let round = 0; round < Math.max(panes.length, 1); round += 1) {
    const strip = await readPanes(assistant);
    const next = strip.find((pane) => !visited.has(pane.label));
    if (strip.length > 0 && !next) break;
    if (next) {
      visited.add(next.label);
      if (!next.active) await switchTo(page, assistant, next.label);
    }
    const pane = await readPane(assistant);
    const keys = pane.rows.map((row) => row.key).filter((key): key is string => Boolean(key));
    if (keys.length !== pane.rows.length) {
      throw new ExecutorError('INVOICE_SELECTION_UNCONFIRMED',
        `发票助手里有 ${pane.rows.length - keys.length} 行读不出发票号码，认不出勾的是哪一张，${NOTHING_IMPORTED}`);
    }
    for (const key of keys) seen.add(key);
    if (seen.size > expected) {
      throw new ExecutorError('INVOICE_ASSISTANT_NOT_EMPTY',
        `发票助手里有 ${seen.size} 张发票，多于本次任务的 ${expected} 张，拒绝把不属于这次任务的发票混进来，${NOTHING_IMPORTED}`);
    }
    for (const key of keys) {
      await ensureTicked(page, assistant, pane.active, key);
      ticked.add(key);
    }
  }

  if (ticked.size < expected) {
    throw new ExecutorError('INVOICE_SELECTION_INCOMPLETE',
      `任务有 ${expected} 张发票，发票助手里只勾上了 ${ticked.size} 张，拒绝只导入一部分。${NOTHING_IMPORTED}`);
  }
  // An assistant with no tab strip is one pane, and the walk above was a walk of length one.
  return { ok: true as const, selected: ticked.size, panes: visited.size || 1 };
}
