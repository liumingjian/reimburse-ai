// 报销信息核对 (catalog check): the read-only check that every project and expense item of the plan exists in ERP,
// carries the expected name, is audited and not forbidden. A mismatch aborts before import, with no attempt.
// Origin: 50931a3:kernel/src/erpcatalog.mjs (queryRows, verifyExpenseItems, verifyProject). It calls only Kingdee's own
// query service ExecuteBillQuery, with the user's logged-in session; nothing is written.

import { evalIn, type CdpSession } from './cdp';

const QUERY_SERVICE = 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc';
// Business objects read from ER_ExpReimbursement's metadata (LookUpObjectFormId), 2026-09-05.
export const EXPENSE_ITEM_FORM = 'BD_Expense';
export const PROJECT_FORM = 'BJYC_ProJect';
// Kingdee status bits: document status C = audited, forbid status A = not forbidden.
const AUDITED = 'C';
const NOT_FORBIDDEN = 'A';
// Filter values are spliced into the query string, so only characters that cannot change its meaning pass.
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeKey = (s: unknown): s is string => typeof s === 'string' && SAFE.test(s);

const buildSnippet = (payload: unknown) => `(async () => {
  const r = await fetch(${JSON.stringify(`/k3cloud/${QUERY_SERVICE}`)}, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: [${JSON.stringify(JSON.stringify(payload))}] }),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { httpStatus: r.status, parsed, raw: parsed ? null : text.slice(0, 300) };
})()`;

const errorMessage = (node: any) => node?.Result?.ResponseStatus?.Errors?.[0]?.Message ?? node?.ResponseStatus?.Errors?.[0]?.Message ?? 'ERP 查询返回了无法解析的结果';

/** One read-only query. ERP answers 200 for both "none" and "wrong question"; the body's shape tells them apart. */
export async function queryRows(session: CdpSession, { formId, fieldKeys, filter = '', limit = 50 }: { formId: string; fieldKeys: string; filter?: string; limit?: number }):
  Promise<{ ok: true; rows: unknown[][] } | { ok: false; reason: string }> {
  let out: { parsed: unknown; raw: string | null } | null;
  try {
    out = await evalIn(session, buildSnippet({ FormId: formId, FieldKeys: fieldKeys, FilterString: filter, StartRow: 0, Limit: limit }), { timeout: 30_000 });
  } catch (error: any) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
  const body = out?.parsed;
  if (!Array.isArray(body)) return { ok: false, reason: out?.raw ? `ERP 查询返回了非 JSON 内容：${out.raw}` : 'ERP 查询返回了无法解析的结果' };
  const first = body[0];
  if (first !== undefined && !Array.isArray(first)) return { ok: false, reason: errorMessage(first) };
  if (Array.isArray(first) && first[0] !== null && typeof first[0] === 'object') return { ok: false, reason: errorMessage(first[0]) };
  return { ok: true, rows: body as unknown[][] };
}

export type CatalogProblem = { kind: 'project' | 'expense_item'; code: string; verdict: string; expectedName: string; erpName: string | null };

const statusOf = (row: unknown[]) => ({ number: String(row[0]), name: typeof row[1] === 'string' ? row[1].trim() : '', audited: row[2] === AUDITED, forbidden: row[3] !== NOT_FORBIDDEN });

/** Check the plan's catalog entries. `problems` empty means every entry is confirmed. */
export async function checkCatalog(session: CdpSession, expected: { projects: Array<{ code: string; name: string }>; expenseItems: Array<{ code: string; name: string }> }):
  Promise<{ ok: true; problems: CatalogProblem[]; projects: Array<{ code: string; name: string }> } | { ok: false; reason: string }> {
  const unsafe = [...expected.projects, ...expected.expenseItems].filter((entry) => !isSafeKey(entry.code));
  if (unsafe.length) return { ok: false, reason: `编码里有不能安全查询的字符：${unsafe.map((entry) => entry.code).join('、')}` };
  const problems: CatalogProblem[] = [];
  const projects: Array<{ code: string; name: string }> = [];

  if (expected.expenseItems.length) {
    const list = expected.expenseItems.map((entry) => `'${entry.code}'`).join(',');
    const res = await queryRows(session, { formId: EXPENSE_ITEM_FORM, fieldKeys: 'FNumber,FName,FDocumentStatus,FForbidStatus', filter: `FNumber in (${list})`, limit: expected.expenseItems.length * 2 });
    if (!res.ok) return res;
    const byNumber = new Map(res.rows.map((row) => [String(row[0]), statusOf(row)]));
    for (const entry of expected.expenseItems) {
      const hit = byNumber.get(entry.code);
      const verdict = !hit ? 'missing' : hit.name !== entry.name ? 'name_mismatch' : !hit.audited || hit.forbidden ? 'unusable' : 'confirmed';
      if (verdict !== 'confirmed') problems.push({ kind: 'expense_item', code: entry.code, verdict, expectedName: entry.name, erpName: hit?.name ?? null });
    }
  }

  for (const entry of expected.projects) {
    const res = await queryRows(session, { formId: PROJECT_FORM, fieldKeys: 'FNumber,FName,FDocumentStatus,FForbidStatus', filter: `FNumber = '${entry.code}'`, limit: 5 });
    if (!res.ok) return res;
    // Several records for one number are never picked between.
    const hit = res.rows.length === 1 ? statusOf(res.rows[0]!) : null;
    const verdict = res.rows.length === 0 ? 'missing' : res.rows.length > 1 ? 'ambiguous'
      : hit!.number !== entry.code ? 'missing' : !hit!.audited || hit!.forbidden || !hit!.name ? 'unusable' : 'confirmed';
    if (verdict !== 'confirmed') problems.push({ kind: 'project', code: entry.code, verdict, expectedName: entry.name, erpName: hit?.name ?? null });
    else projects.push({ code: entry.code, name: hit!.name });
  }
  return { ok: true, problems, projects };
}
