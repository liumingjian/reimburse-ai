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

/* -------------------------------------------------------------- 可选集合 */

/**
 * 项目簿里**此刻还能选**的那一条。
 *
 * 失效判定就一条：`lastVerdict !== 'confirmed'`。簿子里没有"未核验"这一档
 * （录入那一刻就把未核验的挡在了外面），所以一条不是 confirmed 的记录只有两种来路：
 * 复检把它降级了，或者有人手改坏了这份文件。两种都不该再被选中——
 * 但也都不等于删除，条目照样留在簿子里给用户看、给用户决定删不删。
 *
 * 过期（`expiresOn` 已过）不在这里判：那是联网复检那一票的事，它的产物是
 * 把 `lastVerdict` 降下来。这里只读复检写下的结论，不自己算日期——
 * 两处各算一遍，迟早会对同一条项目给出两种说法。
 */
export const isSelectable = (p) => p?.lastVerdict === 'confirmed';

/**
 * **选择环节唯一的候选来源。**每次调用都重新读一遍簿子，不做任何缓存、
 * 也不做任务级快照：用户中途在维护页新加的项目，下一次打开选择器就必须能选到。
 * 快照会让"我明明刚加过"变成一个要重启才能解释的现象。
 *
 * 注意这只影响**还没做出的选择**。已经写进任务选择记录的项目归属是任务事实，
 * 簿子后来增删都不动它（见 selection.mjs 里的来源等级）。
 */
export function selectableProjects() {
  return readBook().projects.filter(isSelectable);
}

/** 状态机里那两个说法完全不同的状态名：没得选 vs 该选了。 */
export const PROJECT_BOOK_EMPTY = 'project_book_empty';

/**
 * 簿子在选择环节还能不能用。**空簿和"有得选但还没选"是两回事**：
 * 前者要用户去维护页录入，后者要用户去选——话术、actor、出口条件都不一样，
 * 上层拿一个布尔量是分不出来的，所以这里直接给状态名。
 */
export const projectBookState = () =>
  (selectableProjects().length ? 'project_book_ready' : PROJECT_BOOK_EMPTY);
