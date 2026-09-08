/**
 * `baox next`：把状态判定的结论翻成模型唯一要做的那一件事。
 *
 * 模型在整个流程里只调两条命令 —— 问（`next --dir`）和答（`next --after`）。
 * 它不选命令、不拼命令、不组织措辞：`step.argv` 是内核给的完整命令行，
 * `speak` 是内核写死的原话。措辞是模型差异最大的地方，所以不交给模型。
 *
 * 落成的是两张表的全部状态（`archived` 是任务状态不是状态，见 state.mjs 的开头），
 * 七种 `step.kind` 全部用上了 —— `ask_user` 的第一次真实使用是逐段分摊，
 * `handoff` 是把动过 ERP 的任务交给 baox-recover。
 */
import path from 'node:path';
import url from 'node:url';
import { determineState, SCHEMA_VERSION, MIN_NODE_MAJOR } from './state.mjs';
import { currentStep, issueStep } from './steptoken.mjs';
import { readingInboxIn, correctionInboxIn, rereadInboxIn, answerInboxIn } from './workspace.mjs';
import { CONVERGENCE, favorsUser, disputeStepKey, DISPUTE_PHASES } from './dispute.mjs';
import { SHAPES, SHAPE_LABELS } from './imageshape.mjs';
import { DOC_TYPES, FIELD_RULES, SEGMENT_RULES } from './vision.mjs';
import { writePreviewDigest } from './erpwrite.mjs';
import { roundFingerprint } from './allocate.mjs';
import { renderTable, renderQuestions } from './table.mjs';

/** 内核自己的入口。argv 里给绝对路径：模型原样执行，不需要知道 baox 装在哪。 */
const SRC = path.dirname(url.fileURLToPath(import.meta.url));
const BIN = path.join(path.dirname(SRC), 'bin', 'baox.mjs');
const argvFor = (...args) => [process.execPath, BIN, ...args];

/**
 * 读数模板。它跟着内核走（src/ 整份进分发包），所以装到哪里都指得到 ——
 * 指向 Skill 里某个 references/ 文件的话，换一种安装位置就断了。
 */
const READING_TEMPLATE = path.join(SRC, 'reading-template.json');
const REREAD_TEMPLATE = path.join(SRC, 'reread-template.json');

const SIGHTED_SHAPES = Object.freeze(
  SHAPES.map((shape) => Object.freeze({ shape, label: SHAPE_LABELS[shape] })));
const ALLOWED_READING_FIELDS = Object.freeze(Object.keys(FIELD_RULES));
const READING_CONTRACT = Object.freeze({
  docTypes: Object.fromEntries(Object.keys(DOC_TYPES).map((docType) => [docType, Object.freeze({
    allowedFields: ALLOWED_READING_FIELDS,
    requiredFields: docType === 'invoice' ? Object.freeze(['invoiceNumber', 'totalAmount']) : Object.freeze([]),
    ...(docType === 'ride_itinerary' ? { segments: Object.freeze({
      type: 'array',
      minItems: 1,
      additionalFields: false,
      fields: Object.fromEntries(Object.entries(SEGMENT_RULES).map(([field, rule]) => [field, Object.freeze({
        required: rule.required,
        format: rule.hint,
      })])),
    }) } : {}),
  })])),
  fieldFormats: Object.fromEntries(
    Object.entries(FIELD_RULES).map(([field, rule]) => [field, rule.hint])),
  additionalFields: false,
  minimumFields: 1,
  omitMissingFields: true,
  amountConservation: Object.freeze({
    whenPresent: Object.freeze(['netAmount', 'taxAmount', 'totalAmount']),
    rule: 'netAmount + taxAmount = totalAmount，按分精确相等；不相等就重读，禁止改数凑平。',
  }),
  multipleTrips: '多段行程按 ride_itinerary.segments 逐段填写；只抄票面可见值，不推断、不合并。',
});

const ENV_PROGRESS = { phase: 1, of: 10, label: '环境准备' };
const MATERIAL_PROGRESS = { phase: 2, of: 10, label: '材料盘点与分类' };
const READING_PROGRESS = { phase: 3, of: 10, label: '看图读数' };
const EVENT_PROGRESS = { phase: 4, of: 10, label: '划分费用事件' };
const PROJECT_PROGRESS = { phase: 5, of: 10, label: '项目归属' };
const CATALOG_PROGRESS = { phase: 6, of: 10, label: '与 ERP 核对' };
const WRITE_PROGRESS = { phase: 7, of: 10, label: '写入前确认' };

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
 * 但有的命令会弹出一个要人**亲手点一下**的本地页面（改绑身份、浏览项目目录）——
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
    // 环境准备子 Agent 到这里必须停：视觉材料由主会话亲眼读取。
    outsourceable: false,
    images: images.map(({ materialId, fileName, absPath, format, contentHash, rejection }) =>
      ({ materialId, fileName, absPath, format, contentHash,
        // 上一次为什么没过。带着它重读，才不是把同一遍再走一次。
        ...(rejection ? { previousRejection: rejection.reasons } : {}) })),
    schemaPath: READING_TEMPLATE,
    // 与实际校验共用 vision.mjs 的闭集；提交前就能检查，不需要反查内核源码。
    readingContract: READING_CONTRACT,
    readingsPath,
    // 「看过的凭据」的取值范围，跟着这一步一起给 —— 模型不需要去别处查它。
    sightedShapes: SIGHTED_SHAPES,
    // 这两条写进内核的输出里，而不是只躺在参考文档里：模型看得见的才算数。
    // 真机 QA 里模型跑去敲 tesseract / mdls / swift Vision，正是因为"只能自己看"
    // 这句话当时只写在 references/ 那份文件里。
    onlyYourOwnEyes: '识图只能用 Read 打开图片、你自己看。file / mdls / sips / identify / '
      + 'tesseract / macOS Vision / easyocr / paddleocr 这类外部工具读出来的东西内核不收，'
      + '拿它们凑 sighted.shape 更是这一步最坏的做法。',
    ifYouCannotSeeImages: '如果 Read 交回了图片而你看不到它的内容（比如你没有视觉能力），'
      + '就把这件事照实说出来然后停下 —— 不要改用外部工具，不要按文件名和尺寸推断，'
      + '也不要把整份读数填成 unreadable 交上来：一个字段都没有的读数我会当场打回，'
      + '连着两次就转成一条给用户的待办（换个看得见图的模型，或者换成 PDF 原件）。',
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
    acceptsCorrection: true,
    correctionFormat: {
      corrections: [{ materialId: '表里那一行的 materialId', fields: { invoiceNumber: '用户说的值' } }],
      note: '只写用户当面改的那几个字段，其余不要抄。用户的值不会被直接落库 —— '
        + '内核会把这张读数作废，带着分歧重新看图。',
    },
    // 终端表态和对话提问一样，在子 Agent 里做不了：那里没有用户。
    outsourceable: false,
  },
  speak, context, progress: READING_PROGRESS, exit: 0,
});

