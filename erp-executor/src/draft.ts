// 暂存 (save as draft, ADR-0029): the unattended path's end, and the one place in the executor that presses an ERP
// command that lands a bill. It presses 暂存 and nothing else — never 保存, 提交, 审核 or 删除: draft.test.ts holds every
// other module to naming none of those commands, and this one to naming 暂存's alone.
//
// A 暂存 draft has no 单据编号 (S5, live 2026-10-12: the tab turned to 修改 and FBillNo stayed empty), so the draft is
// found again by baox's ownership marker in 事由 (ExecuteBillQuery, read-only) and read back by its 内码 (WebAPI View,
// read-only). The read-back is the second of the two the design asks for: the page read-back the server has already
// judged, and this one, of what ERP actually stored.

import { evalIn, type CdpSession } from './cdp';
import { queryRows } from './catalog';
import { HIT_JS, clickReach, type Reach } from './hit';
import { waitFor } from './pace';
import { ExecutorError } from './page';
import { DRAFT_MARK, type DraftRow, type ExecutorEvent, type ReconcilePlan } from './protocol';

export const DRAFT_FORM = 'ER_ExpReimbursement';
const VIEW_SERVICE = 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.View.common.kdsvc';

const VISIBLE = `(n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}`;

// The 暂存 command: a visible node whose own text is 暂存 and whose nearest id is the bill toolbar's tbSaveTemp. Live it
// sits in the 保存 split button's group (S5: 保存, then 暂存 as tbSaveTemp, then 保存 again, then 提交 and the rest).
const DRAFT_POINT = `(() => {
  const vis = ${VISIBLE};
  const hitOf = ${HIT_JS};
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const hits = [...document.querySelectorAll('[id$="BILLMENU_TOOLBAR-tbSaveTemp"]')].filter(vis)
    .map((holder) => [holder, ...holder.querySelectorAll('*')].find((n) => own(n) === '暂存')).filter((n) => n && vis(n));
  if (hits.length !== 1) return { ok: false, count: hits.length };
  return { ok: true, ...hitOf(hits[0]) };
})()`;

// The 保存 split button's arrow, to HOVER: Kendo opens the group on mouse-over. A press there would be 保存.
const SAVE_ARROW = `(() => {
  const vis = ${VISIBLE};
  const hitOf = ${HIT_JS};
  const main = [...document.querySelectorAll('[id$="BILLMENU_TOOLBAR-tbSplitSave"]')].filter(vis);
  if (main.length !== 1) return { ok: false, count: main.length };
  const li = main[0].closest('li');
  const arrow = li ? [...li.querySelectorAll('.k-i-arrow-s')].filter(vis)[0] : null;
  if (!arrow) return { ok: false, count: 0 };
  return { ok: true, ...hitOf(arrow) };
})()`;

type Point = Partial<Reach> & { ok: boolean; count?: number };
const reachable = (p: Point | null | undefined) => p?.ok === true && p.onTarget === true;

/**
 * Press 暂存 on the open bill. The 保存 group is opened by hovering its arrow (a mouse move with no button), never by a
 * press. Refuses, having pressed nothing, when 暂存 is not exactly one reachable node.
 */
export async function pressDraft(session: CdpSession, { timeoutMs = 10_000, pollMs = 300 } = {}): Promise<void> {
  const find = () => evalIn<Point>(session, DRAFT_POINT);
  let point = await find();
  if (!reachable(point)) {
    const arrow = await evalIn<Point>(session, SAVE_ARROW);
    if (arrow?.ok && arrow.inView && typeof arrow.x === 'number' && typeof arrow.y === 'number') {
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: arrow.x, y: arrow.y, buttons: 0 });
      point = await waitFor(find, reachable, timeoutMs, pollMs);
    }
  }
  if (point?.ok !== true) throw new ExecutorError('ERP_DRAFT_COMMAND_NOT_FOUND', `找不到唯一的「暂存」（匹配 ${point?.count ?? 0} 个），没有暂存`);
  await clickReach(session, point, '「暂存」', 'ERP_DRAFT_COMMAND_OBSTRUCTED');
}

export type FoundDraft = { id: string; billNo: string | null; status: string; causa: string };

