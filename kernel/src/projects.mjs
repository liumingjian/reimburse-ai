import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJsonAtomic } from './paths.mjs';

/**
 * 个人项目簿：这台机器上的报销人自己誊录、长期留用的那一小份项目。
 *
 * 它是**个人绑定**的一种，所以和 identity.json 平级躺在数据根下，
 * 用同一套落盘规格（目录 0700、文件 0600、临时文件 + rename）。换一个人登录
 * 就是换一个数据根，谁也看不见谁的项目。
 *
 * 簿子里**没有"未核验"这一档**：每条在写进来那一刻都是 ERP 里真实存在、已审核、
 * 未禁用的项目（录入闸门的活，不在这个模块里）。`lastVerdict` 记的是最近一次
 * 复检的结果，它可以从 confirmed 退化，但退化不等于删除——删不删是用户的决定。
 *
 * 这里刻意只有存储：读、写、把读到的东西规整成一个可信的形状。
 * 联网核对、过期判定、增删入口各有各的票，不往这个模块里塞。
 */
export const bookPath = () => path.join(paths.root, 'projects.json');

const EMPTY = () => ({ projects: [] });

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * 把一条读到的记录规整成本票定死的形状。
 * 缺项目号的一条既选不了也显示不了——当它不存在，好过让下游到处判空。
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = str(raw.number);
  if (!number) return null;
  return {
    number: number.trim(),
    name: str(raw.name),
    confirmedAt: str(raw.confirmedAt),
    expiresOn: str(raw.expiresOn),          // null＝永不过期
    lastCheckedAt: str(raw.lastCheckedAt),
    // 缺省算 confirmed：写进来那一刻它就是核对过的，簿子里没有"未核验"这一档。
    // 认不出来的值**原样留着**，不往 confirmed 上靠——失效判定是
    // 「lastVerdict !== 'confirmed'」，所以一个手改坏的值天然落在失效那边，
    // 而把它规整成 confirmed 会让一个来路不明的项目重新可选。
    lastVerdict: str(raw.lastVerdict) ?? 'confirmed',
  };
}

/**
 * 读一份簿子。**任何读不出来的情况都返回空簿，绝不抛错**：
 * 没装过、文件被手改坏了、根本不是一份簿子，一律等价于"我还没有项目"。
 *
 * 这是有意的取舍。簿子被明说是人眼可读、可手改、可备份的文件（这是它的排障价值），
 * 手改就会有改坏的那一天；那一天用户要的是"去维护页重录一遍"，而不是一个
 * 连 baox next 都跑不起来的死局。代价是一份坏簿子会安静地看起来像空簿——
 * 用户下一次录入就会发现，而文件本身还躺在原地等人去看。
 */
export function readBook() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(bookPath(), 'utf8')); } catch { return EMPTY(); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) return EMPTY();
  return { projects: parsed.projects.map(normalize).filter(Boolean) };
}

/**
 * 整本写回，走和 identity.json 同一套落盘规格（writeJsonAtomic）。
 *
 * 只写 projects 一个字段。ERP 会话、凭据、项目目录的全量缓存都不进这个文件——
 * 簿子是用户誊录的那几条，不是 ERP 的镜像，多存一个字段就是多一处要过期的东西。
 */
export function writeBook(book) {
  const record = { projects: (book?.projects ?? []).map(normalize).filter(Boolean) };
  return writeJsonAtomic(bookPath(), record);
}

/* ---------------------------------------------------- 项目失效与可选集合 */

/**
 * **项目失效**的两个来源。命中任意一条即失效，两条取并集（ADR-0009）。
 *
 * - `EXPIRED`     用户填的过期时间已过。管"结题了但 ERP 还没禁用"这一类——
 *                 ERP 那边项目还好好的，只是这个人不该再往它上面报账了。
 * - `UNCONFIRMED` 最近一次核对判定不是 `confirmed`。管"录进来之后 ERP 那边变了"
 *                 这一类，由复检那一票喂数据；这里只认它写下的 `lastVerdict`。
 *
 * 两个来源都只把项目从**可选集合**里拿掉，**都不删除任何东西**：条目照旧留在簿子里，
 * 在维护页上看得见、标着原因，删不删是用户的动作。
 */
export const EXPIRED = 'expired';
export const UNCONFIRMED = 'unconfirmed';

/**
 * 本地日期的今天，`YYYY-MM-DD`。
 *
 * **过期只到日期粒度，而且按本地日期比较。** 用户填的是"结题日"这种日历上的日子，
 * 不是一个时刻；拿 UTC 去比，东八区的用户在自己的 12-31 上午八点就会发现项目没了。
 */