/**
 * 在对话里问用户。契约给的形状是硬的：至多四题，每题二到四个选项，**末项恒为「其他」
 * 可自由输入**。这三条不是排版建议 ——
 *
 *  - 四题是一屏能让人**核对**（不是照着点）的上限；
 *  - 两个选项是"这确实是个选择"的下限；
 *  - 末项永远留一个自由输入口，是因为内核列得出来的选项，永远只是它知道的那些。
 *    没有这个口子，用户唯一能做的就是从几个都不对的答案里挑一个。
 *
 * 问题**由内核渲染成一整块文本**（`step.prompt`），模型原样贴出去，就跟 `confirm_table`
 * 贴表格一样。不走任何提问工具：用户可以把那种工具关掉，别的 Agent 也未必有，
 * 而「在对话里问一句」是哪里都有的。`questions` 仍然带着，模型誊答案时要用里面的 `id`。
 *
 * 答案回传的是文件（`--after <token> --result <答案json>`），不是一条命令的输出
 * —— 这一步的另一头是人，没有 stdout 可交。`outsourceable: false`：
 * 子 Agent 那里没有用户，问了也没人答。
 */
const askUser = ({ questions, answersPath, answersFormat, speak, context, progress }) => ({
  step: {
    kind: 'ask_user',
    questions,
    // 内核渲染好的那一块，原样贴进对话。措辞和选项不交给模型组织。
    prompt: renderQuestions(questions),
    answersPath,
    answersFormat,
    outsourceable: false,
  },
  speak, context, progress, exit: 0,
  // 凭据钉在**问出去的这几题**上。同一个状态里换了一批题（上一轮答完了、
  // 或者草稿作废重来），旧凭据当场失效 —— 否则上一轮的答案会落到这一轮的段上。
  stepMeta: { questions: roundFingerprint(questions) },
});

/** 状态变了，这件事该换一个 skill 接手。不回传 —— 交接完这条链子就断在这里。 */
const handoff = ({ skill, speak, context, progress }) => ({
  step: { kind: 'handoff', skill, outsourceable: false },
  speak, context, progress, exit: 0,
});

/**
 * 争议。用户给的值和机器读数对不上，两边都可能错，所以内核**一个值都不选**。
 *
 * 这一步的 `speak` 分三段落成，全部写死在下面：摆证据（phase `reread`）、
 * 摆收敛结果请用户拍板（phase `ruling`）、摆守恒缺口（phase `conservation_gap`）。
 * 措辞不交给模型 —— 在一场"谁读错了"的对话里，措辞就是判断本身。
 *
 * `outsourceable: false`：和用户对话的这一半在子 Agent 里做不了，那里没有用户。
 * 但 `step.subagent` 说的是**另一件事**：重读那一个字段**必须**外包给一个
 * 干净上下文的子 Agent。要的就是它不知道我们刚才争过什么 —— 带着这段上下文重读，
 * 第二次读数只是第一次的回声，它印证不了任何东西。
 */
const disputeStep = ({ d, phase, extra, speak, context }) => ({
  step: {
    kind: 'dispute',
    phase,
    materialId: d.materialId,
    fileName: d.fileName,
    // 重读要原样抄它。哈希是这次重读和那串字节之间的绑定 —— 内核收的时候会自己重算一遍。
    contentHash: d.contentHash,
    // 契约里的 `step.field`：这一趟只重读这一个字段。一份读数上争多个字段时
    // `fields` 给全，但每一个都是"只读这一处"，不是"顺手重抄一整张"。
    field: d.fields[0].field,
    fields: d.fields.map((f) => f.field),
    evidence: {
      // 重读模板从 evidence 取哈希；这里和顶层保持同一份值，免得子 Agent 反查任务。
      contentHash: d.contentHash,
      // **只给路径。** 内核不替用户打开原件，也不把图塞进对话冒充成"我们一起看过了"。
      // 定夺这件事的前提是他自己看过那张纸。
      materialPath: d.materialPath,
      readAt: d.readAt,
      notes: d.notes,
      fields: d.fields.map((f) => ({
        field: f.field,
        label: f.label,
        machineValue: f.machineValue,
        machineClarity: f.clarity,
        userValue: f.userValue,
        rereadValue: f.reread ?? null,
        convergence: f.convergence,
      })),
      otherFields: d.otherFields,
    },
    ...extra,
    outsourceable: false,
  },
  speak,
  context,
  progress: READING_PROGRESS,
  // 凭据跟着**这一步**走，不跟着状态名走。一场争议里状态一直是 reading_disputed，
  // 但摆证据、请拍板、补缺口是三步不同的事：共用一个凭据的话，
  // 用户在"请拍板"那一步的回传会带着"摆证据"那一步发的凭据，两步之间就没有闸了。
  stepKey: disputeStepKey(phase),
  exit: 0,
});

