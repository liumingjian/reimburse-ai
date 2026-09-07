import { targets, evaluate } from './chrome.mjs';
import { ERP_ORIGIN } from './probe.mjs';
import { gateIdentity } from './binding.mjs';
import { CATEGORIES } from './categories.mjs';

// ERP 主数据的**只读**核对。
//
// 走的是金蝶自带的查询服务 ExecuteBillQuery：它只查不写，而且用的是用户自己
// 已经登录的会话，baox 不持有也不落盘任何凭据。这个模块只会调这一个服务地址，
// 别的什么都不调 —— 这是它敢在"只读"名义下存在的全部理由。
const QUERY_SERVICE =
  'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc';

// 两个选择器背后的业务对象不是猜的，是 2026-09-05 从 ER_ExpReimbursement 的
// 表单元数据里读出来的（QueryBusinessInfo 的 LookUpObjectFormId）：
//   FEXPID           -> BD_Expense    （费用项目）
//   F_BJYC_PROJECTID -> BJYC_ProJect  （安图特项目，自定义对象，大小写照抄）
export const EXPENSE_ITEM_FORM = 'BD_Expense';
export const PROJECT_FORM = 'BJYC_ProJect';

// 金蝶主数据的两个状态位：单据状态 C 是已审核，禁用状态 A 是未禁用。
// 只有两者同时成立的主数据才允许被引用。
const AUDITED = 'C';
const NOT_FORBIDDEN = 'A';

// 过滤条件是要拼进 ERP 查询串的，所以只放行不可能改变语义的字符。
// 编码来自本仓库的对照表，项目号来自用户输入 —— 后者尤其不能直接拼。
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeKey = (s) => typeof s === 'string' && SAFE.test(s);

// 拒绝语只有一句，核对路径和录入闸门共用。两处各写一句的话，用户会在同一条规则上
// 读到两种说法，而其中一句迟早跟着规则改动走样。
export const unsafeKeyReason = (s) => `项目号 ${JSON.stringify(s)} 含有不能安全查询的字符`;