export function localToday(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 是不是一个 `YYYY-MM-DD` 的、日历上真实存在的日子。
 * 回车一趟 Date 再比回来，2026-02-30 这种会被 Date 悄悄滚到 3-02，因此挡得住。
 */
export function isValidDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * 把调用方给的"今天"收成一个能比的日期串。给不出合法的一天就现算一个。
 *
 * 这个兜底是**冲着 `.filter(isSelectable)` 去的**：Array#filter 会把下标当第二个参数
 * 递进来，于是"今天"变成 0，`'2026-01-01' < 0` 是 false，**所有过期项目又都可选了**——
 * 正好把这条规则整个废掉，而且一声不响。宁可回落到真的今天。
 */
const dayOf = (today) => (isValidDay(today) ? today : localToday());

/**
 * 一条项目此刻的全部失效原因，按 `EXPIRED`、`UNCONFIRMED` 的顺序；空数组＝还能选。
 *
 * 读不出来的 `expiresOn` **算已过期**，不算永不过期。簿子被明说是人眼可读、可手改的
 * 文件，就会有改坏的那一天；那一天"读不懂"的安全答案是把它排除在可选集合之外
 * （用户在维护页上看得见、能改能删），而不是让一个来路不明的项目继续可选。
 * 这和 `normalize()` 对认不出的 `lastVerdict` 原样留着是同一条取舍。
 */
export function invalidReasons(p, today = localToday()) {
  const day = dayOf(today);
  const reasons = [];
  const e = p?.expiresOn ?? null;
  // null＝永不过期。不少项目根本没有明确结题日期，强制填只会逼人瞎填一个 2099。
  if (e !== null && (!isValidDay(e) || e < day)) reasons.push(EXPIRED);
  if (p?.lastVerdict !== 'confirmed') reasons.push(UNCONFIRMED);
  return reasons;
}

/**
 * 项目簿里**此刻还能选**的那一条：两个失效来源一条都没命中。
 *
 * 失效不等于删除——条目照样留在簿子里给用户看、给用户决定删不删。
 */
export const isSelectable = (p, today = localToday()) => invalidReasons(p, today).length === 0;

/**
 * **选择环节唯一的候选来源。**每次调用都重新读一遍簿子、重新算一遍今天，
 * 不做任何缓存、也不做任务级快照：用户中途在维护页新加的项目，下一次打开选择器
 * 就必须能选到；跨过零点之后过期的那条，下一次问就必须已经不在里面。
 * 快照会让"我明明刚加过"和"它明明已经过期了"都变成要重启才能解释的现象。
 *
 * 注意这只影响**还没做出的选择**。已经写进任务选择记录的项目归属是任务事实，
 * 簿子后来增删、项目后来失效都不动它（见 selection.mjs 里的来源等级）。
 */
export function selectableProjects(today = localToday()) {
  const day = dayOf(today);
  return readBook().projects.filter((p) => isSelectable(p, day));
}

/** 两个失效来源在列表上的短标。长话在 `statusNote` 里，这里只够占一格。 */
const REASON_LABEL = { [EXPIRED]: '已过期', [UNCONFIRMED]: '复检未通过' };

/** 复检判定各自的说法。维护页要说清是哪一类问题，用户才知道下一步该干什么。 */
const VERDICT_NOTE = {
  missing: '最近一次核对时 ERP 里查不到这个项目号',
  ambiguous: '最近一次核对时这个项目号在 ERP 里对上了多条记录',
  unusable: '最近一次核对时 ERP 里这个项目已被禁用或还没审核',
};

/**
 * 给每条项目标上"能不能选"和"为什么不能"，**措辞只写在这一处**：维护页、CLI
 * 和以后的复检出口说的必须是同一句话，各写各的迟早会对同一条项目给出两种说法。
 *
 * 标注是**加出来的**，原有字段一个不动——这份东西下面还接着落盘和 ERP 核对。
 */
export function annotateProjects(projects, today = localToday()) {
  const day = dayOf(today);
  return (projects ?? []).map((p) => {
    const reasons = invalidReasons(p, day);
    const notes = reasons.map((r) => (r === EXPIRED
      ? (isValidDay(p.expiresOn)
        ? `已过期（过期时间 ${p.expiresOn}）`
        : `过期时间读不出来（${String(p.expiresOn)}），当作已过期`)
      : (VERDICT_NOTE[p.lastVerdict]
        ?? `最近一次核对的判定不是 confirmed（${String(p.lastVerdict)}）`)));
    return {
      ...p,
      selectable: reasons.length === 0,
      invalidReasons: reasons,
      // 短标进列表那一格，长话另起一行。两者都由内核给：维护页、CLI 和以后的复检
      // 出口说的必须是同一句话。
      statusLabel: reasons.length ? reasons.map((r) => REASON_LABEL[r]).join('・') : '可选',
      statusNote: notes.length ? notes.join('；') : null,
    };
  });
}

export const PROJECT_BOOK_EMPTY = 'project_book_empty';

/** 空簿时该说的那句话，只写一处：三个出口（内核阻塞、拒收理由、明细开放项）说法要一致。 */
export const BOOK_EMPTY_HINT =
  '打开项目簿维护页把项目逐条录进来（录入即核验），再回来做任务选择';