/** 一个还没读出来的值念给用户听的样子。空着不说，用户会以为是内核漏了。 */
const spoken = (v) => (v === null || v === undefined ? '读不出来' : `「${v}」`);

/**
 * 三种收敛，三句确定的话。一个字段一句，**写死在这里，一处定义**。
 *
 * 为什么不让模型组织：这三句话的区别不在语气，在**它们各自承认了什么**。
 * 第一句承认机器错了，第二句承认机器也可能一起错，第三句承认这个字段机器读不了。
 * 交给模型组织，最可能被抹平的恰恰是第三句 —— 说"读不可靠"比说一个数难得多。
 *
 * 两个地方念它：请用户拍板那一步（第二、三句），和收场之后那张确认表
 * （第一句 —— 重读印证了用户时内核自己就收下了，用户看到的是那张表）。
 * 两处各写一份的话，第一句会变成一句**没有人对着规格核过的话**。
 */
const CONVERGENCE_LINE = {
  [CONVERGENCE.agrees_with_user]: (f) =>
    `${f.label}：我第一次读到${spoken(f.machineValue)}，重读读到${spoken(f.rereadValue)} ——`
    + `第二次也读出你说的这个值，是我第一次看错了。这个值我接受，来源记作你给的。`,

  [CONVERGENCE.agrees_with_machine]: (f, materialPath) =>
    `${f.label}：重读读出来的还是${spoken(f.machineValue)}，和我第一次一样；你说是${spoken(f.userValue)}。`
    + '两次机器读数一致并不等于机器就对 —— 也可能这张图上这一处本来就容易被看成同一个错。'
    + `请你打开原件（${materialPath}）看这一处，你说是多少就是多少。`,

  [CONVERGENCE.third_value]: (f, materialPath) =>
    `${f.label}：三个说法互不相同 —— 我第一次读到${spoken(f.machineValue)}，`
    + `重读读到${spoken(f.rereadValue)}，你说是${spoken(f.userValue)}。`
    + '这说明这个字段在这张图上我读不可靠，我这两次读数在这里都不作数，以原件为准。'
    + `请你对着原件（${materialPath}）告诉我它到底是多少；实在认不出就说一声，`
    + '我把这条读数整条退回待办 —— 我不会替你填一个数。',
};

const convergenceLine = (f, materialPath) => CONVERGENCE_LINE[f.convergence](f, materialPath);

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
    // 一份材料的名字只写在它那几行的头一行上，下面留白 —— 重复的文件名会盖住
    // 用户真正要比对的那一列数字。
    const lines = [
      ...p.fields.map((f) => ({ field: f.label, value: f.value, source: SOURCE_LABELS[f.source] ?? f.source })),
      ...(p.segments ?? []).flatMap((segment) => segment.values.map((value) => ({
        field: `第 ${segment.index} 段${value.label}`,
        value: value.value,
        source: '看图读取',
      }))),
      ...p.unreadable.map((u) => ({ field: u, value: '看不清（我没有猜）', source: '—' })),
    ];
    if (!lines.length) lines.push({ field: '（没有读出任何字段）', value: '' });
    for (const [n, line] of lines.entries()) {
      rows.push({ material: n === 0 ? `${p.fileName}（${p.docTypeLabel}）` : '', ...line });
    }
  }
  return renderTable([
    { key: 'material', label: '材料', max: 46 },
    { key: 'field', label: '字段', max: 16 },
    { key: 'value', label: '值', max: 32 },
    // 来源单独占一列。一张表上同时摆着"我看图读的"和"你上次给的"时，
    // 用户要复核的重点完全不同，而把这件事藏在脚注里等于没说。
    { key: 'source', label: '这个值哪来的', max: 14 },
  ], rows);
}

/**
 * 当前登录身份 -> 一张定宽表格。第一次认「我在替谁报销」看的就是它。
 *
 * 三行都是内核自己从 ERP 页面上读到的原值。判据那两行（账号、账套）单独标出来：
 * 用户认得出的是显示名，而门栓拴的是另外两个 —— 不说清楚，他核对的就是错的那一格。
 */
function identityTable(identity) {
  return renderTable([
    { key: 'field', label: '项', max: 12 },
    { key: 'value', label: '我从 ERP 读到的', max: 32 },
    { key: 'note', label: '说明', max: 24 },
  ], [
    { field: '姓名', value: identity.displayName ?? '（读不出）', note: '只给你认人，不作判据' },
    { field: '登录账号', value: identity.account ?? '（读不出）', note: '判据' },
    { field: '账套', value: identity.tenant ?? '（读不出）', note: '判据，换账套等于换人' },
  ]);
}

