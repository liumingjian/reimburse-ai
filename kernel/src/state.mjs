/**
 * 状态判定：**纯函数**。入参是一个已经采集好的观测对象，
 * 不读文件、不发请求、不碰浏览器（采集在 observe.mjs 里）。
 *
 * 分层是硬要求，不是风格：状态判定的测试要能在一台没有 Chrome、
 * 没有材料目录、没登录过 ERP 的机器上跑完。判断被钉住了，取数才谈得上可换。
 *
 * 判据一字不改地照 docs/design/state-machine.md 的两张表。现在落成的是
 * A 表（环境七态）、永远排在最前的 schema_too_new，以及 B 表从任务建立
 * 到看图读数这一段；B 表后面的状态按同样的方式往 RULES 后面接。
 */
import { bindingVerdict } from './binding.mjs';

/**
 * 每一类开放项由谁解决。这不是分类学，是**每条待办都要说清楚谁能动手** ——
 * 一条谁也不认领的待办，用户只能干等，模型只能瞎猜。
 *
 * `user`：只有人能做（换一份能读的文件、把重复的票拿走、对着原件确认）。
 * `model`：模型自己动手（看图读数）。
 * `kernel`：内核已经自己处置了，报出来只为留痕，不拦路。
 */
const PLAIN = {
  // 盘点层
  read_error: 'user',
  empty_file: 'user',
  unsupported_format: 'user',
  symlink: 'user',
  not_a_regular_file: 'user',
  extension_mismatch: 'kernel',
  duplicate_content: 'user',
  // 分流解析层
  no_text_in_pdf: 'user',
  kind_unrecognized: 'user',
  image_unreadable: 'user',
  // 内核自己解不开图像头。这是材料的问题，只有人换得了一份能看的原件 ——
  // 也正因为它由内核判定，「图片显示不出来」这句话就再也轮不到模型来说。
  image_file_broken: 'user',
  // 模型连着答不出「看过的凭据」。到这一步它已经不是模型再读一遍的事了。
  sight_unproven: 'user',
  identity_incomplete: 'user',
  issue_date_missing: 'user',
  amount_mismatch: 'user',
  amount_missing: 'user',
  amount_not_on_face: 'kernel',
  duplicate_invoice: 'user',
  no_primary_voucher: 'user',
  // 跨任务查重
  duplicate_across_tasks: 'user',
  history_scope_local: 'kernel',
};

/**
 * 看图读数这一段的开放项。它们**各有各的状态**（不混进盘点待办），
 * 所以除了「谁解决」还要记一句「归哪个状态」。
 *
 * 一处定义，三处使用：解决人、`OWN_STATE_KINDS`、`READING_KINDS`。
 * 分成三张表抄三遍的话，加一种就得记得改三个地方 —— 而漏改的那一处，
 * 表现是某个状态永远轮不上，且在代码里看不出来。
 */
const READING_ITEMS = {
  image_awaiting_reading: 'model',
  reading_rejected: 'model',
  reading_stale: 'model',
  reading_awaiting_confirmation: 'user',
};

const RESOLVER = { ...PLAIN, ...READING_ITEMS };

/**
 * 开放项 -> 契约里的 blockedBy 一项。认不出的种类归给 `user`：
 * 兜底兜到人这一侧是安全的一侧 —— 最坏是多问一句，而不是内核替人默认了什么。
 */
const asBlocker = (i) => ({
  kind: i.kind,
  materialId: i.materialId ?? null,
  ...(i.materialIds ? { materialIds: i.materialIds } : {}),
  fileName: i.fileName ?? null,
  hint: i.note ?? null,
  resolvableBy: RESOLVER[i.kind] ?? 'user',
  blocking: !!i.blocking,
});

/** 任务这一侧观测过没有。没观测过就只答得了环境那半张表。 */
const taskSeen = (o) => o.taskObserved === true;

/**
 * 自己有状态的那些开放项，不混进"盘点待办"里 —— 它们的解决人不是同一个：
 * 看图读数归模型，跨任务重复要用户在两个任务之间裁决。
 *
 * 一处定义，两处使用（这里和 classify.mjs 的"图还没看就别说没有凭证"）：
 * 抄一份的话，将来加 `reading_rejected` 就得记得改两个地方。
 */
