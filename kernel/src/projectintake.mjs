import { authorizedPage, verifyProject, isSafeKey, unsafeKeyReason } from './erpcatalog.mjs';
import { readBook, writeBook } from './projects.mjs';

/**
 * 个人项目簿的**录入闸门**。
 *
 * 簿子那条不变量——"里面每一条在录入那一刻都是 ERP 里真实存在、已审核、未禁用的项目"
 * ——是在这里守住的，不在存储层（`projects.mjs` 只管落盘）。所以进簿只有这一条路：
 * 用户给一个项目号，内核当场向 ERP 做一次只读核对（ADR-0008 的 `verifyProject`），
 * `confirmed` 才写，其余一律拒。
 *
 * **用户只填项目号，名称由 ERP 回读写入。** 用户手打的名字没有权威性，还会和 ERP 错位；
 * 这里连收都不收（`intakeProject` 没有名称参数）。
 *
 * 代价是录入项目成为一个联网动作。这是这条不变量的价格，ADR-0009 认下来了。
 */

/**
 * 传输层失败时，头一次问完之后最多**再**问几次（所以一次录入最多发出 1 + 3 次查询）。
 *
 * 只对"没问出答案"重试：查询超时、返回非 JSON、CDP 断开。
 * `missing` / `ambiguous` / `unusable` 是 ERP 给出的**明确答案**，重试只是把同一个
 * 答案要三遍，还让用户多等两个来回。
 */
export const MAX_RETRIES = 3;

const forbidden = (v) => v.forbidStatus !== undefined && v.forbidStatus !== 'A';

/** 四类明确判定各自的话术。都要说清"没进簿"和"下一步该干什么"。 */
function rejection(number, v) {
  if (v.verdict === 'missing') {
    return { verdict: 'missing',
      note: `项目号 ${number} 在 ERP 项目目录里查不到，没有加入项目簿；`
        + '请回 ERP 核对后改成真实存在的项目号再加入' };
  }
  if (v.verdict === 'ambiguous') {
    // 一个号对上多条时 baox 不替用户挑（ADR-0008），录入这一侧同样不挑。
    return { verdict: 'ambiguous',
      note: `项目号 ${number} 在 ERP 里对上了 ${v.count} 条记录，baox 不替你挑，没有加入项目簿；`
        + '请在 ERP 里核实唯一的那个项目号再加入' };
  }
  return { verdict: 'unusable', name: v.name ?? null,
    documentStatus: v.documentStatus ?? null, forbidStatus: v.forbidStatus ?? null,
    note: `项目 ${number}「${v.name}」在 ERP 里${forbidden(v) ? '已被禁用' : '还没审核'}，`
      + '不能引用，没有加入项目簿' };
}

/**
 * 把一条确认过的项目写进簿子。**同一个项目号刷新既有那条，不新增一行**，
 * 位置也不动——重录一次是"我又确认了一遍"，不是"这是个新项目"。
 *
 * `expiresOn` 是用户自己填的（"结题了但 ERP 还没禁用"归它管），一次重录不该把它抹掉。
 */
function admit(number, name, at) {
  const book = readBook();
  const i = book.projects.findIndex((p) => p.number === number);
  const entry = {
    number, name,
    confirmedAt: at,
    expiresOn: i > -1 ? book.projects[i].expiresOn : null,
    lastCheckedAt: at,
    lastVerdict: 'confirmed',
  };
  if (i > -1) book.projects[i] = entry; else book.projects.push(entry);
  return { entry, book: writeBook(book) };
}

/**
 * 录一个项目号进簿。返回的 `status` 是本次录入的最终答案，四种：
 *
 * - `admitted`     进簿了，`entry` 是刚写进去的那条
 * - `rejected`     ERP 给了明确的否定答案，`verdict` 是 `unsafe`/`missing`/`ambiguous`/`unusable`
 * - `query_failed` 重试到头还是没问出答案，这次录入失败，稍后再试
 * - `not_logged_in` 没有身份已 matched 的 ERP 会话；**这既不是失败也不重试**，去登录就好
 *
 * 每种结果都带回**当前簿子**（`book`）：一次被拒不该让页面上的列表消失，
 * 用户还要看着它继续干活。
 *
 * 依赖全部可注入（`gate` / `run` / `now`）。`run` 就是 erpcatalog 那一层的查询函数，
 * 原样往下传给 `verifyProject` —— 测试因此喂的是**实测报文形状的行集**，
 * 走的是真的判定逻辑，而不是一份自己编的判定结果。
 */
export async function intakeProject(number, {
  gate = authorizedPage, run, now = () => new Date().toISOString(),
} = {}) {
  const trimmed = typeof number === 'string' ? number.trim() : number;
  // 每条结果都长这个样子，只有中间那几个字段不同；簿子一律现读现给。
  const result = (status, fields) => ({ status, number: trimmed ?? null, ...fields, book: readBook() });

  // 空框不是"不安全的项目号"，是"还没填"。同一句"含有不能安全查询的字符"套上去
  // 会变成一句看不懂的话（项目号 "" 含有……），用户读了不知道该干什么。
  if (typeof trimmed !== 'string' || trimmed === '') {
    return result('rejected', { verdict: 'unsafe',
      note: '还没填项目号。从 ERP 里复制一个项目号粘进来，再点「核对并加入」' });
  }

  // 安全键排在**所有**事情前面——连会话都不用问。拼不进查询串的号，登不登录都是拒，
  // 而且这一步保证了不安全的号在任何查询发生之前就被挡掉（沿用 erpcatalog 的规则与拒绝语）。
  if (!isSafeKey(trimmed)) {
    return result('rejected', { verdict: 'unsafe', note: `${unsafeKeyReason(trimmed)}，没有加入项目簿` });
  }

  const session = await gate();
  if (!session.ok) {
    // 没登录不算"录入失败"：用户什么都没做错，重试也不会变。指路，不报错。
    return result('not_logged_in', { identity: session.probe,
      note: '还没有一个已确认身份的 ERP 会话，而录入项目要当场向 ERP 核对；'
        + '请先在专用 Chrome 里登录 ERP（baox chrome-up），再回到这一页加入' });
  }

  // 头一次问，加上最多 MAX_RETRIES 次重试。
  let last;
  let queries = 0;
  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    last = await verifyProject(session.wsUrl, trimmed, run ? { run } : undefined);
    queries += 1;
    // ok === false 在这里只可能是传输层没问出答案：不安全的号上面已经挡掉了。
    if (last.ok !== false) break;
  }

  if (last.ok === false) {
    return result('query_failed', { reason: last.reason, queries,
      note: `问了 ${queries} 次都没能从 ERP 得到这个项目号的答案（${last.reason}）；`
        + '这是查询本身没跑通，不是项目有问题，稍后再试' });
  }

  if (last.verdict !== 'confirmed') {
    return result('rejected', rejection(trimmed, last));
  }

  const { entry, book } = admit(trimmed, last.name, now());
  return { status: 'admitted', number: trimmed, entry, book,
    note: `项目 ${entry.number}「${entry.name}」已加入项目簿，名称取自 ERP 回读值` };
}
