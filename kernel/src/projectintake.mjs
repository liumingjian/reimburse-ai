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
 * 传输层失败时，这个项目号最多被问几次。
 *
 * 只对"没问出答案"重试：查询超时、返回非 JSON、CDP 断开。
 * `missing` / `ambiguous` / `unusable` 是 ERP 给出的**明确答案**，重试只是把同一个
 * 答案要三遍，还让用户多等两个来回。
 */
export const MAX_QUERIES = 3;

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
 * - `query_failed` 连着 {@link MAX_QUERIES} 次都没问出答案，这次录入失败，稍后再试
 * - `not_logged_in` 没有身份已 matched 的 ERP 会话；**这既不是失败也不重试**，去登录就好
 *
 * 每种结果都带回**当前簿子**：一次被拒不该让页面上的列表消失，用户还要看着它继续干活。
 *
 * 依赖全部可注入（`gate` / `verify` / `now`），测试因此能喂实测报文形状而全程不联网。
 */
export async function intakeProject(number, {
  gate = authorizedPage, verify = verifyProject, now = () => new Date().toISOString(),
} = {}) {
  const trimmed = typeof number === 'string' ? number.trim() : number;

  // 安全键排在**所有**事情前面——连会话都不用问。拼不进查询串的号，登不登录都是拒，
  // 而且这一步保证了不安全的号在任何查询发生之前就被挡掉（沿用 erpcatalog 的规则与拒绝语）。
  if (!isSafeKey(trimmed)) {
    return { status: 'rejected', verdict: 'unsafe', number: trimmed ?? null,
      note: `${unsafeKeyReason(trimmed)}，没有加入项目簿`, book: readBook() };
  }

  const session = await gate();
  if (!session.ok) {
    // 没登录不算"录入失败"：用户什么都没做错，重试也不会变。指路，不报错。
    return { status: 'not_logged_in', number: trimmed, identity: session.probe,
      note: '还没有一个已确认身份的 ERP 会话，而录入项目要当场向 ERP 核对；'
        + '请先在专用 Chrome 里登录 ERP（baox chrome-up），再回到这一页加入',
      book: readBook() };
  }

  let last;
  for (let attempt = 1; attempt <= MAX_QUERIES; attempt++) {
    last = await verify(session.wsUrl, trimmed);
    // ok === false 在这里只可能是传输层没问出答案：不安全的号上面已经挡掉了。
    if (last.ok !== false) break;
  }

  if (last.ok === false) {
    return { status: 'query_failed', number: trimmed, reason: last.reason, queries: MAX_QUERIES,
      note: `连着 ${MAX_QUERIES} 次都没能从 ERP 问出这个项目号的答案（${last.reason}）；`
        + '这是查询本身没跑通，不是项目有问题，稍后再试',
      book: readBook() };
  }

  if (last.verdict !== 'confirmed') {
    return { status: 'rejected', number: trimmed, ...rejection(trimmed, last), book: readBook() };
  }

  const { entry, book } = admit(trimmed, last.name, now());
  return { status: 'admitted', number: trimmed, entry, book,
    note: `项目 ${entry.number}「${entry.name}」已加入项目簿，名称取自 ERP 回读值` };
}
