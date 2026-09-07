import { authorizedPage, verifyProjects, isSafeKey } from './erpcatalog.mjs';
import { readBook, writeBook, isSelectable, localToday, annotateProjects } from './projects.mjs';

/**
 * 个人项目簿的**整理动作**：删一条、清掉全部失效、复检整簿。
 *
 * 录入那一侧（projectintake.mjs）管的是"什么能进来"；这一侧管的是"怎么让它出得去"。
 * 一本只进不出的簿子会在几个月里长成一页翻不完的东西，然后用户就不再打开它了。
 *
 * 三个动作共同的一条规矩：**删除永远是用户的动作**。复检只更新判定和检查时间，
 * 它一条都不删；清理删的是用户此刻看得见的那些失效项，是他点下去的那一下。
 */

/* ================================================================= 单行删除 */

/**
 * 从簿子里**硬删**一条，按项目号。
 *
 * 没有回收站、没有软删标记，也**不弹二次确认**（那是页面那一侧的事，这里只说明为什么）：
 * 簿子不是账本，没有审计价值；一条记录的全部内容是"项目号 + ERP 回读的名称"，
 * 误删的代价只是回到维护页重新粘一次项目号。而一个确认弹窗会让"定期清理"这件事
 * 烦到没人做，最后留下的是一本没人整理的簿子——那才是真的代价。
 *
 * 删一个不在簿子里的号不是错误：用户要的结果已经成立了。两下点在同一行、
 * 或者两个页面开着同一本簿子，都会走到这里。
 */
export function removeProject(number) {
  const trimmed = typeof number === 'string' ? number.trim() : number;
  const book = readBook();
  const i = book.projects.findIndex((p) => p.number === trimmed);
  if (i === -1) {
    return { status: 'not_found', number: trimmed ?? null, book,
      note: `项目簿里没有项目号 ${String(trimmed)}，没有删除任何东西` };
  }
  const [removed] = book.projects.splice(i, 1);
  return { status: 'removed', number: removed.number, removed, book: writeBook(book),
    note: `项目 ${removed.number}「${removed.name ?? '—'}」已从项目簿删除；`
      + '还要用的话回到这一页重新粘一次项目号即可（录入即核验）' };
}

/* ========================================================== 清理全部失效 */

/**
 * 一键删掉**此刻**全部失效项（过期时间已过 ∪ 最近判定不是 confirmed，见 projects.mjs）。
 *
 * 它就是"每行删除"按下 N 次，省的是那 N 下——定期整理如果要一条条点，
 * 就会变成一件永远排在后面的事。因此它删的必须**正好**是用户在这一页上
 * 看着标了失效的那些：判定用的是同一个 `isSelectable`，不是另写一遍的一套条件。
 *
 * 没有失效项时是一次空操作，连盘都不写：一次没有效果的写入只是给
 * "簿子是不是被谁动过"这个问题多添一份噪声。
 */
export function purgeInvalidProjects(today = localToday()) {
  const book = readBook();
  const dead = book.projects.filter((p) => !isSelectable(p, today));
  if (!dead.length) {
    return { status: 'none', removedCount: 0, removed: [], book,
      note: '当前没有失效项目，一条都没删' };
  }
  const kept = book.projects.filter((p) => isSelectable(p, today));
  // 删掉的那些也要能被说出来：用户点的是"清理全部失效"，他有权知道刚才走的是哪几条。
  const removed = annotateProjects(dead, today);
  return { status: 'purged', removedCount: removed.length, removed,
    book: writeBook({ projects: kept }),
    note: `已删掉 ${removed.length} 条失效项目（${removed.map((p) => p.number).join('、')}），`
      + `簿子里还剩 ${kept.length} 条；还要用的项目重新粘一次项目号就能回来（录入即核验）`,
  };
}

/* ================================================================= 复检全部 */