export const OWN_STATE_KINDS = new Set([...Object.keys(READING_ITEMS), 'duplicate_across_tasks']);

/** 其中属于"图还没读完"的那几种。 */
export const READING_KINDS = new Set(Object.keys(READING_ITEMS));

const itemsOf = (o) => o.openItems ?? [];
const hasBlockingItem = (o, pred) => itemsOf(o).some((i) => i.blocking && pred(i));

/** 会把材料开放项原样带上的那些状态。前面那几个状态内核下一步就自己重算，报早了是噪音。 */
const MATERIAL_STATES = new Set(['intake_open_items', 'image_awaiting_reading', 'reading_rejected',
  'reading_stale', 'reading_awaiting_confirmation', 'duplicate_blocked', 'events_pending']);

/** 数据目录的格式版本。它才是版本闸的判据 —— 该判的是数据格式，不是代码版本。 */
export const SCHEMA_VERSION = 1;

/** 内核用 Node 内建的全局 WebSocket 走 CDP，21 以下没有。 */
export const MIN_NODE_MAJOR = 21;

/**
 * 判定顺序就是这张表的顺序：同时满足多个判据时，越靠前的先报。
 * `schema_too_new` 永远最先 —— 数据格式比内核新的时候，后面每一条判据
 * 都是拿旧眼睛看新数据，判出来的东西不作数。
 */
