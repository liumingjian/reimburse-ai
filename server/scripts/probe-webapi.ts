// Can the 费用报销单 be read — and later written and deleted — through Kingdee's own WebAPI instead of by typing
// into the Kendo grid? This script answers the READ half. It sends nothing but query services.
//
// Why it exists (2026-09-20): `executor/catalog.ts` already calls ExecuteBillQuery from inside the logged-in page
// with `credentials: 'include'`, so the WebAPI door is demonstrably open for reads. Writes, meanwhile, go through
// the DOM, which is where every measured defect lives: Kendo editor state, focus, occlusion, and a model that lags
// the cell by ~250ms. Before proposing that writes move to the API, three facts have to be measured, not assumed:
//
//   1. the whole DynamicFormService stub family is reachable from this session, not just ExecuteBillQuery;
//   2. what a real 费用报销单 looks like as an entity — which field keys exist at the head and in the detail entry;
//   3. which head field can carry a baox ownership marker without overwriting anything the employee reads.
//
// It calls View and QueryBusinessInfo, both read-only, plus ExecuteBillQuery. It never calls Save, Draft, Submit,
// Audit, Delete or any other mutating stub, and it prints field KEYS and shapes — never amounts, names or payloads.
//
//   pnpm --filter @baox/server exec tsx scripts/probe-webapi.ts <单据编号>
import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
import { READ_ONLY_SNIPPET } from '../src/erp/executor/probe';

const billNo = process.argv[2] ?? '';
const FORM = 'ER_ExpReimbursement';
const stub = (name: string) => `Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.${name}.common.kdsvc`;

// K3Cloud's own front-end sends a `kdservice-sessionid` header alongside the cookie; some service stubs answer
// 「会话信息已丢失」 without it even though the cookie is valid. The id is a credential: it is read in-page, put
// straight into the header, and never returned to this process.
const callSnippet = (service: string, params: unknown[], withSession: boolean) => `(async () => {
  const started = Date.now();
  const sid = (document.cookie.match(/(?:^|;\\s*)kdservice-sessionid=([^;]+)/) || [])[1] || '';
  const r = await fetch(${JSON.stringify('/k3cloud/')} + ${JSON.stringify(service)}, {
    method: 'POST', credentials: 'include',
    headers: Object.assign({ 'Content-Type': 'application/json' }, ${withSession} && sid ? { 'kdservice-sessionid': decodeURIComponent(sid) } : {}),
    body: JSON.stringify({ parameters: ${JSON.stringify(params)} }),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { httpStatus: r.status, ms: Date.now() - started, sentSession: ${withSession} && !!sid, parsed, raw: parsed ? null : text.slice(0, 400) };
})()`;

const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);

/** Call one query service. Returns the raw body; the caller decides what is safe to print. */
const call = async (name: string, params: unknown[], withSession = true) => {
  try { return await evalIn<any>(session, callSnippet(stub(name), params, withSession), { timeout: 120_000 }); }
  catch (error: any) { return { httpStatus: null, ms: null, parsed: null, raw: error?.message ?? String(error) }; }
};

/** ERP answers 200 for a refusal too; the body's ResponseStatus is where the reason lives. */
const status = (body: any) => {
  const first = Array.isArray(body) ? body[0] : null;
  const nested = Array.isArray(first) ? first[0] : first;
  const rs = body?.Result?.ResponseStatus ?? body?.ResponseStatus
    ?? nested?.Result?.ResponseStatus ?? nested?.ResponseStatus ?? null;
  if (!rs) return null;
  return { ok: rs.IsSuccess === true, errors: (rs.Errors ?? []).map((e: any) => e?.Message ?? String(e)).slice(0, 3) };
};

/** Describe a value without disclosing it: type and size only. */
const shape = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return `object{${Object.keys(v as object).length}}`;
  if (typeof v === 'string') return v === '' ? 'string(empty)' : `string(${v.length})`;
  return typeof v;
};