/**
 * 待写内容 -> 一张定宽表格。写入前请用户过目的就是它。
 *
 * 一行一条明细，每一列都是**这条明细写进 ERP 之后会长什么样**：
 * 用户在这里核对的不是我读得对不对（那一关在看图读数那张表上过了），
 * 而是这一批东西该不该以这个样子进 ERP。所以金额来源单独占一列 ——
 * 「我按行程单核对上的」和「你自己报的」，用户要撤回的理由完全不同。
 */
function writeTable(lines) {
  const rows = lines.map((l) => ({
    line: l.lineId,
    voucher: `${l.maskedNumber ?? '（无票号）'}`,
    date: l.date ?? '—',
    where: l.route ?? l.city ?? '—',
    category: l.categoryLabel ?? '—',
    project: l.project ?? '—',
    total: l.totalAmount ?? '—',
    source: AMOUNT_SOURCE_LABELS[l.amountSource] ?? l.amountSource,
  }));
  return renderTable([
    { key: 'line', label: '明细', max: 8 },
    { key: 'voucher', label: '发票号', max: 22 },
    { key: 'date', label: '费用日期', max: 12 },
    { key: 'where', label: '城市/行程', max: 20 },
    { key: 'category', label: '费用类别', max: 14 },
    { key: 'project', label: '项目', max: 16 },
    { key: 'total', label: '价税合计', max: 12 },
    { key: 'source', label: '金额哪来的', max: 16 },
  ], rows);
}

/** 三种金额来源念给用户听的样子。它们不是同一种事实，所以不能只写一个「已确定」。 */
const AMOUNT_SOURCE_LABELS = {
  invoice_face: '票面',
  user_allocation: '你逐段报的',
  itinerary_conserved: '行程单，与票面分毫不差',
};

/**
 * 一批明细的价税合计。用户点头之前，总数要摆在他眼前。
 *
 * 取不到金额的明细在事件层就被拦成待办了（`event_amount_missing`），所以走到这里
 * 每一行都该有金额。真要是漏了一行，这里**宁可说不出总数**也不把它当 0 ——
 * 一个悄悄少了一笔的合计，正是用户会照着点头的那种数字。
 */
function sumYuan(lines) {
  if (lines.some((l) => l.totalAmount === null || l.totalAmount === undefined)) return null;
  return (lines.reduce((a, l) => a + Math.round(Number(l.totalAmount) * 100), 0) / 100).toFixed(2);
}

/** 三种来源念给用户听的样子。契约里的 `vision` / `user` / `kernel`。 */
const SOURCE_LABELS = { vision: '我看图读的', user: '你给的', kernel: '内核解析的' };

/** 待办清单念给用户听的样子。谁能解决它，是每条最要紧的那半句。 */
const WHO = { user: '要你处理', model: '我来处理', kernel: '内核已经自己处置了，说一声而已' };
const itemLines = (items) => items
  .map((b, n) => `${n + 1}. ${b.fileName ?? b.materialIds?.join('、') ?? '这批材料'}`
    + `——${b.hint ?? b.kind}（${WHO[b.resolvableBy] ?? WHO.user}）`)
  .join('\n');

/**
 * 收得下 `--correction` 的是**具体那一步**，不是那一类 step。
 *
 * 按 `step.kind` 判会漏掉一整类错：争议有三步，只有请用户拍板的那两步收终值，
 * 摆证据那一步不收 —— 那时候证据还没摆完，不存在"拍板"。按 kind 一刀切的话，
 * 用户在摆证据那一步交上来的值会被**静悄悄丢掉**，而他会以为自己已经定了。
 * 所以由每一步自己声明，声明写在 step 上，模型也看得见。
 */
const acceptsCorrection = (step) => step.acceptsCorrection === true;

/**
 * 交得出结果的 step。前两种以"跑完一条命令"收尾，没有输出就是没跑过；
 * `ask_user` 交的是答案文件 —— 空手回来说"问过了"，同样不推进状态。
 */
