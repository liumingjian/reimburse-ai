/**
 * 状态判定：**纯函数**。入参是一个已经采集好的观测对象，
 * 不读文件、不发请求、不碰浏览器（采集在 observe.mjs 里）。
 *
 * 分层是硬要求，不是风格：状态判定的测试要能在一台没有 Chrome、
 * 没有材料目录、没登录过 ERP 的机器上跑完。判断被钉住了，取数才谈得上可换。
 *
 * 判据一字不改地照 docs/design/state-machine.md 的两张表：A 表（环境七态）、
 * 永远排在最前的 schema_too_new，以及 B 表从任务建立一路到写入前确认。
 *
 * `archived` 不在这里，因为它根本不是状态：它是 0.9.x 在途任务迁移时打的**任务状态**
 * （见 workspace.mjs 的 archiveMigratedTasks），存档任务不被认领，也就永远不产生动作。
 * 状态机回答的是"现在该做什么"，一个永远答不出动作的东西留在表里只会骗人。
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
  // 争议收不了场：用户对着原件也认不出，或者守恒式的缺口补不上。
  // 整条读数已经退回待办，解法只有一个，而且只有人做得到 —— 换一份看得清的原件。
  reading_unreadable: 'user',
  // 跨任务查重
  duplicate_across_tasks: 'user',
  history_scope_local: 'kernel',
  // 事件层：证据不够，或者拆不出来。
  evidence_ambiguous: 'user',
  reference_unlinked: 'user',
  event_date_missing: 'user',
  event_amount_missing: 'user',
  no_expense_event: 'user',
  allocation_amounts_incomplete: 'user',
  // 用户明说过这张合并发票的逐段金额他认不出。这是一个正当的结局，
  // 但它拦路：解法在材料那一侧（补一份逐段行程单，或者把票挪走）。
  allocation_given_up: 'user',
  // 选择层：费用类别推不出来。它不是选择题 —— 同一张票同一个常驻城市，
  // 结论必须每次都一样，所以它只会被材料解开，不会被"再选一次"解开。
  category_undecidable: 'user',
  category_city_missing: 'user',
  expense_item_unverified: 'user',
  expense_item_unconfirmed: 'kernel',
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
  // 用户给的值和机器读数对不上。actor 是模型：它要摆证据链，
  // 并派一个干净上下文的子 Agent 只重读那一个字段。**判定权仍然在用户手上** ——
  // 模型在这一步做的全部是把三方的说法摆齐，一个值都不由它定。
  reading_disputed: 'model',
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
  'reading_stale', 'reading_awaiting_confirmation', 'reading_disputed', 'duplicate_blocked',
  'events_pending']);

/** ERP 这半段观测采过没有。没采过就只答得了材料那一段（见 observe.mjs 的 settled）。 */
const erpSeen = (o) => taskSeen(o) && !!o.events;

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
    // 用户的纠正和机器读数不同。它排在「等你过目」后面：手上还有别的读数没过目时，
    // 先把那张表问完 —— 一次只让用户面对一件事。
    //
    // 它**不是** reading_rejected 的一种：驳回的处置是重读整张票，
    // 争议的处置是只重读争的那一个字段，而且必须在干净上下文里读。
    state: 'reading_disputed',
    actor: 'model',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'reading_disputed'),
  },
  {
    // 跨任务查重命中：这张发票在另一个还占着它的任务里也在。
    // 停整批，不是停这一张 —— 一批材料里混着一张已经报过的票，整批都要重看。
    state: 'duplicate_blocked',
    actor: 'user',
    when: (o) => taskSeen(o) && hasBlockingItem(o, (i) => i.kind === 'duplicate_across_tasks'),
  },
  {
    // 材料这一段全清了，该划费用事件。判据是表里那句「无当前版本的事件划分」——
    // 看的是**落盘的账本**，不是现算的结果：现算永远算得出来，拿现算的判，
    // 这个状态就永远不成立，账本上永远缺这一版。
    //
    // 账本还要对得上现在这批明细：用户补了一次分摊，明细从一行变成三行，
    // 盘点版本一动不动，而账本记的还是那一行。
    state: 'events_pending',
    actor: 'kernel',
    when: (o) => taskSeen(o) && !o.eventsRecorded,
  },
  {
    // 合并交通发票，且各段之和 ≠ 价税合计。**相等时内核自动定案，根本不进这个状态**
    // —— 那不是分摊，是核对，判据在 events.mjs 的 conservingSegments 里。
    state: 'allocation_required',
    actor: 'user',
    when: (o) => erpSeen(o) && !!o.allocationRound && !o.allocationRound.stale,
    blocker: (o) => ({ kind: 'allocation_required', resolvableBy: 'user',
      materialId: o.allocationRound.materialId, fileName: o.allocationRound.fileName,
      hint: `${o.allocationRound.fileName} 要拆成 ${o.allocationRound.segmentCount} 段，`
        + `票面价税合计 ${o.allocationRound.totalAmount} 元，逐段金额要你给` }),
  },
  {
    // 发票或盘点变过，之前那次分摊作废重来。和上一条是同一个问法，
    // 但状态名不同 —— 用户有权知道这次问他不是因为他没答过，是因为材料动了。
    state: 'allocation_stale',
    actor: 'user',
    when: (o) => erpSeen(o) && !!o.allocationRound && o.allocationRound.stale,
    blocker: (o) => ({ kind: 'allocation_stale', resolvableBy: 'user',
      materialId: o.allocationRound.materialId, fileName: o.allocationRound.fileName,
      hint: `${o.allocationRound.fileName} 变过了，上次的逐段金额已经作废，要重新给` }),
  },
  {
    // 有事件没有项目号。**按事件用终端多选问**是表里写的下一步，但那个问法
    // 还在原型上定（几十张发票配三五个项目，怎么问才不折磨人），所以这一版
    // 只做到「如实报出来，把状态摆在那里」—— 见本状态在 next.mjs 里的那一步。
    //
    // 因此 actor 是 `user` 而不是表里写的 `model`：表里那个 `model` 说的是
    // "模型用终端多选去问"，而这一版根本没有那一问。报 `model` 等于说
    // "模型该动手了"，却又不给它任何一件能做的事。问法落成的那一票把它改回 `model`。
    state: 'project_unassigned',
    actor: 'user',
    when: (o) => erpSeen(o) && (!o.selectionApplied || (o.lines ?? []).some((l) => !l.project)),
    blocker: (o) => (o.selectionApplied
      ? (o.lines ?? []).filter((l) => !l.project).map((l) => ({
          kind: 'project_unassigned', resolvableBy: 'user', lineId: l.lineId,
          materialId: l.voucherMaterialId,
          hint: `明细 ${l.lineId}（${l.date ?? '日期未取到'} ${l.totalAmount} 元）还没有项目号` }))
      : [{ kind: 'project_unassigned', resolvableBy: 'user',
          hint: `这批材料划出 ${(o.lines ?? []).length} 条明细，一条都还没有项目号；`
            + '项目归属材料上没有，也不能由系统推断' }]),
  },
  {
    // 项目和费用项目还没在 ERP 里只读核对过。核对记录钉在这批明细上，
    // 过期的记录等于没核对过 —— 不是"上次是好的"。
    state: 'catalog_unverified',
    actor: 'kernel',
    when: (o) => erpSeen(o) && !o.catalogFresh,
  },
  {
    // ERP 里查无此项目 / 对不上。硬停：拿一个 ERP 里不存在的项目号往下走，
    // 错误只会在保存那一刻暴露，而那时候单据已经建出来了。
    state: 'catalog_mismatch',
    actor: 'user',
    when: (o) => erpSeen(o) && o.catalogFresh && (o.catalogProblems ?? []).length > 0,
    blocker: (o) => o.catalogProblems.map((p) => ({ kind: 'catalog_mismatch', resolvableBy: 'user',
      number: p.number ?? p.code ?? null, verdict: p.verdict ?? null, hint: p.note ?? null })),
  },
  {
    // 动过 ERP 的任务不在这里收场。表里它排在 ready_for_erp_write 后面，
    // 但判定要在**前面**分岔：一份已经发出去的写入不能再要一次点头 ——
    // 那次点头会看起来像是"同意再写一遍"。所以 ready_for_erp_write 自己
    // 把「还没动过 ERP」写进判据，两条互斥，表里的先后就不重要了。
    state: 'ready_for_erp_write',
    actor: 'user',
    when: (o) => erpSeen(o) && !o.task?.erpWriteState,
  },
  {
    state: 'handed_off_recover',
    actor: null,
    when: (o) => erpSeen(o) && !!o.task?.erpWriteState,
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
    if (blocker) {
      // 一条规则可以报好几件事（比如三行明细各缺一个项目号）。摊成数组，
      // 而不是把它们挤进一句话里 —— blockedBy 是结构化的，读它的不只有人。
      const many = Array.isArray(blocker) ? blocker : [blocker];
      return { state: rule.state, actor: rule.actor,
        blockedBy: many.map((b) => ({ materialId: null, ...b })) };
    }
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
