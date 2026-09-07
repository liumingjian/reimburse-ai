/**
 * `baox next`：把状态判定的结论翻成模型唯一要做的那一件事。
 *
 * 模型在整个流程里只调两条命令 —— 问（`next --dir`）和答（`next --after`）。
 * 它不选命令、不拼命令、不组织措辞：`step.argv` 是内核给的完整命令行，
 * `speak` 是内核写死的原话。措辞是模型差异最大的地方，所以不交给模型。
 *
 * 落成的是环境七态和材料这一段（盘点、分流、看图读数），用到
 * `run` / `tell_user` / `read_images` / `done` 四种 step；
 * 其余三种（ask_user / confirm_table / dispute）随各自的状态一起来。
 */
import path from 'node:path';
import url from 'node:url';
import { determineState, SCHEMA_VERSION, MIN_NODE_MAJOR } from './state.mjs';
import { currentStep, issueStep } from './steptoken.mjs';
import { readingInboxIn, correctionInboxIn } from './workspace.mjs';
import { SHAPES, SHAPE_LABELS } from './imageshape.mjs';
import { renderTable } from './table.mjs';

/** 内核自己的入口。argv 里给绝对路径：模型原样执行，不需要知道 baox 装在哪。 */
const SRC = path.dirname(url.fileURLToPath(import.meta.url));
const BIN = path.join(path.dirname(SRC), 'bin', 'baox.mjs');
const argvFor = (...args) => [process.execPath, BIN, ...args];

/**
 * 读数模板。它跟着内核走（src/ 整份进分发包），所以装到哪里都指得到 ——
 * 指向 Skill 里某个 references/ 文件的话，换一种安装位置就断了。
 */
const READING_TEMPLATE = path.join(SRC, 'reading-template.json');

const ENV_PROGRESS = { phase: 1, of: 10, label: '环境准备' };
const MATERIAL_PROGRESS = { phase: 2, of: 10, label: '材料盘点与分类' };
const READING_PROGRESS = { phase: 3, of: 10, label: '看图读数' };

// 退出码：0 继续 / 2 有硬阻塞，未解决不得继续。硬阻塞是那些「等下去也不会好」的：
// Node 太老、数据格式太新、登错了人。停在登录页不是硬阻塞 —— 那是在等人，不是被拦住。
const BLOCKED = 2;

// 每种 step.kind 一个构造函数。它们存在的意义是把「这一步长什么样」收在一处：
// 剩下四种（read_images / ask_user / confirm_table / dispute）随各自的状态一起加进来，
// 加的时候只动这里，不动 stepFor 里那张状态表。
/**
 * 跑一条内核给的命令。
 *
 * `outsourceable` 是给子 Agent 那条规矩用的：契约说 `kind: "run"` 的连续段可以外包，
 * 但有两步的命令会弹出一个要人**亲手点一下**的本地页面（认身份、认读数）——
 * 外包给一个没有终端的子 Agent，它只会挂在那里等一个永远不会发生的点击。
 * 所以这一条写进 JSON 里，而不是只写在注释里：模型看得见的才算数。
 */
const run = (argv, { speak, context, progress = ENV_PROGRESS, outsourceable = true }) =>
  ({ step: { kind: 'run', argv, outsourceable }, speak, context, progress, exit: 0 });

const tellUser = ({ speak, context, progress = ENV_PROGRESS, exit = 0 }) =>
  ({ step: { kind: 'tell_user' }, speak, context, progress, exit });

const done = ({ speak, context, progress = ENV_PROGRESS }) =>
  ({ step: { kind: 'done' }, speak, context, progress, exit: 0 });

/**
 * 看图读数。模型逐个用 Read 打开 `images[].absPath`，按 `schemaPath` 那份模板
 * 把读数写进 `readingsPath`，再原样执行 `argv` 交上来。
 *
 * `readingsPath` 就是 `argv` 里 `--file` 指的那个文件，写两遍是给模型看的，
 * 不是多一个自由度：路径由内核定，模型不选地方。
 */