try {
  // 0. Is anyone logged in? An expired session refuses every stub identically, so this has to be read first.
  const who = await evalIn<any>(session, READ_ONLY_SNIPPET, { timeout: 20_000 });
  console.log('session:', JSON.stringify({ ready: who?.ready, onMainConsole: who?.onMainConsole, loginFormVisible: who?.loginFormVisible, loggedIn: !!who?.displayName }));

  // 1. The stub family is reachable at all — the same call catalog.ts already makes, against the bill object.
  const bare = await call('ExecuteBillQuery', [JSON.stringify({ FormId: FORM, FieldKeys: 'FBillNo,FDocumentStatus,FCreateDate', FilterString: '', StartRow: 0, Limit: 3 })], false);
  console.log('ExecuteBillQuery (no session header):', JSON.stringify({ httpStatus: bare.httpStatus, firstShape: Array.isArray(bare.parsed) ? shape(bare.parsed[0]) : shape(bare.parsed), status: status(bare.parsed) }));
  const q = await call('ExecuteBillQuery', [JSON.stringify({ FormId: FORM, FieldKeys: 'FBillNo,FDocumentStatus,FCreateDate', FilterString: '', StartRow: 0, Limit: 3 })]);
  console.log('ExecuteBillQuery:', JSON.stringify({ httpStatus: q.httpStatus, ms: q.ms, sentSession: q.sentSession, rows: Array.isArray(q.parsed) ? q.parsed.length : null, firstShape: Array.isArray(q.parsed) ? shape(q.parsed[0]) : shape(q.parsed), status: status(q.parsed), raw: q.raw }));

  // 2. Field metadata: the authoritative list of what the head and the entries carry.
  const meta = await call('QueryBusinessInfo', [JSON.stringify({ FormId: FORM })]);
  const info = meta.parsed;
  console.log('QueryBusinessInfo:', JSON.stringify({ httpStatus: meta.httpStatus, ms: meta.ms, top: info && typeof info === 'object' ? Object.keys(info).slice(0, 12) : shape(info), status: status(info), raw: meta.raw }));
  // The field list is buried; walk two levels and print keys with shapes, never values.
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 2 || !node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      console.log(`  ${path}${k}: ${shape(v)}`);
      if (!Array.isArray(v) && typeof v === 'object' && depth < 2) walk(v, `${path}${k}.`, depth + 1);
    }
  };
  walk((info as any)?.Result ?? info, 'meta.', 0);
  // The operation list answers "is Draft/Save/Delete exposed on this form" without calling any of them.
  const nrd = (info as any)?.Result?.NeedReturnData;
  const ops = Array.isArray(nrd?.Operations) ? nrd.Operations : [];
  console.log(`operations (${ops.length}):`, JSON.stringify(ops.map((o: any) => (o && typeof o === 'object' ? (o.Id ?? o.Name ?? o.Key ?? Object.keys(o).join('/')) : o))));
  if (ops[0] && typeof ops[0] === 'object') console.log('operation shape:', JSON.stringify(Object.keys(ops[0])));
  // Entity list with captions, so a field key can be named in Chinese before anything is written to it.
  const entrys = Array.isArray(nrd?.Entrys) ? nrd.Entrys : [];
  for (const e of entrys) {
    const name = Array.isArray(e?.Name) ? e.Name.map((n: any) => n?.Value ?? n).join('/') : e?.Name;
    console.log(`entity ${e?.Id ?? '?'} 「${name ?? '?'}」 keys=${JSON.stringify(Object.keys(e ?? {}))}`);
  }

  // 3. One real bill as an entity, so the head field keys are known by name. Values are never printed.
  if (billNo) {
    const view = await call('View', [FORM, JSON.stringify({ CreateOrgId: 0, Number: billNo, Id: '', IsSortBySeq: 'false' })]);
    const data = (view.parsed as any)?.Result?.Result ?? null;
    console.log('View:', JSON.stringify({ httpStatus: view.httpStatus, ms: view.ms, ok: !!data, status: status(view.parsed), top: view.parsed && typeof view.parsed === 'object' ? Object.keys(view.parsed).slice(0, 8) : shape(view.parsed), raw: view.raw?.slice?.(0, 200) ?? null }));
    if (data && typeof data === 'object') {
      const head = Object.entries(data as Record<string, unknown>).filter(([, v]) => !Array.isArray(v));
      const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
      console.log(`head fields (${head.length}):`);
      for (const [k, v] of head) console.log(`  ${k}: ${shape(v)}`);
      for (const [k, v] of entries) {
        const rows = v as unknown[];
        console.log(`entry ${k}: array[${rows.length}]`);
        const first = rows[0];
        if (first && typeof first === 'object') for (const ek of Object.keys(first as object)) console.log(`    ${ek}`);
      }
    }
  } else {
    console.log('View: skipped (no 单据编号 given on the command line)');
  }
} finally { session.close(); }