const buildSnippet = (payload) => `(async () => {
  const r = await fetch(${JSON.stringify('/k3cloud/' + QUERY_SERVICE)}, {
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

/**
 * 跑一次只读查询。返回 { ok, rows } 或 { ok: false, reason }。
 *
 * ERP 对"查不到"和"问错了"都回 HTTP 200，区别只在报文形状：
 *   成功  [["FY008001","本地市内交通","C","A"], ...]  —— 外层数组直接就是行集，
 *         每一行是一个按 FieldKeys 顺序排列的标量数组；查不到就是空数组。
 *   失败  [[{"Result":{"ResponseStatus":{...Errors...}}}]] —— 行里第一格是个对象。
 * 所以按形状判，不按状态码判：状态码在这个接口上说明不了成败。
 */
export async function queryRows(wsUrl, { formId, fieldKeys, filter = '', limit = 50 }) {
  const payload = { FormId: formId, FieldKeys: fieldKeys, FilterString: filter,
    StartRow: 0, Limit: limit };
  const out = await evaluate(wsUrl, buildSnippet(payload), { timeout: 30000 });
  const body = out?.parsed;

  if (!Array.isArray(body)) {
    return { ok: false,
      reason: out?.raw ? `ERP 查询返回了非 JSON 内容：${out.raw}` : 'ERP 查询返回了无法解析的结果' };
  }
  const first = body[0];
  if (first !== undefined && !Array.isArray(first)) {
    return { ok: false, reason: errorMessage(first) };
  }
  // 行里第一格是对象 —— 这是错误报文，不是数据。
  if (Array.isArray(first) && first[0] !== null && typeof first[0] === 'object') {
    return { ok: false, reason: errorMessage(first[0]) };
  }
  return { ok: true, rows: body };
}

const errorMessage = (node) =>
  node?.Result?.ResponseStatus?.Errors?.[0]?.Message
  ?? node?.ResponseStatus?.Errors?.[0]?.Message
  ?? 'ERP 查询返回了无法解析的结果';

/** 找到一个身份已经核对过的 ERP 页面。身份不 matched 就不查 —— 和写入侧同一条规矩。 */
export async function authorizedPage({ origin = ERP_ORIGIN } = {}) {
  const probe = await gateIdentity({ origin });
  if (probe.status !== 'matched') return { ok: false, probe };
  const page = (await targets()).find((t) => t.id === probe.targetId);
  if (!page) return { ok: false, probe: { ...probe, status: 'no_tab' } };
  return { ok: true, probe, wsUrl: page.webSocketDebuggerUrl };
}

const statusOf = (row) => ({
  number: row[0], name: row[1],
  documentStatus: row[2], forbidStatus: row[3],
  audited: row[2] === AUDITED,
  forbidden: row[3] !== NOT_FORBIDDEN,
});

/**
 * 核对对照表里的每一个费用项目编码：ERP 里存在、名称一致、已审核、未禁用。
 *
 * 注意这条只证明**主数据存在且可引用**，不证明它在费用明细上保存得进去。
 * 后者只有真的保存并回读才算数，两件事不要混。
 */
export async function verifyExpenseItems(wsUrl, { run = queryRows } = {}) {
  const wanted = Object.entries(CATEGORIES)
    .filter(([, c]) => c.expenseItemCode)
    .map(([key, c]) => ({ key, code: c.expenseItemCode, name: c.expenseItemName, source: c.source }));

  const bad = wanted.filter((w) => !isSafeKey(w.code));
  if (bad.length) {
    return { ok: false, reason: `费用项目编码里有不能安全查询的字符：${bad.map((b) => b.key).join('、')}` };
  }

  const list = wanted.map((w) => `'${w.code}'`).join(',');
  const res = await run(wsUrl, {
    formId: EXPENSE_ITEM_FORM,
    fieldKeys: 'FNumber,FName,FDocumentStatus,FForbidStatus',
    filter: `FNumber in (${list})`,
    limit: wanted.length * 2,
  });
  if (!res.ok) return res;

  const byNumber = new Map(res.rows.map((r) => [String(r[0]), statusOf(r)]));
  const checked = wanted.map((w) => {
    const hit = byNumber.get(w.code);
    if (!hit) {
      return { ...w, verdict: 'missing',
        note: `费用项目编码 ${w.code} 在 ERP 目录里查不到，不能拿去填明细` };
    }
    if (hit.name !== w.name) {
      return { ...w, verdict: 'name_mismatch', erpName: hit.name,
        note: `编码 ${w.code} 在 ERP 里叫「${hit.name}」，对照表记的是「${w.name}」；`
          + '编码对得上名字对不上，说明对照表和 ERP 已经错位，停下来核对，不要改名字将就' };
    }
    if (!hit.audited || hit.forbidden) {
      return { ...w, verdict: 'unusable', erpName: hit.name,
        documentStatus: hit.documentStatus, forbidStatus: hit.forbidStatus,
        note: `费用项目 ${w.code}「${hit.name}」在 ERP 里`
          + `${hit.forbidden ? '已被禁用' : '还没审核'}，不能引用` };
    }
    return { ...w, verdict: 'confirmed', erpName: hit.name };
  });

  return { ok: true, formId: EXPENSE_ITEM_FORM, checked,
    problems: checked.filter((c) => c.verdict !== 'confirmed') };
}

/**
 * 一个项目号查回来的行，判成一条判定。**单条核对和批量复检共用这一处**：
 * 两边各写一遍的话，同一个已禁用的项目会在录入页和维护页上读到两种说法，
 * 而其中一句迟早跟着规则改动走样。
 *
 * "查不到"是唯一分开写的一档，所以由调用方给（`missing`）：录入那边是
 * "你刚才填的这个号不存在"，复检这边是"它自打录进来之后消失了"——
 * 同一个判定，用户要做的下一件事不同。
 */
function judgeProjectRows(number, rows, missing) {
  if (!rows.length) return missing();
  if (rows.length > 1) {
    // 一个号对上多条时 baox 不替用户挑（ADR-0006）。
    return { number, verdict: 'ambiguous', count: rows.length,
      note: `项目号 ${number} 在 ERP 里对上了 ${rows.length} 条记录，baox 不替你挑，请人工确认` };
  }
  const hit = rows[0];
  if (!hit.audited || hit.forbidden) {
    return { number, verdict: 'unusable', name: hit.name,
      documentStatus: hit.documentStatus, forbidStatus: hit.forbidStatus,
      note: `项目 ${number}「${hit.name}」在 ERP 里${hit.forbidden ? '已被禁用' : '还没审核'}，不能引用` };
  }
  return { number, verdict: 'confirmed', name: hit.name };
}

/**
 * **一次**核对一批项目号，用来复检整本个人项目簿。
 *
 * 和 `verifyProject` 判的是同一件事，差别只在往返次数：几十条项目各跑一趟 CDP，
 * 用户要对着一个转圈的页面等上半分钟。`FNumber in (...)` 是费用项目那侧早就在用的写法，
 * 这里照搬。
 *
 * 判定与单条核对一一对应：查不到 `missing`、对上多条 `ambiguous`、
 * 已禁用或没审核 `unusable`、都过得去 `confirmed`。**结果按传进来的号一一对齐**，
 * 缺席的那些照样有一条自己的判定——"ERP 没回它"正是复检要抓的那类项目。
 *
 * 任何一个号不能安全查询就整批拒绝（和 `verifyExpenseItems` 同一条规矩）：
 * 过滤串是要拼进 ERP 查询的，调用方该在问之前就把它们挑出去。
 */
export async function verifyProjects(wsUrl, numbers, { run = queryRows } = {}) {
  const wanted = [...new Set((numbers ?? []).map(String))];
  const bad = wanted.filter((n) => !isSafeKey(n));
  if (bad.length) return { ok: false, reason: unsafeKeyReason(bad[0]) };
  if (!wanted.length) return { ok: true, formId: PROJECT_FORM, checked: [] };

  // 一个号可能对上多条（那正是 ambiguous），所以放宽到两倍再加一点余量：
  // 卡在 wanted.length 上会把重复记录挤掉，那时 ambiguous 就永远查不出来了。
  const limit = wanted.length * 2 + 5;
  const res = await run(wsUrl, {
    formId: PROJECT_FORM,
    fieldKeys: 'FNumber,FName,FDocumentStatus,FForbidStatus',
    filter: `FNumber in (${wanted.map((n) => `'${n}'`).join(',')})`,
    limit,
  });
  if (!res.ok) return res;

  // 装满了就说明可能被截断了，而**被截掉的行和"这个项目没了"长得一模一样**：
  // 一条好端端的项目会被写成 missing，从可选集合里悄悄消失。这不是一个可以将就的
  // 近似——没看全就是没看全，当作一次没跑通的查询报回去，比编一个答案强。
  if (res.rows.length >= limit) {
    return { ok: false,
      reason: `这一次批量核对取回了 ${res.rows.length} 行，已经到上限，可能没取全；`
        + '没取全就分不出"这个项目没了"和"这一行被截掉了"，因此这次不作数' };
  }

  const hits = new Map(wanted.map((n) => [n, []]));
  for (const row of res.rows) hits.get(String(row[0]))?.push(statusOf(row));

  const checked = wanted.map((number) => judgeProjectRows(number, hits.get(number),
    () => ({ number, verdict: 'missing',
      note: `项目号 ${number} 在 ERP 项目目录里已经查不到了` })));

  return { ok: true, formId: PROJECT_FORM, checked };
}

/**
 * 核对一个项目号。用户在任务选择页上填的是项目序号，ERP 里就是 FNumber。
 * 只做核对，不做挑选 —— 挑哪个项目是用户的业务决定（ADR-0006）。
 */
export async function verifyProject(wsUrl, number, { run = queryRows } = {}) {
  if (!isSafeKey(number)) {
    return { ok: false, reason: unsafeKeyReason(number) };
  }
  const res = await run(wsUrl, {
    formId: PROJECT_FORM,
    fieldKeys: 'FNumber,FName,FDocumentStatus,FForbidStatus',
    filter: `FNumber = '${number}'`,
    limit: 5,
  });
  if (!res.ok) return res;

  return { ok: true, ...judgeProjectRows(number, res.rows.map(statusOf),
    () => ({ number, verdict: 'missing',
      note: `项目号 ${number} 在 ERP 项目目录里查不到；请在任务选择页上改成真实存在的项目序号` })) };
}