/**
 * 复检整本簿子。
 *
 * 存在的理由：录入闸门只保证**录入那一刻**的事实，而项目会在那之后才被 ERP 禁用或删除。
 * 没有复检，一条早已作废的项目会一直安安静静地待在可选集合里，直到报销的最后一步炸掉。
 *
 * 三条硬约定：
 *
 * 1. **一次批量查询覆盖全簿**（`FNumber in (...)`，费用项目那侧早有同样写法），
 *    不是每条一次往返。几十条各跑一趟 CDP，用户要对着一个转圈的页面等上半分钟。
 * 2. **只更新 `lastVerdict` 与 `lastCheckedAt`。** 不删除、不改过期时间、不改名称——
 *    过期时间是用户的判断，名称是录入那一刻的回读值，复检没有权限动它们。
 *    标记归标记，删除归用户（要删有「清理全部失效」）。
 * 3. **传输层失败一条都不写。** 没问出答案不等于问出了"这些项目有问题"；
 *    把它写成 missing，等于一次网络抖动就让整本簿子在选择器里消失。
 *
 * 这里**不重试**（录入闸门会重试 3 次）。复检是用户在维护页上按下的一个按钮：
 * 失败了他再按一次就是了，而三倍的等待发生在他正盯着页面的时候。
 *
 * 手改进来的不安全项目号不进查询串（它是要拼进 ERP 过滤条件的），当场记为 `unsafe`——
 * 那条判定不是 confirmed，于是它落在失效那边，在维护页上看得见、能删。
 */
export async function recheckAll({
  gate = authorizedPage, run, now = () => new Date().toISOString(), today = localToday(),
} = {}) {
  const book = readBook();
  const at = now();

  // 空簿不用去问会话：让用户为了复检一本空簿先去登录一次 ERP 是纯粹的冒犯。
  if (!book.projects.length) {
    return { status: 'empty', queries: 0, checkedCount: 0, confirmedCount: 0, invalidCount: 0,
      book, note: '项目簿是空的，没有什么可复检的' };
  }

  const askable = book.projects.filter((p) => isSafeKey(p.number));

  // 一个号都不能安全查询时同样不问会话——这不是"查询失败"，答案已经有了。
  let checked = [];
  let queries = 0;
  if (askable.length) {
    const session = await gate();
    if (!session.ok) {
      // 没登录不算复检失败：用户什么都没做错，重按一次也不会变。指路，不报错，不写盘。
      return { status: 'not_logged_in', queries: 0, identity: session.probe, book,
        note: '还没有一个已确认身份的 ERP 会话，而复检要向 ERP 查一次；'
          + '请先在专用 Chrome 里登录 ERP（baox chrome-up），再回到这一页复检' };
    }
    const res = await verifyProjects(session.wsUrl, askable.map((p) => p.number),
      run ? { run } : undefined);
    queries = 1;
    if (!res.ok) {
      return { status: 'query_failed', queries, reason: res.reason, book,
        note: `这一次复检没能从 ERP 得到答案（${res.reason}）——这是查询本身没跑通，`
          + '不是这些项目有问题；簿子一条都没有改动，稍后再复检一次' };
    }
    checked = res.checked;
  }

  const verdicts = new Map(checked.map((c) => [c.number, c.verdict]));
  const projects = book.projects.map((p) => ({
    ...p,
    // 拼不进查询串的号没被问过，但它此刻的答案是明确的：不能安全查询就不能引用。
    lastVerdict: verdicts.get(p.number) ?? (isSafeKey(p.number) ? p.lastVerdict : 'unsafe'),
    lastCheckedAt: at,
  }));
  const written = writeBook({ projects });
  const annotated = annotateProjects(written.projects, today);
  const invalid = annotated.filter((p) => !p.selectable);

  return {
    status: 'done', queries,
    checkedCount: projects.length,
    confirmedCount: projects.filter((p) => p.lastVerdict === 'confirmed').length,
    // 失效数按**两个来源的并集**算，和维护页上标出来的失效项是同一批：
    // 用户看的是那张表，回执说的数就得对得上那张表，不能只数复检没过的。
    invalidCount: invalid.length,
    book: written,
    note: `复检了 ${projects.length} 条，其中 ${invalid.length} 条此刻失效`
      + `${invalid.length ? `（${invalid.map((p) => p.number).join('、')}）` : ''}；`
      + '复检只更新判定和检查时间，没有删除任何东西，也没有动过期时间——'
      + '要清掉失效项，点「清理全部失效」',
  };
}