/**
 * The 暂存 drafts whose 事由 carries `mark`: ExecuteBillQuery, read-only. The mark is checked against its pattern before
 * it goes into the filter, which it is spliced into.
 */
export async function findDrafts(session: CdpSession, mark: string): Promise<{ ok: true; drafts: FoundDraft[] } | { ok: false; reason: string }> {
  if (!DRAFT_MARK.test(mark)) return { ok: false, reason: `归属标记格式不对：${mark}` };
  const res = await queryRows(session, { formId: DRAFT_FORM, fieldKeys: 'FID,FBillNo,FDocumentStatus,FCausa', filter: `FCausa like '%${mark}%'`, limit: 5 });
  if (!res.ok) return res;
  return {
    ok: true,
    drafts: res.rows.map((row) => ({ id: String(row[0] ?? ''), billNo: String(row[1] ?? '').trim() || null, status: String(row[2] ?? ''), causa: String(row[3] ?? '') }))
      // A query can match the mark inside a longer token; only the mark as a whole word is baox's.
      .filter((draft) => new RegExp(`(^|\\s)${mark}$`).test(draft.causa.trim())),
  };
}

const viewSnippet = (id: string) => `(async () => {
  const sid = (document.cookie.match(/(?:^|;\\s*)kdservice-sessionid=([^;]+)/) || [])[1] || '';
  const r = await fetch(${JSON.stringify(`/k3cloud/${VIEW_SERVICE}`)}, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'kdservice-sessionid': decodeURIComponent(sid) } : {}),
    body: JSON.stringify({ parameters: [${JSON.stringify(DRAFT_FORM)}, ${JSON.stringify(JSON.stringify({ CreateOrgId: 0, Number: '', Id: id, IsSortBySeq: 'false' }))}] }),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { httpStatus: r.status, parsed };
})()`;

/** One bill as ERP's model holds it, by 内码 (WebAPI View, read-only). Null when ERP did not return it. */
export async function viewDraft(session: CdpSession, id: string): Promise<Record<string, unknown> | null> {
  if (!/^\d+$/.test(id)) return null;
  const out = await evalIn<{ parsed: any }>(session, viewSnippet(id), { timeout: 30_000 }).catch(() => null);
  const data = out?.parsed?.Result?.Result;
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The model against the page

// A filled detail row shows its money as ¥531.13 (live 2026-10-16, 内码 119984); the model holds 531.13.
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '').replace(/,/g, '').replace(/[¥￥]/g, '');
const asNumber = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
const keyOf = (data: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const hit = Object.keys(data).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit) return data[hit];
  }
  return undefined;
};
const caption = (v: unknown): string => (Array.isArray(v) ? v.map((x: any) => x?.Value ?? x).join('') : String((v as any)?.Value ?? v ?? ''));

/** Every scalar a model row holds, normalised, a few levels into its references: a 基础资料 field is {Id, Number, Name}
 * and its Name a list of {Key, Value} per language, so a name sits four levels below the row. */
function modelValues(row: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 5 || row === null || row === undefined) return out;
  if (typeof row === 'string') out.add(norm(row));
  else if (typeof row === 'number') { out.add(String(row)); out.add(row.toFixed(2)); }
  else if (Array.isArray(row)) for (const v of row) modelValues(v, out, depth + 1);
  else if (typeof row === 'object') for (const v of Object.values(row as Record<string, unknown>)) modelValues(v, out, depth + 1);
  return out;
}

/** Is a page cell among a model row's values? Money to the cent; a date (yyyy/m/d on the page) by its parts. */
function found(cell: string, values: Set<string>): boolean {
  const n = norm(cell);
  if (values.has(n)) return true;
  const x = asNumber(n);
  const date = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(n);
  for (const v of values) {
    if (x !== null) { const y = asNumber(v); if (y !== null && Math.abs(x - y) < 0.005) return true; }
    if (date && v.startsWith(`${date[1]}-${date[2]!.padStart(2, '0')}-${date[3]!.padStart(2, '0')}`)) return true;
  }
  return false;
}

type GridRows = DraftRow[];