const NEEDS_RESULT = new Set(['run', 'read_images', 'ask_user']);

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
  const rereadPath = o.task ? rereadInboxIn(o.task.workspace) : null;
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

    case 'env_identity_unbound': {
      // 绑定要保住的性质是「**没有一个字符串经过模型的手**」：表里每个值都是内核
      // 自己刚从 ERP 读到的，用户只能认或不认。本地页面能做到这一点，终端表格
      // 同样做得到 —— 页面多出来的那部分不是安全性，是一次上下文切换。
      //
      // 规格那一格写的就是「会话内列表格请用户认」。0.9.x 留下的本地确认页在这里
      // 下线，只留给**改绑**（`confirm-identity`，人手敲，见 binding.mjs）。
      const id = o.probe?.identity ?? {};
      return {
        step: {
          kind: 'confirm_table',
          table: identityTable(id),
          // 这一步没有材料，materialIds 空着：凭据认的是「这一步」，不是某几行。
          materialIds: [],
          // **收不下纠正**。身份没有"改一个字"这种收场：是本人，或者不是本人 ——
          // 不是本人的解法在 ERP 那边（换个账号登录），不在这张表上。
          acceptsCorrection: false,
          outsourceable: false,
        },
        speak: `这台机器还没记下我在替谁报销。下面是我刚从 ERP 里读到的登录身份，`
          + `你对一眼：确实是你本人，就回我一句「是我本人」，我把它记下来；`
          + `不是的话先在专用 Chrome 里换成你自己的账号登录。\n${identityTable(id)}`,
        context: '绑定判据是登录账号加账套，不含显示名 —— 显示名在 ERP 里改得动，'
          + '拿它当门栓等于把门栓拴在别人能拧的东西上。表里的每个值都是我自己从 ERP '
          + '读出来的，我不接受口述的账号；记下之后这台机器就只替这个身份报销。',
        progress: ENV_PROGRESS,
        exit: 0,
        // 凭据钉在**这一份身份**上。回传时内核会重新读一次 ERP，读出来的人
        // 和你刚才看过的这一个对不上，这次点头当场作废 —— 你认的永远只是你看过的那一个。
        stepMeta: { account: id.account ?? null, tenant: id.tenant ?? null },
      };
    }

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
      // 这里报的不只是盘点那一层的待办：分流、事件划分、费用类别推导报上来的
      // 拦路项也走这个出口 —— 它们的收场都在用户那一侧，措辞因此不能写死成
      // "我重新盘一遍材料"，那对一条"这张合并发票拆不出来"是答非所问。
      return tellUser({
        speak: `${label} 这批材料里有几件事得先说清楚，处理完我们再往下：\n`
          + `${itemLines(blockedBy.filter((b) => b.blocking))}\n`
          + '每条后面都写了谁能解决它。处理好了跟我说一声，我从头重新核一遍。',
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
      // 刚从争议里收场回来的那几份，收场的说法跟着这张表一起摆出来。
      // 不说的话，用户会在表上看见一个和他上次说的不一样（或者一样）的值，
      // 却不知道中间那次独立重读读出了什么 —— 而那正是他这次点头的依据。
      const settled = pending.flatMap((p) => (p.disputeResolution?.fields ?? []).map((f) =>
        `· ${p.fileName}：${convergenceLine(f, p.fileName)}`));
      const settledSpeak = settled.length
        ? `先说刚才那几处争议是怎么收的：\n${settled.join('\n')}\n`
        : '';
      return confirmTable({
        table: readingTable(pending),
        materialIds: pending.map((p) => p.materialId),
        correctionPath,
        speak: settledSpeak
          + `图我读完了。下面是我从${pending.length > 1 ? `这 ${pending.length} 张` : '这张'}图上逐字抄下来的，`
          + '读数还只是候选，得你对着原件过一眼才算数。'
          + '哪一项对不上就直接说是哪一项、正确的值是什么，我不会拿你说的值直接落库，'
          + '而是带着这个分歧重新看一遍那张图。',
        context: '确认只来自你在这里的表态。你在别处说过的"对的""没问题"我一概不当作确认 ——'
          + '那些话我传得进来，但内核看不见它们，也就没法把它们变成事实。'
          + '全程不需要你打开任何网页。',
      });
    }

    case 'reading_disputed': {
      // 一次只收拾一场争议。摆证据是一件要用户集中注意力的事 ——
      // 两张票的证据链摞在一起摆，用户两张都看不清。
      const [d, ...rest] = o.pendingDisputes ?? [];
      const more = rest.length ? `（另外还有 ${rest.length} 份也指了错，一份一份来）` : '';
      const names = d.fields.map((f) => f.label).join('、');

      if (d.phase === DISPUTE_PHASES.reread) {
        const evidence = d.fields.map((f, n) =>
          `${n + 1}. ${f.label}：我读到的原文是${spoken(f.machineValue)}，你说是${spoken(f.userValue)}。`
          + `我当时对这一处的判断是「${f.clarity.label}」。`).join('\n');
        const fields = d.fields.map((f) => f.field);
        const sightedShapes = SIGHTED_SHAPES;
        const rereadArgv = argvFor('reread-submit', '--dir', o.sourceDir, '--file', rereadPath);
        const submission = {
          materialId: d.materialId,
          contentHash: d.contentHash,
          fields,
          sightedShapes,
          schemaPath: REREAD_TEMPLATE,
          rereadPath,
          argv: rereadArgv,
        };
        return disputeStep({
          d,
          phase: DISPUTE_PHASES.reread,
          extra: {
            // 重读**必须**在一个干净上下文的子 Agent 里做。这不是建议：
            // 它是这一步唯一的证据来源，而带着这段对话去读，读出来的只是回声。
            subagent: {
              required: true,
              context: 'clean',
              instruction: `新开一个不带本次会话上下文的子 Agent，让它用 Read 打开 ${d.materialPath}，`
                + `**只**读这几个字段：${fields.join('、')}。提交时原样使用 materialId ${d.materialId}、`
                + `contentHash ${d.contentHash}，形状从 sightedShapes 里选，按 schemaPath 写到 rereadPath，`
                + '再原样执行 argv。不要把用户说的值、我读到的值、或者我们刚才这段对话告诉它 ——'
                + '它要的就是不知道这些。它读出什么就填什么，认不出就填 null。',
              submission,
              forbidden: ['把用户给的值告诉子 Agent', '把上一次机器读数告诉子 Agent',
                '自己重读一遍充当子 Agent 的结果', '一并重抄这张票上别的字段'],
            },
            sightedShapes,
            schemaPath: REREAD_TEMPLATE,
            rereadPath,
            argv: rereadArgv,
          },
          speak: `${d.fileName} 上的${names}，你说的和我读到的不一样。这个我不能照你说的直接改 ——`
            + '两边都可能错：可能是我看模糊了证据认错了，也可能是你看错了。先把证据摆出来：\n'
            + `${evidence}\n`
            + `这个数我是从这份材料上读的：${d.materialPath}\n`
            + '这份原件请你自己打开看 —— 我不替你打开，也不替你确认。'
            + '同时我另外派一个完全不知道我们刚才说过什么的助手，只重读这一个字段。'
            + `两边都出来之后请你对着原件定夺，你确认的那一下才算数。${more}`,
          context: '为什么不直接改：直接采纳等于承认"人说的不用查"，直接驳回等于承认"机器读的不会错"，'
            + '这两条都不成立。所以内核在这里一个值都不选，只把三份说法摆齐 ——'
            + '我第一次读到的、一次独立重读读到的、你对着原件说的。'
            + '重读要用干净上下文的子 Agent，是因为知道了答案再去读，读出来的只是那个答案。',
        });
      }

      if (d.phase === DISPUTE_PHASES.gap) {
        const g = d.gap;
        return disputeStep({
          d,
          phase: DISPUTE_PHASES.gap,
          extra: {
            gap: g,
            rulingPath: correctionPath,
            acceptsCorrection: true,
            rulingFormat: {
              corrections: [{ materialId: d.materialId,
                fields: { netAmount: '不含税金额', taxAmount: '税额', totalAmount: '价税合计' } }],
              giveUp: { materialId: d.materialId, unreadable: true },
              note: '三个金额要一起给，而且要分毫不差。对不出来就交 unreadable: true，'
                + '这条读数整条退回待办 —— 别去凑一个数。',
            },
          },
          speak: `按你说的改完之后，这张票上的式子不平了：不含税金额 ${g.netAmount} + 税额 ${g.taxAmount} `
            + `= ${g.sum}，而价税合计是 ${g.totalAmount}，差 ${g.delta} 元。\n`
            + '这个差额我不会去反算 —— 反算出来的那个数看着最像对的，'
            + '实际上会是这条链子上唯一一个没有人读过的值。\n'
            + `请你对着原件（${d.materialPath}）把这三个数一起念给我，或者告诉我你也认不出：`
            + '认不出的话我把这条读数整条退回待办，等你换一份看得清的原件。',
          context: '守恒式不让路：不含税金额 + 税额必须分毫不差地等于价税合计。'
            + '不平的读数不进事实链，只会落回开放项 —— 带着一个不平的数往 ERP 写，'
            + '错误会在最不该暴露的地方暴露。',
        });
      }

      // phase === 'ruling'：重读回来了，三种收敛各说各的话，最后请用户拍板。
      const lines = d.fields
        .map((f) => convergenceLine({ ...f, rereadValue: f.reread }, d.materialPath)).join('\n');
      const bad = d.rulingRejection
        ? `\n（上一次你给的值我没收下：${d.rulingRejection.reasons.join('；')}）`
        : '';
      return disputeStep({
        d,
        phase: DISPUTE_PHASES.ruling,
        extra: {
          rulingPath: correctionPath,
          acceptsCorrection: true,
          ruling: {
            // 争议里的每个字段都要有终值，包括重读已经印证了的那些 ——
            // 只回传"还没定的那一个"的话，另一个会悄悄退回机器读数。
            fields: d.fields.map((f) => ({
              field: f.field,
              label: f.label,
              suggested: favorsUser(f.convergence) ? f.userValue : null,
              why: favorsUser(f.convergence)
                ? '重读印证了用户的值，除非用户当场改口，否则就填它'
                : '还没定 —— 用户对着原件说是多少就填多少，认不出填 null',
            })),
          },
          rulingFormat: {
            corrections: [{ materialId: d.materialId, fields: { '<字段名>': '用户对着原件给的终值' } }],
            giveUp: { materialId: d.materialId, unreadable: true },
            note: '用户对着原件也认不出时交 giveUp，别替他填 —— 这条读数整条退回待办是一个正当的结局。',
          },
        },
        speak: `${d.fileName}：重读的结果出来了。\n${lines}${bad}`,
        context: '重读是在一个完全不知道我们刚才争过什么的子 Agent 里做的，只读了这一个字段。'
          + '三次读数里没有哪一次天然更可信 —— 定夺的是你对着原件看到的那个值。'
          + '你定完之后这份读数还会整张再摆一次请你过目，改过的字段会标明来源是你。',
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
      return run(argvFor('events', '--dir', o.sourceDir), {
        speak: `${label} 的材料这一段清完了：盘点、分类、看图读数、确认都过了。`
          + '接下来我把这些材料切成一次次具体的费用 —— 一段行程、一次住宿、一张车票各算一次，'
          + '合并的交通发票按行程单上写着的段数拆开。拆分要有证据，我不按金额猜、也不按文件名猜。',
        context: '事件划分挂在当前盘点版本和当前这批明细上。用户补一次逐段分摊，'
          + '明细会从一行变成三行，这一版账本就得重记 —— 所以这个状态会再来一次，不是重复劳动。',
        progress: EVENT_PROGRESS,
      });

    case 'allocation_required':
    case 'allocation_stale': {
      const a = o.allocationRound;
      const asked = a.questions.length;
      const why = a.stale
        ? `${a.fileName} 变过了，之前那次逐段金额已经作废，我们重来一遍。`
        : `${a.fileName} 是一张合并的交通发票：票面只有一个合计 ${a.totalAmount} 元，`
          + `但行程单上是 ${a.segmentCount} 段行程，而逐段金额加起来和票面对不上。`;
      const bad = a.rejection
        ? `\n（上一轮没收下：${a.rejection.reasons.join('；')}）`
        : '';
      const sofar = a.answered.length
        ? `\n已经定下来的：${a.answered.map((x) => `第 ${x.index} 段 ${x.amount} 元`).join('、')}。`
        : '';
      const more = a.remaining > asked
        ? `\n这一轮先问 ${asked} 段，剩下 ${a.remaining - asked} 段接着问。`
        : '';
      return askUser({
        questions: a.questions,
        answersPath: answerInboxIn(o.task.workspace),
        answersFormat: {
          answers: [
            { questionId: '<step.questions[].id>', amount: '用户选定的那一段金额，两位小数' },
            { questionId: '<step.questions[].id>', giveUp: true },
          ],
          note: '问了几题就答几条，一题一条，都写在 answers 里。金额原样抄用户选的那个数'
            + ' —— 不要自己算、不要为了凑总额改任何一段。用户选「这张票我认不出」时，'
            + '那一条写成 { questionId, giveUp: true }，整张票就退回待办。',
        },
        speak: `${why}\n各段的价税合计要你来定：加起来必须正好是 ${a.totalAmount} 元，`
          + '我不会平均、不会按比例、也不会把差额随手加到某一段上 —— '
          + '差额落在哪一段，只有你知道。'
          + `${sofar}${more}${bad}`,
        context: '逐段金额之和与票面价税合计分毫不差时，我自己就定了，根本不会问你这一句。'
          + '现在问，就是因为对不上。每一段的选项里都有行程单上写的那个数（如果它写了），'
          + '也可以直接告诉我别的数。实在认不出就说一声，这张票整张退回待办 —— '
          + '那比报一个凑得平的数字好。',
        progress: EVENT_PROGRESS,
      });
    }

    case 'classified_detail_incomplete':
      return tellUser({
        speak: '完整报销明细还缺日期、金额、城市或行程、费用类别中的至少一项。'
          + '这些材料事实没有补齐之前，我不会请你确认，也不会进入项目分配。',
        context: '当前 main 的任务选择把常驻城市和项目一起提交；本批次不新增项目选择器，'
          + '因此需要常驻城市才能分类的明细会保守停在这里，不会用空类别冒充完整明细。',
        progress: EVENT_PROGRESS,
      });

    case 'classified_detail_confirmation_required': {
      const detail = o.classifiedDetail;
      const rows = detail?.rows ?? [];
      const table = renderTable([
        { key: 'line', label: '明细引用', max: 10 },
        { key: 'material', label: '材料引用', max: 16 },
        { key: 'voucher', label: '发票号', max: 22 },
        { key: 'date', label: '日期', max: 12 },
        { key: 'amount', label: '金额/来源', max: 24 },
        { key: 'where', label: '城市/行程', max: 20 },
        { key: 'category', label: '费用类别', max: 14 },
        { key: 'association', label: '证据关联', max: 30 },
      ], rows.map((r) => ({
        line: r.lineRef, material: r.materialRef, voucher: r.voucher,
        date: r.date ?? '—', amount: `${r.amount ?? '—'} / ${AMOUNT_SOURCE_LABELS[r.amountSource] ?? r.amountSource ?? '—'}`,
        where: r.route ?? r.city ?? '—', category: r.categoryLabel ?? r.category ?? '—',
        association: r.association.references.length
          ? `${r.association.primary} ← ${r.association.references.join(', ')}`
          : `${r.association.primary}（无参考材料）`,
      })));
      return {
        step: { kind: 'confirm_table', table, materialIds: [...new Set(rows.map((r) => r.materialRef))],
          lineCount: rows.length, acceptsCorrection: false, outsourceable: false },
        speak: `材料、证据关联和分摊已经全部复核完。下面是完整的 ${rows.length} 条报销明细，`
          + '每条只出现一次。请逐行核对日期、金额及来源、城市或行程、费用类别和证据关联；'
          + '明确确认后，我只会把其中的主要报销凭证复制到任务私有的 ERP 上传暂存目录。'
          + '这只是本地准备，不会上传、写入或触碰 ERP。',
        context: '确认钉在这张完整表的摘要上；材料、读数、关联、分摊、金额、地理、类别或明细任何变化，'
          + '旧确认立即失效。参考材料不会进入上传暂存目录，源文件不会移动。',
        progress: EVENT_PROGRESS,
        exit: 0,
        stepMeta: { classifiedDetailDigest: o.classifiedDetailDigest },
      };
    }

    case 'project_unassigned': {
      // 表里这一格写的是「按事件用对话提问问（候选≤3 + 其他）」。**那个问法还没落成**：
      // 几十张发票配三五个项目，怎么问才不折磨人，用户已经把它单独拿去做原型了。
      // 这一版只做到如实报出来 —— 报出一个还没有的交互，比停在这里更糟。
      const lines = o.lines ?? [];
      const missing = lines.filter((l) => !l.project);
      // `tell_user` 而不是 `done`：这一批材料并没有走完，它停在这里等一个人。
      // 用 `done` 收工，等于对用户说"这就完了"，而 ERP 里什么都还没有。
      return tellUser({
        speak: `${label} 已经切成 ${lines.length} 条费用明细，金额和日期都对上了。`
          + `再往下还差一样东西：${missing.length === lines.length ? '每一条' : `其中 ${missing.length} 条`}`
          + '都还没有项目号。项目归属材料上没有，我也不会替你猜 —— 怎么问你选项目，'
          + '这个问法还在单独定，定下来之前我停在这里。',
        context: '项目归属是业务事实，不是材料事实：同一张发票记在哪个项目上，只有你知道。'
          + '对话提问的问法（几十张发票配三五个项目怎么选才快）正在单独做原型，'
          + '结论出来之后这一步会补上。在那之前也可以用 select-task 打开任务选择页自己填。',
        progress: PROJECT_PROGRESS,
      });
    }

    case 'catalog_unverified':
      return run(argvFor('catalog', '--dir', o.sourceDir), {
        speak: '项目号和费用项目我拿到 ERP 里只读查一遍，确认它们真的存在、已审核、没被禁用。'
          + '这一步只查不写，用的是你自己已经登录的那个会话。',
        context: '走的是金蝶自带的查询服务，只查这一个地址。查得通只证明主数据在目录里可以引用，'
          + '不证明它在费用明细上保存得进去 —— 后者只有真保存并回读才算数。',
        progress: CATALOG_PROGRESS,
      });

    case 'catalog_mismatch':
      return tellUser({
        speak: '停一下 —— 到 ERP 里核对的时候有对不上的：\n'
          + `${itemLines(blockedBy)}\n`
          + '这些不能将就着往下走：拿一个 ERP 里不存在的项目号建单，错误只会在保存那一刻暴露，'
          + '而那时候单据已经建出来了。请你确认正确的项目号，改完我们再核对一遍。',
        context: '核对判的是四件事：编码在不在、名称对不对得上、单据状态已审核、没有被禁用。'
          + '编码对得上而名称对不上时我也停 —— 那说明对照表和 ERP 已经错位，'
          + '改个名字将就过去只会把错误带进单据。',
        progress: CATALOG_PROGRESS,
        exit: BLOCKED,
      });

    case 'ready_for_erp_write': {
      const lines = o.lines ?? [];
      if (o.writeApproved) {
        // 点过头了。真正往 ERP 写还没接进这条命令 —— 这一版到此为止，
        // 而且要说清楚"还没写"，否则用户会以为已经写完了。
        return done({
          speak: '好，你点头了，这份内容我记下来了。往 ERP 里建单这一步还没接进来，'
            + '所以现在还没有任何东西写进 ERP —— 我在这里停住，不会自己越过去。',
          context: '这次点头钉在你刚才看过的那一份内容上：明细、金额、项目号任何一处再变，'
            + '这次点头当场作废，会重新摆一遍请你再看。',
          progress: WRITE_PROGRESS,
        });
      }
      return {
        step: {
          kind: 'confirm_table',
          table: writeTable(lines),
          lineCount: lines.length,
          totalAmount: sumYuan(lines),
          homeCity: o.homeCity ?? null,
          purpose: o.purpose ?? null,
          // **收不下纠正**。这一步只有两种收场：点头，或者不点头。
          // 在写入前的最后一格上改一个值，等于绕开前面每一道校验直接改写待写内容。
          acceptsCorrection: false,
          outsourceable: false,
        },
        speak: `下面是我准备写进 ERP 的全部内容，一共 ${lines.length} 条明细，`
          + `合计 ${sumYuan(lines) ?? '（有明细没取到金额，这个总数我算不出来）'} 元`
          + `${o.purpose ? `，事由「${o.purpose}」` : ''}`
          + `${o.homeCity ? `，常驻城市 ${o.homeCity}` : ''}：\n`
          + '写进去之后我撤不回来 —— 要改就得你自己去 ERP 里改或者作废。'
          + '请你逐行看一遍，确认无误再告诉我可以写。有一处不对就直接说，我不会写。',
        context: '这是整条链子上唯一不可撤销的一步，所以它只认你在这里的明确表态：'
          + '前面每一步的"好""可以"都不算数。哪一行不对，回去改那一层（材料、分摊、项目），'
          + '改完这张表会重新摆一遍 —— 我不在这张表上直接改值，那等于绕开前面所有校验。',
        progress: WRITE_PROGRESS,
        exit: 0,
        // 凭据钉在**这一份待写内容**上。任何一处再变，这个凭据当场作废，
        // 用户会重新看到一张新表 —— 他点的头永远只对他看过的那一份有效。
        stepMeta: { previewDigest: writePreviewDigest(o.writePreview) },
      };
    }

    case 'handed_off_recover':
      return handoff({
        skill: 'baox-recover',
        speak: `${label} 这个任务已经往 ERP 发过写入（当前记的状态是 ${o.task?.erpWriteState}），`
          + '所以它不再走这条路了：接下来要做的是到 ERP 里只读对账，看那张单到底落成了什么样，'
          + '再决定接着填、还是作废重来。这件事交给 baox-recover。',
        context: '一旦碰过 ERP，任务持有的那几张发票就不能靠改状态解除占用 —— 只能靠只读对账。'
          + '所以这里不再问你要不要写：该问的是那一张已经存在的单现在是什么样。',
        progress: WRITE_PROGRESS,
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
    } else if (outstanding.state === (shaped.stepKey ?? verdict.state)
      && NEEDS_RESULT.has(shaped.step.kind) && !hasResult) {
      // 状态和上一步一样，却没交结果。状态不动 —— 说做完了不算做完了。
      ignored = { reason: 'no_result',
        note: '这一步要的是命令的实际输出，没有输出就没有事实，状态不动' };
    }
    // 状态已经往前走的情况不记：那个凭据自然作废，不是错，就是这一步过去了。
  }
  if (hasCorrection && !acceptsCorrection(shaped.step)) {
    // 纠正只在请用户过目的那种步骤上说得通。收下一份没处安放的纠正而不吭声，
    // 会让用户以为自己的改动被采纳了。
    ignored = { reason: 'correction_not_applicable',
      note: `现在这一步（${shaped.step.kind}${shaped.step.phase ? `/${shaped.step.phase}` : ''}）`
        + '收不下终值，这份纠正我没有采纳' };
  }

  const record = issueStep(sourceKey, shaped.stepKey ?? verdict.state,
    observation.sourceDir ?? null, shaped.stepMeta ?? null, shaped.step?.argv ?? null);
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