const RULES = [
  {
    state: 'schema_too_new',
    actor: 'user',
    when: (o) => (o.schemaVersion ?? SCHEMA_VERSION) > SCHEMA_VERSION,
    blocker: (o) => ({ kind: 'schema_too_new', resolvableBy: 'user',
      hint: `数据目录的格式版本是 ${o.schemaVersion}，这个内核只认到 ${SCHEMA_VERSION}；先升级 baox` }),
  },
  {
    state: 'env_node_unsupported',
    actor: 'user',
    when: (o) => o.nodeMajor < MIN_NODE_MAJOR,
    blocker: (o) => ({ kind: 'node_unsupported', resolvableBy: 'user',
      hint: `当前 Node 是 ${o.nodeVersion ?? o.nodeMajor}，内核要 ${MIN_NODE_MAJOR} 及以上` }),
  },
  {
    state: 'env_chrome_down',
    actor: 'kernel',
    when: (o) => !o.cdpUp,
  },
  {
    state: 'env_not_logged_in',
    actor: 'user',
    when: (o) => o.probe?.status === 'not_logged_in',
    blocker: () => ({ kind: 'not_logged_in', resolvableBy: 'user',
      hint: '专用 Chrome 里的 ERP 停在登录页；只有你本人能登，baox 不代填账号密码' }),
  },
  {
    // 页面加载中、读不出且没有登录表单、专用 Chrome 里根本没开着 ERP，
    // 以及读出了人但凑不出可比身份（account/tenant 缺一）：
    // 都是「探针给不出确定结论」，都要人看一眼那个窗口，重试解决不了。
    state: 'env_identity_unknown',
    actor: 'user',
    when: (o) => ['loading', 'unknown', 'no_tab'].includes(o.probe?.status)
      || (o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'incomplete'),
    blocker: (o) => ({ kind: 'identity_unknown', resolvableBy: 'user',
      hint: o.probe?.status === 'no_tab'
        ? '专用 Chrome 里没有开着 ERP 的页面；请在那个窗口里打开 ERP'
        : '读不出当前登录的是谁，也看不见登录表单；请人工看一眼那个 Chrome 窗口' }),
  },
  {
    state: 'env_identity_unbound',
    actor: 'user',
    when: (o) => o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'unbound',
  },
  {
    state: 'env_identity_mismatched',
    actor: 'user',
    when: (o) => o.probe?.status === 'matched' && bindingVerdict(o.binding, o.probe.identity) === 'mismatched',
    blocker: (o) => ({ kind: 'identity_mismatched', resolvableBy: 'user',
      hint: `这台机器绑定的是 ${o.binding.displayName ?? o.binding.account}，`
        + `ERP 当前登录的是 ${o.probe.identity.displayName ?? o.probe.identity.account}；`
        + 'baox 只替绑定的那个人报销' }),
  },

  // —— B 表：任务主干 ——
  // 这半张表要任务观测才判得动（observeTask）。只采了环境观测时它们整段跳过，
  // 答案停在 env_ready —— 没看过材料就说材料怎么样，那是编的。
  {
    state: 'task_none',
    actor: 'kernel',
    when: (o) => taskSeen(o) && !o.task,
  },
  {
    // 材料目录里加了文件、换了文件、删了文件，内容哈希就对不上上一次盘点。
    // 这个判据是内核自己算出来的，不问模型 —— 模型记不记得说一声都一样。
    state: 'inventory_stale',
    actor: 'kernel',
    when: (o) => taskSeen(o) && o.inventoryStale,
  },
  {
    // 盘点和分流报出来的待办，除了看图读数那三种（它们各有各的状态）。
    // 排在 classify_pending 前面是照表：有读不出、认不出的材料时，
    // 先把这些说清楚，而不是先去解析一堆注定解析不了的东西。
    state: 'intake_open_items',
    actor: 'user',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => !OWN_STATE_KINDS.has(i.kind)),
  },
  {
    state: 'classify_pending',
    actor: 'kernel',
    when: (o) => taskSeen(o) && !o.classificationRecorded,
  },
  {
    state: 'image_awaiting_reading',
    actor: 'model',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'image_awaiting_reading'),
  },
  {
    // 上一次读数没过内核的校验（格式、守恒式、或者根本没答对"看过的凭据"）。
    // 它排在 image_awaiting_reading 后面、reading_stale 前面，照表。
    state: 'reading_rejected',
    actor: 'model',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'reading_rejected'),
  },
  {
    state: 'reading_stale',
    actor: 'model',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'reading_stale'),
  },
  {
    state: 'reading_awaiting_confirmation',
    actor: 'user',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'reading_awaiting_confirmation'),
  },
  {
    // 跨任务查重命中：这张发票在另一个还占着它的任务里也在。
    // 停整批，不是停这一张 —— 一批材料里混着一张已经报过的票，整批都要重看。
    state: 'duplicate_blocked',
    actor: 'user',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'duplicate_across_tasks'),
  },
  {
    // 材料这一段全清了。照表，下一件事是划费用事件（判据「无当前版本的事件划分」）；
    // 那一层还没接进 next，所以这里给的是一个 done —— 状态名是表里的真状态，
    // 只是内核暂时带不动它，接上 `run events` 是下一批的事。
    //
    // **它必须一直是最后一条**：新落成的状态一律插在它前面，照表里的先后。
    // 插到它后面就永远轮不上 —— 而轮不上的方式在代码里看不出来。
    state: 'events_pending',
    actor: null,
    when: (o) => taskSeen(o),
  },
];

/**
 * 观测 -> { state, actor, blockedBy }。
 *
 * `blockedBy` 是结构化开放项，每项含 kind / materialId / hint / resolvableBy。
 * 材料这一段的状态一律把**此刻这批材料的全部开放项**原样带上，`blocking`
 * 标出哪些是拦路的：只报拦路的那几条，用户处理完一轮才发现还有下一轮，
 * 而那些不拦路的（扩展名对不上、铁路票面本来就没有税额）也该有人知道。
 */
export function determineState(observation) {
  const o = observation ?? {};
  for (const rule of RULES) {
    if (!rule.when(o)) continue;
    const blocker = rule.blocker?.(o);
    if (blocker) return { state: rule.state, actor: rule.actor, blockedBy: [{ materialId: null, ...blocker }] };
    return {
      state: rule.state,
      actor: rule.actor,
      blockedBy: MATERIAL_STATES.has(rule.state) ? itemsOf(o).map(asBlocker) : [],
    };
  }
  // A 表全过，任务那一侧没观测过。actor 是 null 而不是三种角色之一
  // —— 照表：env_ready 没有人要动手。
  return { state: 'env_ready', actor: null, blockedBy: [] };
}


/** 判定顺序本身是可测的事实，测试直接读它，不靠复述。 */
export const STATE_ORDER = RULES.map((r) => r.state).concat('env_ready');