const readImages = ({ images, readingsPath, argv, speak, context }) => ({
  step: {
    kind: 'read_images',
    images: images.map(({ materialId, fileName, absPath, format, contentHash, rejection }) =>
      ({ materialId, fileName, absPath, format, contentHash,
        // 上一次为什么没过。带着它重读，才不是把同一遍再走一次。
        ...(rejection ? { previousRejection: rejection.reasons } : {}) })),
    schemaPath: READING_TEMPLATE,
    readingsPath,
    // 「看过的凭据」的取值范围，跟着这一步一起给 —— 模型不需要去别处查它。
    sightedShapes: SHAPES.map((shape) => ({ shape, label: SHAPE_LABELS[shape] })),
    argv,
  },
  speak, context, progress: READING_PROGRESS, exit: 0,
});

/**
 * 请用户过目一张内核渲染好的定宽表格。
 *
 * `table` 是**一整块渲染好的文本**，模型原样贴出来，一个字都不重排 ——
 * 表格是用户做判断用的界面，不是让模型转述的素材。
 *
 * 认可走 `--after <token>`（不带别的）；指错把改动写进 `correctionPath`
 * 再带 `--correction <文件>` 回来。用户不表态就一直停在这里：这一步的 actor 是人，
 * 模型替他点头是这条链子上最容易破的地方，所以凭据只有一次、且只对这一张表有效。
 */
const confirmTable = ({ table, materialIds, correctionPath, speak, context }) => ({
  step: {
    kind: 'confirm_table',
    table,
    materialIds,
    correctionPath,
    correctionFormat: {
      corrections: [{ materialId: '表里那一行的 materialId', fields: { invoiceNumber: '用户说的值' } }],
      note: '只写用户当面改的那几个字段，其余不要抄。用户的值不会被直接落库 —— '
        + '内核会把这张读数作废，带着分歧重新看图。',
    },
    // 终端表态和终端多选一样，在子 Agent 里做不了：那里没有用户。
    outsourceable: false,
  },
  speak, context, progress: READING_PROGRESS, exit: 0,
});

/**
 * 待确认读数 -> 一张定宽表格。
 *
 * 一行一个字段，不是一行一份材料：用户要做的事是**在一串数字里挑出不对的那一个**，
 * 而挤在一格里的五个字段没法一眼比对。看不清的字段也单独占一行 ——
 * 它是一个需要用户知道的结果，不是一处留白。
 */
function readingTable(pending) {
  const rows = [];
  for (const p of pending) {
    let first = true;
    const nameCell = () => (first ? (first = false, `${p.fileName}（${p.docTypeLabel}）`) : '');
    for (const f of p.fields) rows.push({ material: nameCell(), field: f.label, value: f.value });
    for (const u of p.unreadable) rows.push({ material: nameCell(), field: u, value: '看不清（我没有猜）' });
    if (first) rows.push({ material: nameCell(), field: '（没有读出任何字段）', value: '' });
  }
  return renderTable([
    { key: 'material', label: '材料', max: 46 },
    { key: 'field', label: '字段', max: 16 },
    { key: 'value', label: '我读到的', max: 32 },
  ], rows);
}

/** 待办清单念给用户听的样子。谁能解决它，是每条最要紧的那半句。 */
const WHO = { user: '要你处理', model: '我来处理', kernel: '内核已经自己处置了，说一声而已' };
const itemLines = (items) => items
  .map((b, n) => `${n + 1}. ${b.fileName ?? b.materialIds?.join('、') ?? '这批材料'}`
    + `——${b.hint ?? b.kind}（${WHO[b.resolvableBy] ?? WHO.user}）`)
  .join('\n');

/** 收得下 `--correction` 的 step。现在一种都没有 —— 它们随批次 4 的读数确认一起来。 */
const CORRECTABLE = new Set(['confirm_table']);