// Columns the page shows as the caption of an enum, a checkbox or a department (正常, 是, 普通发票…) while the model holds
// the code: live 2026-10-13 (S11) these, and only these, were not found as literals in a draft that was otherwise equal.
// They are not compared here; the page read-back the server judged before 暂存 covers them.
const DISPLAY_ONLY: Readonly<Record<string, ReadonlySet<string>>> = {
  收票分录: new Set(['发票状态', '是否勾选', '是否勾选认证', '查验状态', '发票是否有修改', '发票类别']),
  费用明细: new Set(['发票类型', '费用承担部门']),
};

function compareRows(label: string, page: GridRows, model: unknown, problems: string[]) {
  const rows = Array.isArray(model) ? model : null;
  if (!rows) { problems.push(`View 里没有${label}`); return; }
  if (rows.length !== page.length) { problems.push(`${label}：页面 ${page.length} 行，View ${rows.length} 行`); return; }
  page.forEach((row, i) => {
    const values = modelValues(rows[i]);
    const missing = Object.entries(row.values)
      .filter(([column, value]) => column && column !== '序号' && !DISPLAY_ONLY[label]?.has(column) && String(value ?? '').trim() && !found(value, values))
      .map(([column]) => column);
    if (missing.length) problems.push(`${label}第 ${i + 1} 行：${missing.join('、')} 在 View 里找不到`);
  });
}

/**
 * What ERP stored against what the page showed when the server's strict read-back passed: a 暂存 draft (status Z)
 * with no 单据编号, 事由 exactly as written, and every filled receipt and detail row, cell by cell, in order. Problems
 * name columns and counts, never values.
 */
export function compareDraft(data: Record<string, unknown>, expected: { causa: string; receipts: GridRows; details: GridRows }): string[] {
  const problems: string[] = [];
  const status = keyOf(data, 'DocumentStatus', 'FDocumentStatus');
  if (status !== 'Z') problems.push(`单据状态是 ${typeof status === 'string' ? status : '读不到'}，不是暂存`);
  if (norm(keyOf(data, 'BillNo', 'FBillNo'))) problems.push('暂存单已经有了单据编号');
  if (norm(caption(keyOf(data, 'Causa', 'FCausa'))) !== norm(expected.causa)) problems.push('事由与写入的不一致');
  compareRows('收票分录', expected.receipts, keyOf(data, 'RecInvInfo'), problems);
  compareRows('费用明细', expected.details, keyOf(data, 'ER_ExpenseReimbEntry'), problems);
  return problems;
}

/** After 暂存: the tab turns to 修改. Live it took ~1 s (S5); `timeoutMs` bounds the wait. */
export async function waitDrafted(read: () => Promise<'new' | 'modify' | null>, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  return (await waitFor(read, (m) => m === 'modify', timeoutMs, pollMs)) === 'modify';
}

export type DraftLookup = Extract<ExecutorEvent, { type: 'draft_lookup' }>;

/**
 * 对账 by ownership marker (line 2 item 5): every draft under the job's mark and under each earlier job's, and, when the
 * job's own is the only one, its View against the read-back the fill verified before 暂存. Read-only: two queries and
 * a View, no page touched. Judging what was found is the server's.
 */
export async function lookupDraft(session: CdpSession, { mark, earlier, expected }: NonNullable<ReconcilePlan['draft']>): Promise<DraftLookup> {
  const drafts: DraftLookup['drafts'] = [];
  const lookup = (problems: string[] | null, failure: string | null): DraftLookup => ({ type: 'draft_lookup', drafts, problems, failure });
  for (const each of [mark, ...earlier]) {
    const found = await findDrafts(session, each);
    // ERP's own words stay out: `failure` reaches the employee's page as the reason.
    if (!found.ok) return lookup(null, '按归属标记查暂存单，报销系统没有给出结果。');
    drafts.push(...found.drafts.map((draft) => ({ mark: each, id: draft.id, billNo: draft.billNo, status: draft.status })));
  }
  const own = drafts[0];
  if (drafts.length !== 1 || own?.mark !== mark || !expected) return lookup(null, null);
  const model = await viewDraft(session, own.id);
  if (!model) return lookup(null, `暂存单（内码 ${own.id}）找到了，但按内码读不回它。`);
  return lookup(compareDraft(model, expected), null);
}
