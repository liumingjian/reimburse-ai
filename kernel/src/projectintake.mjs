import { authorizedPage, verifyProject, isSafeKey, unsafeKeyReason } from './erpcatalog.mjs';
import { readBook, writeBook, isValidDay, localToday } from './projects.mjs';

/**
 * 个人项目簿的**录入闸门**。
 *
 * 簿子那条不变量——"里面每一条在录入那一刻都是 ERP 里真实存在、已审核、未禁用的项目"
 * ——是在这里守住的，不在存储层（`projects.mjs` 只管落盘）。所以进簿只有这一条路：
 * 用户给一个项目号，内核当场向 ERP 做一次只读核对（ADR-0008 的 `verifyProject`），
 * `confirmed` 才写，其余一律拒。
 *
 * **用户只填项目号和过期时间，名称由 ERP 回读写入。** 用户手打的名字没有权威性，
 * 还会和 ERP 错位；这里连收都不收（`intakeProject` 没有名称参数）。过期时间反过来
 * 只能由用户给——"这个项目我还报不报"是他的判断，ERP 那边没有这个事实。
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
 * **过期时间取本次提交的值，覆盖旧值**（#79）。重录就是把那张表又填了一遍，
 * 过期时间那一格也在表上；留空提交就是"我不再给它设结题日了"。保留旧值反而会让
 * "我明明清空了它却还在过期"变成一个没法从页面上解释的现象。
 */
function admit(number, name, expiresOn, at) {
  const book = readBook();
  const i = book.projects.findIndex((p) => p.number === number);
  const entry = {
    number, name,
    confirmedAt: at,
    expiresOn,
    lastCheckedAt: at,
    lastVerdict: 'confirmed',
  };
  if (i > -1) book.projects[i] = entry; else book.projects.push(entry);
  return { entry, book: writeBook(book) };
}

/**
 * 把页面递来的过期时间收成落盘的形状：`null`＝永不过期，或者一个合法的 `YYYY-MM-DD`。
 * 读不出来的一律拒，`{ bad: true }`。
 *
 * 空白等于留空。**留空是一等公民，不是漏填**：不少项目根本没有明确结题日期，
 * 强制填只会逼人瞎填一个 2099，那这个字段就废了。
 */
function readExpiresOn(raw) {
  if (raw === null || raw === undefined) return { day: null };
  if (typeof raw !== 'string') return { bad: true };
  const trimmed = raw.trim();
  if (trimmed === '') return { day: null };
  return isValidDay(trimmed) ? { day: trimmed } : { bad: true };
}

/**
 * 录一个项目号进簿。返回的 `status` 是本次录入的最终答案，四种：
 *
 * - `admitted`     进簿了，`entry` 是刚写进去的那条
 * - `rejected`     当场被拒，`verdict` 是 `unsafe`/`bad_expires_on`（都不问 ERP）或
 *                  `missing`/`ambiguous`/`unusable`（ERP 给的明确否定答案）
 * - `query_failed` 重试到头还是没问出答案，这次录入失败，稍后再试
 * - `not_logged_in` 没有身份已 matched 的 ERP 会话；**这既不是失败也不重试**，去登录就好
 *
 * 每种结果都带回**当前簿子**（`book`）：一次被拒不该让页面上的列表消失，
 * 用户还要看着它继续干活。
 *
 * 第二个参数是**用户填的过期时间**（可空＝永不过期），第三个才是依赖注入口
 * （`gate` / `run` / `now` / `today`）。两者分开是**故意**的：用户提交的字段和
 * 内核的注入点混在一个对象里，页面那边多传一个键就等于让浏览器决定用哪个 gate。
 *
 * `run` 就是 erpcatalog 那一层的查询函数，原样往下传给 `verifyProject` ——
 * 测试因此喂的是**实测报文形状的行集**，走的是真的判定逻辑，
 * 而不是一份自己编的判定结果。
 */
export async function intakeProject(number, expiresOn = null, {
  gate = authorizedPage, run, now = () => new Date().toISOString(), today = localToday(),
} = {}) {
  // 旧的两参写法（number, opts）一旦残留，opts 会被当成过期时间，gate/run 全落空——
  // 那是一次会去碰真 ERP 的调用。宁可当场响，不静悄悄地跑。
  if (expiresOn !== null && typeof expiresOn === 'object') {
    throw new TypeError('intakeProject 的第二个参数是过期时间（字符串或 null），不是依赖注入口');
  }
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

  // 过期时间也排在会话和查询前面：它是纯本地的判断，读不出来的日期不值得去问一次 ERP，
  // 更不值得让用户先去登录一趟才发现自己日期填错了。
  const expiry = readExpiresOn(expiresOn);
  if (expiry.bad) {
    return result('rejected', { verdict: 'bad_expires_on',
      note: `过期时间「${String(expiresOn)}」读不出来，没有加入项目簿；`
        + '请按 年-月-日（YYYY-MM-DD）填一个真实存在的日子，没有明确结题日期就留空（留空＝永不过期）' });
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

  const { entry, book } = admit(trimmed, last.name, expiry.day, now());
  // 过期时间是用户刚填的，回执里复述一遍：填了什么、意味着什么，当场看得见。
  // 填了一个已经过去的日子照收不误（他有权把一个已结题的项目留在簿子里），
  // 但必须说清它现在选不中——不然他会以为加进去了就能选，回到选择器才发现没有。
  const expiryNote = entry.expiresOn === null
    ? '没填过期时间，永不过期'
    : (entry.expiresOn < today
      ? `过期时间 ${entry.expiresOn} 已过，它已过期，不会出现在选择器的可选集合里（维护页上还看得见）`
      : `过期时间 ${entry.expiresOn}，过了那天它就不再出现在选择器里`);
  return { status: 'admitted', number: trimmed, entry, book,
    note: `项目 ${entry.number}「${entry.name}」已加入项目簿，名称取自 ERP 回读值；${expiryNote}` };
}