/** 交得出结果的 step。这两种都以"跑完一条命令"收尾，没有输出就是没跑过。 */
const NEEDS_RESULT = new Set(['run', 'read_images']);

/**
 * 状态 -> step + 原话。纯函数：同一个状态加同一份观测，永远得到同一句话。
 *
 * `blockedBy` 是判定那一侧算好的开放项，材料这一段要按它逐条说话。
 */
export function stepFor(state, observation = {}, blockedBy = []) {
  const o = observation;
  const who = o.probe?.identity?.displayName ?? o.probe?.identity?.account ?? null;
  const bound = o.binding?.displayName ?? o.binding?.account ?? null;
  const label = o.task?.sourceLabel ?? '这批材料';
  const readingsPath = o.task ? readingInboxIn(o.task.workspace) : null;
  const correctionPath = o.task ? correctionInboxIn(o.task.workspace) : null;
  const submitArgv = () => argvFor('ocr-submit', '--dir', o.sourceDir, '--file', readingsPath);
  // 要看的那几张图，和念给用户听的那串文件名。两个 case 用的是同一份。
  const images = o.pendingImages ?? [];
  const imageNames = images.map((i) => i.fileName).join('、');

  switch (state) {
    case 'schema_too_new':
      return tellUser({
        speak: '这台机器上的报销数据是更新版本的 baox 写的，我这一版读不了，'
          + '硬来只会把数据弄坏。请先把 baox 升到新版，我们再继续。',
        context: `数据目录里记的格式版本是 ${o.schemaVersion}，这个内核只认到 ${SCHEMA_VERSION}。`
          + '版本闸看的是数据格式，不是代码版本号。',
        progress: null,
        exit: BLOCKED,
      });

    case 'env_node_unsupported':
      return tellUser({
        speak: `你这台机器上的 Node 是 ${o.nodeVersion ?? o.nodeMajor}，baox 需要 ${MIN_NODE_MAJOR} 或更高。`
          + '装好新版 Node 之后跟我说一声，我接着往下走。',
        context: '内核用 Node 内建的全局 WebSocket 和 Chrome 通信，21 以下的 Node 没有这个东西。',
        exit: BLOCKED,
      });

    case 'env_chrome_down':
      return run(argvFor('chrome-up'), {
        speak: '我先把 baox 专用的 Chrome 打开。它有自己独立的 profile，'
          + '和你平时用的那个 Chrome 互不影响，也不会碰你日常的浏览记录。',
        context: '专用 Chrome 上开着一个只在本机回环地址上监听的调试端口，'
          + '它只指向 baox 自己的 profile，绝不指向你日常的 Chrome。',
      });

    case 'env_not_logged_in':
      return tellUser({
        speak: '请你在刚打开的那个 baox 专用 Chrome 窗口里，用你本人的账号登录 ERP。'
          + '我不会替你填账号密码。登进主界面之后告诉我一声，我接着往下走。',
        context: 'ERP 的登录页和主控制台是同一个网址，所以我按页面上有没有登录表单来判断。'
          + '另外登录页上也读得出你上次登录的账号，那不算已登录。',
      });

    case 'env_identity_unknown':
      return tellUser({
        speak: '我读不出那个专用 Chrome 窗口里现在是谁登录着。麻烦你看一眼这个窗口：'
          + '停在登录页就登录一下，页面卡着就刷新一下，弄好了告诉我。'
          + '身份读不确定我就不往下走 —— 报销主体错了是不可撤销的。',
        context: '探针只读页面上已有的信息，不导航、不点击。现在的情况是页面加载没完成、'
          + '或者读不出用户名又看不见登录表单、或者读出了人却缺账号或账套凑不成可比的身份。',
      });

    case 'env_identity_unbound':
      // 绑定只在确认页上产生：页面展示的是内核自己从 ERP 读到的值，
      // 用户点一次「是我本人」才落盘 —— 全程没有字符串经过模型的手。
      //
      // 规格那一格写的是「会话内列表格请用户认」，也就是 confirm_table。
      // 那种 step 连同终端表格属于后面的批次，这一批先接上已有的本地确认页；
      // 它是 run，但**这一步要人点一下，不能外包给子 Agent**。换成 confirm_table
      // 是批次 5 的活。
      return run(argvFor('confirm-identity'), {
        outsourceable: false,
        speak: '这台机器还没记下我在替谁报销。我这就打开一个本地确认页，'
          + `上面是我刚从 ERP 读到的身份${who ? `（${who}）` : ''}，`
          + '你核对一下，是本人就点「是我本人」。只有那一次点击算数。',
        context: '绑定判据是登录账号加账套，不含显示名 —— 显示名在 ERP 里改得动，'
          + '拿它当门栓等于把门栓拴在别人能拧的东西上。',
      });

    case 'env_identity_mismatched':
      return tellUser({
        speak: `这台机器绑定的是 ${bound}，但 ERP 现在登录的是 ${who}。`
          + 'baox 只替绑定的那个人报销，请在专用 Chrome 里换回本人的账号登录。'
          + '确实要把这台机器改绑到当前这个身份，得先把手上的任务走完或作废。',
        context: '判据是登录账号加账套。换账套等于换一整套主数据，也算换了人。'
          + '中途换人会把一份报销记在两个人头上，所以这里是硬阻塞。',
        exit: BLOCKED,
      });

    // —— 材料这一段 ——

    case 'task_none':
      return run(argvFor('intake', '--dir', o.sourceDir), {
        speak: '我先把这个目录里的材料整个盘一遍：有几份、每份是什么格式、哪些读不出来。'
          + '盘点只读你的目录，不改名、不移动、不删东西。',
        context: '盘点会给这批材料建一个报销任务，并按"每份材料的路径 + 内容哈希 + 大小"'
          + '算出一个版本号。后面每一步都挂在这个版本上，材料一动版本就变。',
        progress: MATERIAL_PROGRESS,
      });

    case 'inventory_stale':
      return run(argvFor('intake', '--dir', o.sourceDir), {
        speak: `${label} 这个目录和我上次盘的对不上了 —— 多了、少了或者换过文件。`
          + '我重新盘一遍再往下走，免得后面按着一份过期的清单做事。',
        context: '这是内核自己比出来的：每次问"下一步做什么"都重新走一遍目录、重算内容哈希，'
          + '和任务上记的版本号一比就知道。不靠谁记得说一声。',
        progress: MATERIAL_PROGRESS,
      });

    case 'intake_open_items':
      return tellUser({
        speak: `${label} 这批材料里有几件事得先说清楚，处理完我们再往下：\n`
          + `${itemLines(blockedBy.filter((b) => b.blocking))}\n`
          + '处理好了跟我说一声，我重新盘一遍。',
        context: '这些是盘点和解析报上来的开放项。我不会替你把它们当作不存在 ——'
          + '带着读不出、认不出的材料往下走，等于把问题推到 ERP 那一头去暴露。'
          + (blockedBy.some((b) => !b.blocking)
            ? '另外还有几条不拦路的，一并记在 blockedBy 里。'
            : ''),
        progress: MATERIAL_PROGRESS,
      });

    case 'classify_pending':
      return run(argvFor('classify', '--dir', o.sourceDir), {
        speak: '材料盘清楚了，接下来我把每一份分个类：哪些是报销凭证、哪些是参考材料，'
          + '能从 PDF 里直接取到的票面信息我一并取出来。',
        context: '分类结果挂在当前这个盘点版本上，落进任务工作区。材料一变，'
          + '这一版分类就不再代表现在的材料，得重来。',
        progress: MATERIAL_PROGRESS,
      });

    case 'image_awaiting_reading':
      return readImages({
        images,
        readingsPath,
        argv: submitArgv(),
        speak: `${label} 里有 ${images.length} 张图要我亲眼看一遍才读得出票面信息：${imageNames}。`
          + '我逐张打开抄写，看不清的字段我会说看不清，不猜也不算。',
        context: '内核没有 OCR，图片由我来读；但读不等于算数：读数要过内核的结构校验'
          + '（位数、日期、金额守恒），过了也只是候选，还得你对着原图确认。'
          + '每份读数还要带一句只有真打开过才答得上的话（这张图是什么形状），'
          + '答不上整份读数就不算数 —— 没看图就说图片读不了，这条路是走不通的。'
          + '每份读数都钉在这张图当前的字节上，图一换读数自动作废。',
      });

    case 'reading_rejected': {
      // 驳回的处置永远是**重读**，不是把数字改到过关。守恒式不平是一个正常结果：
      // 要么再看一遍看清楚，要么老实说这个字段读不出来 —— 内核不接受第三种收场。
      const why = images.flatMap((i) => (i.rejection?.reasons ?? []).map((r) => `${i.fileName}：${r}`));
      return readImages({
        images,
        readingsPath,
        argv: submitArgv(),
        speak: '上一次读数没过内核这一关，我重新看一遍这几张图：\n'
          + `${why.map((w, n) => `${n + 1}. ${w}`).join('\n')}`,
        context: '过不了就重读，或者老实说这个字段读不出来 —— 我不会去调整某一位数字把式子凑平。'
          + '凑平的那个数字看起来最像对的，实际上是这条链子上唯一一个没有来源的值。',
      });
    }

    case 'reading_stale':
      return readImages({
        images,
        readingsPath,
        argv: submitArgv(),
        speak: `${imageNames} 换过了，`
          + '之前那次读数是对着旧图读的，已经作废。我重新看一遍这几张图。',
        context: '读数钉在内容哈希上。文件一改，旧读数当场失效 ——'
          + '沿用它等于拿上一张图的数字去报这一张图。',
      });

    case 'reading_awaiting_confirmation': {
      const pending = o.pendingReadings ?? [];
      return confirmTable({
        table: readingTable(pending),
        materialIds: pending.map((p) => p.materialId),
        correctionPath,
        speak: `图我读完了。下面是我从${pending.length > 1 ? `这 ${pending.length} 张` : '这张'}图上逐字抄下来的，`
          + '读数还只是候选，得你对着原件过一眼才算数。'
          + '哪一项对不上就直接说是哪一项、正确的值是什么，我不会拿你说的值直接落库，'
          + '而是带着这个分歧重新看一遍那张图。',
        context: '确认只来自你在这里的表态。你在别处说过的"对的""没问题"我一概不当作确认 ——'
          + '那些话我传得进来，但内核看不见它们，也就没法把它们变成事实。'
          + '全程不需要你打开任何网页。',
      });
    }

    case 'duplicate_blocked': {
      const hits = blockedBy.filter((b) => b.kind === 'duplicate_across_tasks');
      return tellUser({
        speak: `停一下 —— ${label} 里有发票在另一个报销任务里也在，同一张发票不能报两次：\n`
          + `${itemLines(hits)}\n`
          + '要么把这几份从本次材料里移出去，要么确认那个任务确实不报了。你定了告诉我。',
        context: '这是拿发票身份（不是文件内容）跨任务比出来的：两个字节不同的 PDF '
          + '只要是同一张法定发票，照样算重复。命中就停整批 —— 一批材料里混着一张报过的票，'
          + '整批都得重看，而不是把那一张挑出去了事。'
          + '另外这只比对得了 baox 在本机记过的任务，直接在 ERP 里录过的查不到。',
        progress: MATERIAL_PROGRESS,
      });
    }

    case 'events_pending':
      return done({
        speak: `${label} 的材料这一段清完了：盘点、分类、看图读数、确认都过了。`
          + '再往下的费用事件、选项目、和 ERP 核对还没接进这条命令，这一版到这里为止。',
        context: '照状态表，下一步是划费用事件（`events`）。它连同它自己的观测一起接进来，'
          + '否则这个状态永远成立，那条命令会被反复重跑。',
        progress: MATERIAL_PROGRESS,
      });

    case 'env_ready':
      return done({
        speak: `环境准备好了：专用 Chrome 开着，ERP 登录着${who ? `，当前替 ${who} 报销` : ''}。`
          + '接下来就可以开始处理报销材料了。',
        context: '这一步之后不需要你再打开任何浏览器页面，除非要改绑身份或者浏览项目目录。',
      });

    default:
      // 状态落成了却没给它写 step，是内核自己的 bug，不能装作没看见。
      throw new Error(`状态 ${state} 还没有对应的 step`);
  }
}

/**
 * 一次 `next` 的完整应答：观测 -> 状态 -> step，中间过一道凭据核对。
 *
 * 状态永远来自**这一次的观测**，不来自模型的自述：模型说「做完了」不推进状态，
 * 推进的依据是内核自己看得见的事实。所以 `--result` 在这里不被解读，
 * 它只是「你确实跑了那条命令」的凭证。
 */
export function nextResponse({ observation, sourceKey, after = null, hasResult = false,
  hasCorrection = false }) {
  const verdict = determineState(observation);
  const shaped = stepFor(verdict.state, observation, verdict.blockedBy);

  // 凭据核对。几种「不算数」的回传，处置完全一样：忽略回传，重发当前步骤。
  // 这里记一句 `ignored` 是为了留痕，不是训模型：一次看不出自己被忽略过的回传，
  // 排障时比没有记录更糟。
  let ignored = null;
  if (after !== null) {
    const outstanding = currentStep(sourceKey);
    if (!outstanding || outstanding.token !== after) {
      ignored = { reason: 'stale_token',
        note: '这个凭据不是我现在挂着的那一个（多半是上一步的），我按当前状态重发一次' };
    } else if (outstanding.state === verdict.state && NEEDS_RESULT.has(shaped.step.kind) && !hasResult) {
      // 状态和上一步一样，却没交结果。状态不动 —— 说做完了不算做完了。
      ignored = { reason: 'no_result',
        note: '这一步要的是命令的实际输出，没有输出就没有事实，状态不动' };
    }
    // 状态已经往前走的情况不记：那个凭据自然作废，不是错，就是这一步过去了。
  }
  if (hasCorrection && !CORRECTABLE.has(shaped.step.kind)) {
    // 纠正只在请用户过目的那种步骤上说得通。收下一份没处安放的纠正而不吭声，
    // 会让用户以为自己的改动被采纳了。
    ignored = { reason: 'correction_not_applicable',
      note: `现在这一步（${shaped.step.kind}）没有可纠正的读数，这份纠正我没有采纳` };
  }

  const record = issueStep(sourceKey, verdict.state, observation.sourceDir ?? null);
  const identity = observation.probe?.status === 'matched'
    ? { displayName: observation.probe.identity.displayName ?? null,
        account: observation.probe.identity.account ?? null }
    : (observation.binding
      ? { displayName: observation.binding.displayName ?? null, account: observation.binding.account ?? null }
      : null);

  return {
    command: 'next',
    schemaVersion: SCHEMA_VERSION,
    identity,
    // 任务还没建立（或者只采了环境观测）时就是 null —— 不给一个看起来像任务的空壳。
    task: observation.task
      ? { taskId: observation.task.taskId, sourceLabel: observation.task.sourceLabel,
          sourceDir: observation.sourceDir ?? null }
      : null,
    state: verdict.state,
    progress: shaped.progress,
    actor: verdict.actor,
    stepToken: record.token,
    step: shaped.step,
    speak: shaped.speak,
    context: shaped.context,
    blockedBy: verdict.blockedBy,
    ...(ignored ? { ignored } : {}),
    exit: shaped.exit,
  };
}
