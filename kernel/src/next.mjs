/**
 * `baox next`：把状态判定的结论翻成模型唯一要做的那一件事。
 *
 * 模型在整个流程里只调两条命令 —— 问（`next --dir`）和答（`next --after`）。
 * 它不选命令、不拼命令、不组织措辞：`step.argv` 是内核给的完整命令行，
 * `speak` 是内核写死的原话。措辞是模型差异最大的地方，所以不交给模型。
 *
 * 落成的是两张表的全部状态（`archived` 是任务状态不是状态，见 state.mjs 的开头），
 * 所有 `step.kind` 都有明确回传契约；`ask_user` 的第一次真实使用是逐段分摊，
 * `run` 的本地恢复入口只建立 fresh 只读凭据；ERP 写入闸仍由 state/erp-fill 保持。
 */
import path from 'node:path';
import url from 'node:url';
import { determineState, SCHEMA_VERSION, MIN_NODE_MAJOR } from './state.mjs';
import { currentStep, issueStep } from './steptoken.mjs';
import { readingInboxIn, correctionInboxIn, rereadInboxIn, answerInboxIn, homeCityAnswerIn } from './workspace.mjs';
import { CONVERGENCE, favorsUser, disputeStepKey, DISPUTE_PHASES } from './dispute.mjs';
import { SHAPES, SHAPE_LABELS } from './imageshape.mjs';
import { DEFAULT_IMAGE_RECOGNITION_ADAPTER, DOC_TYPES, FIELD_RULES, INVOICE_READING_FIELDS, SEGMENT_RULES,
  IMAGE_RECOGNITION_ADAPTERS } from './vision.mjs';
import { roundFingerprint } from './allocate.mjs';
import { renderTable, renderQuestions } from './table.mjs';
import { classifiedDetailDigest } from './classified-detail.mjs';
import { PDF_MARKDOWN_SCHEMA_PATH, PDF_MARKDOWN_TEMPLATE_PATH, MARKITDOWN_VERSION } from './pdf-markdown.mjs';
import { ERP_ENTRY } from './probe.mjs';
import { SYSTEM_BROWSER } from './browser-open.mjs';
import { runtimeDependencyStep } from './runtime-dependencies.mjs';
import { PROGRESS, decorateStep, sanitizeUserText } from './interaction.mjs';
import { validHomeCity } from './home-city.mjs';

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
    allowedFields: docType === 'invoice' ? INVOICE_READING_FIELDS : ALLOWED_READING_FIELDS,
    requiredFields: docType === 'invoice'
      ? Object.freeze(['invoiceNumber', 'netAmount', 'taxAmount', 'totalAmount']) : Object.freeze([]),
    requiredOrUnreadable: docType === 'ride_itinerary' ? Object.freeze(['totalAmount']) : Object.freeze([]),
    ...(docType === 'ride_itinerary' ? { flatItinerary: Object.freeze({
      requiredOrUnreadable: Object.freeze(['travelDate']),
      note: '没有 segments 时，必须填写 fields.travelDate；看不清就把 travelDate 列入 unreadable。不能用 issueDate 代替。',
    }) } : {}),
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

const ENV_PROGRESS = PROGRESS.environment;
const IDENTITY_PROGRESS = PROGRESS.identity;
const MATERIAL_PROGRESS = PROGRESS.intake;
const READING_PROGRESS = PROGRESS.materials;
const EVENT_PROGRESS = PROGRESS.events;
const PROJECT_PROGRESS = PROGRESS.projects;
const CATALOG_PROGRESS = PROGRESS.catalog;
const WRITE_PROGRESS = PROGRESS.save;
const PREPARATION_PROGRESS = PROGRESS.preparation;

const imageAdapterOf = (observation) => {
  const requested = observation.imageRecognitionAdapter ?? observation.task?.imageRecognitionAdapter;
  return requested === IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED
    ? IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED : DEFAULT_IMAGE_RECOGNITION_ADAPTER;
};

// 退出码：0 继续 / 2 有硬阻塞，未解决不得继续。硬阻塞是那些「等下去也不会好」的：
// Node 太老、数据格式太新、登错了人。停在登录页不是硬阻塞 —— 那是在等人，不是被拦住。
const BLOCKED = 2;

// 每种 step.kind 一个构造函数。它们存在的意义是把「这一步长什么样」收在一处：
// 其余步骤随各自状态一起加进来，
// 加的时候只动这里，不动 stepFor 里那张状态表。
/**
 * 跑一条内核给的命令。
 *
 * `outsourceable` 是给子 Agent 那条规矩用的：契约说 `kind: "run"` 的连续段可以外包，
 * 但有的命令会弹出一个要人**亲手点一下**的本地页面（改绑身份、浏览项目目录）——
 * 外包给一个没有终端的子 Agent，它只会挂在那里等一个永远不会发生的点击。
 * 所以这一条写进 JSON 里，而不是只写在注释里：模型看得见的才算数。
 */
const run = (argv, { speak, context, progress = ENV_PROGRESS, outsourceable = true,
  out = null, env = null, ...stepFields }) =>
  ({ step: { kind: 'run', argv, outsourceable,
    ...(out ? { out } : {}), ...(env ? { env } : {}), ...stepFields },
  speak, context, progress, exit: 0 });

const tellUser = ({ speak, context, table = null, progress = ENV_PROGRESS, exit = 0 }) =>
  ({ step: { kind: 'tell_user', ...(table ? { table } : {}) }, speak, context, progress, exit });

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

/** 受管本地 OCR 工单。OCR 结果不足时，工单内再交给模型视觉兜底。 */
const extractImages = ({ images, workspace, readingsPath, argv, speak, context }) => ({
  step: {
    kind: 'extract_images',
    skill: 'extract-reimbursement-images',
    adapter: IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED,
    contractVersion: 1,
    outsourceable: false,
    images: images.map(({ materialId, fileName, absPath, format, contentHash }) =>
      ({ materialId, fileName, absPath, format, contentHash })),
    request: {
      contractVersion: 1,
      images: images.map(({ materialId, contentHash, absPath }) => ({ materialId, contentHash, absPath })),
    },
    requestPath: path.join(workspace, 'image-extraction-request.json'),
    extractionPath: path.join(workspace, 'image-extraction-result.json'),
    resultPath: path.join(workspace, 'image-extraction-submit.json'),
    schemaPath: READING_TEMPLATE,
    readingContract: READING_CONTRACT,
    readingsPath,
    sightedShapes: SIGHTED_SHAPES,
    argv,
  },
  speak, context, progress: READING_PROGRESS, exit: 0,
});

/**
 * PDF 候选工单。模型先读取内核生成的带编号 Markdown，再按模板写候选 JSON，
 * 最后原样执行 ingest；把读取动作单列出来，避免把未填写的 candidatePath 当成普通 run。
 */
const readMarkdown = ({ materials, argv, speak, context }) => ({
  step: {
    kind: 'read_markdown',
    outsourceable: true,
    materials,
    schemaPath: PDF_MARKDOWN_SCHEMA_PATH,
    templateSchemaPath: PDF_MARKDOWN_TEMPLATE_PATH,
    argv,
    instructions: '逐份打开 numberedMarkdownPath；只按 templatePath 的闭集字段填写 candidatePath，'
      + '每个非空字段必须引用连续的 1-based 行号和原文 quote。跨行、列串位或路线无法从 Markdown 确定时保留缺失或歧义，不能改走图片读取。'
      + 'issues 只填写当前无法从原件核实的未解决问题；已核对的说明写进 fieldBasis，适用但缺失的值用 fieldStatus/missing，'
      + '不要把铁路票面没有净额税额等信息性备注写成 issue，也不要从文件名、金额相近或对话补值。',
  },
  speak, context, progress: MATERIAL_PROGRESS, exit: 0,
});

/**
 * 请用户过目一张内核渲染好的 Markdown 表格。
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
      corrections: [{ materialId: '表里那一行的 materialId', fields: {
        netAmount: '不含税金额', taxAmount: '税额', totalAmount: '价税合计',
      } }],
      note: '只写用户当面改的金额字段，其余不要抄。用户的值不会被直接落库 —— '
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
    `${f.label}：前后两次读取结果分别是${spoken(f.machineValue)}和${spoken(f.rereadValue)}。`
    + `第二次结果与你提供的值一致，本次采用这个值。`,

  [CONVERGENCE.agrees_with_machine]: (f) =>
    `${f.label}：前后两次读取结果都是${spoken(f.machineValue)}，与你提供的${spoken(f.userValue)}不一致。`
    + '请对照原件，直接告诉我正确值。',

  [CONVERGENCE.third_value]: (f) =>
    `${f.label}：前后两次读取结果和你提供的值不一致 —— 第一次是${spoken(f.machineValue)}，`
    + `重读读到${spoken(f.rereadValue)}，你说是${spoken(f.userValue)}。`
    + '请以原件为准，直接告诉我正确值；看不清就回复看不清，我会把这项列入待处理事项。',
};

const convergenceLine = (f) => CONVERGENCE_LINE[f.convergence](f);

/**
 * 待确认读数 -> 一张 Markdown 表格。
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
 * 分类明细确认表。这里列的是材料事实和内核推导的费用类别，项目归属刻意不出现：
 * 项目是下一步的个人项目簿选择，不能让用户误以为它属于这次分类确认。
 */
const amountText = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value.text ?? (value.cents === null || value.cents === undefined
    ? null : (value.cents / 100).toFixed(2));
  return String(value);
};

const faceAmountText = (kind, value, field) => amountText(value)
  ?? (kind === 'rail_eticket'
    ? (field === 'tax' ? '0.00（业务默认）' : field === 'net' ? '无需读取' : '—')
    : '—');

// Markdown 候选和旧看图结果都可能只带闭集 kind；确认表不能把内部枚举直接念给用户。
const KIND_LABELS = Object.freeze({
  vat_common: '电子普通发票',
  vat_special: '增值税专用发票',
  passenger_transport: '旅客运输服务电子普通发票',
  rail_eticket: '铁路电子客票',
  ride_itinerary: '网约车行程单',
  hotel_folio: '酒店结账单',
});

/**
 * 票面事实汇总。事件明细的金额可能已经按行程段拆分，不能拿它代替原票上的
 * 不含税、税额和价税合计；这里直接从主要发票候选证据取值，单独给用户核对。
 */
function invoiceSummaryTable(preview = {}) {
  const linesByMaterial = new Map();
  for (const line of preview.lines ?? []) {
    if (!linesByMaterial.has(line.voucherMaterialId)) linesByMaterial.set(line.voucherMaterialId, line);
  }
  const rows = (preview.evidence ?? [])
    .filter((item) => item.role === 'primary_voucher')
    .map((item) => {
      const line = linesByMaterial.get(item.materialId) ?? {};
      const kind = item.kind ?? line.kind ?? null;
      return {
        voucher: line.voucherFileName ?? item.fileName ?? '（主要凭证）',
        kind: item.kindLabel ?? line.kindLabel ?? KIND_LABELS[kind] ?? kind ?? '—',
        net: faceAmountText(kind, item.fields?.netAmount, 'net'),
        tax: faceAmountText(kind, item.fields?.taxAmount, 'tax'),
        total: faceAmountText(kind, item.fields?.totalAmount, 'total'),
      };
    });
  return renderTable([
    { key: 'voucher', label: '发票', max: 22 },
    { key: 'kind', label: '票据类型', max: 24 },
    { key: 'net', label: '不含税金额', max: 18 },
    { key: 'tax', label: '税额', max: 18 },
    { key: 'total', label: '价税合计', max: 18 },
  ], rows);
}

function classifiedDetailTable(preview = {}) {
  const rows = (preview.lines ?? []).map((line) => ({
    line: line.lineId,
    voucher: line.voucherFileName ?? '（主要凭证）',
    kind: line.kindLabel ?? KIND_LABELS[line.kind] ?? line.kind ?? '—',
    startDate: line.date ?? '—',
    endDate: line.endDate ?? line.checkOut ?? line.date ?? '—',
    city: line.city ?? '—',
    origin: line.origin ?? '—',
    destination: line.destination ?? '—',
    net: line.netAmount ?? '—',
    tax: line.taxAmount ?? '—',
    total: line.totalAmount ?? '—',
    category: line.categoryLabel ?? '—',
    expense: line.expenseItemName ?? line.expenseItemCode ?? '—',
    evidence: (line.referenceMaterialIds ?? []).join('、') || '—',
  }));
  return renderTable([
    { key: 'line', label: '明细', max: 8 },
    { key: 'voucher', label: '发票/材料', max: 24 },
    { key: 'kind', label: '票种', max: 20 },
    { key: 'startDate', label: '起始日期', max: 14 },
    { key: 'endDate', label: '结束日期', max: 14 },
    { key: 'city', label: '城市', max: 14 },
    { key: 'origin', label: '出发点', max: 20 },
    { key: 'destination', label: '目的地', max: 20 },
    { key: 'net', label: '不含税金额', max: 14 },
    { key: 'tax', label: '税额', max: 12 },
    { key: 'total', label: '价税合计', max: 14 },
    { key: 'category', label: '费用类别', max: 16 },
    { key: 'expense', label: '费用项目', max: 14 },
    { key: 'evidence', label: '参考材料', max: 18 },
  ], rows);
}

/**
 * 当前登录身份 -> 一张 Markdown 表格。第一次认「我在替谁报销」看的就是它。
 *
 * 三行都是内核自己从 ERP 页面上读到的原值。判据那两行（账号、账套）单独标出来：
 * 用户认得出的是显示名，而门栓拴的是另外两个 —— 不说清楚，他核对的就是错的那一格。
 */
function identityTable(identity) {
  return renderTable([
    { key: 'field', label: '项', max: 12 },
    { key: 'value', label: '当前登录信息', max: 32 },
    { key: 'note', label: '说明', max: 24 },
  ], [
    { field: '姓名', value: identity.displayName ?? '（读不出）', note: '只给你认人，不作判据' },
    { field: '登录账号', value: identity.account ?? '（读不出）', note: '判据' },
    { field: '账套', value: identity.tenant ?? '（读不出）', note: '判据，换账套等于换人' },
  ]);
}

function profileTable(identity, homeCity) {
  return renderTable([
    { key: 'field', label: '项目', max: 12 },
    { key: 'value', label: '当前信息', max: 32 },
  ], [
    { field: '报销人', value: identity?.displayName ?? identity?.account ?? '（未确认）' },
    { field: '常驻城市', value: homeCity ?? '（未设置）' },
  ]);
}

/** 三种来源念给用户听的样子。契约里的 `vision` / `user` / `kernel`。 */
const SOURCE_LABELS = { vision: '材料核对结果', ocr: '材料读取结果', user: '你确认的', kernel: '系统整理结果' };

/** 待办清单念给用户听的样子。谁能解决它，是每条最要紧的那半句。 */
const WHO = { user: '要你处理', model: '我来处理', kernel: '系统' };
const evidenceLabel = (b) => {
  if (b.kind !== 'evidence_ambiguous' || !Array.isArray(b.references)) return null;
  const candidates = b.references.map((reference) => {
    const id = reference?.materialId ?? '（无 materialId）';
    return reference?.fileName ? `${id}/${reference.fileName}` : id;
  }).join('、');
  return `凭证 ${b.materialId ?? '（无 materialId）'}；参考材料 ${candidates || '（无）'}`;
};

const blockerSubject = (item) => evidenceLabel(item)
  ?? item.fileName
  ?? item.materialIds?.join('、')
  ?? (item.lineId ? `明细 ${item.lineId}` : null)
  ?? (item.number ? `项目号 ${item.number}` : null)
  ?? item.materialId
  ?? '这批材料';

const blockerReason = (item) => sanitizeUserText(
  String(item.hint ?? item.note ?? item.message ?? item.reason ?? '这项材料暂时无法处理')
    .replace(/用 abandon-task --task \S+ 把它作废/g, '请联系报销管理员处理该任务'));

/** 用户要处理的开放项也由内核渲染，避免模型把长句重排成错位清单。 */
const itemTable = (items) => renderTable([
  { key: 'number', label: '序号', max: 6 },
  { key: 'subject', label: '材料/明细', max: 24 },
  { key: 'reference', label: '参考材料', max: 32 },
  { key: 'reason', label: '待处理问题', max: 400 },
  { key: 'resolver', label: '处理人', max: 10 },
], (items ?? []).flatMap((item, index) => {
  const references = item.kind === 'evidence_ambiguous' && Array.isArray(item.references)
    ? item.references : [];
  if (!references.length) return [{
    number: index + 1,
    subject: blockerSubject(item),
    reference: '—',
    reason: blockerReason(item),
    resolver: WHO[item.resolvableBy] ?? WHO.user,
  }];
  return references.map((reference, referenceIndex) => ({
    number: referenceIndex === 0 ? index + 1 : `${index + 1}.${referenceIndex + 1}`,
    subject: referenceIndex === 0 ? `凭证 ${item.materialId ?? '（无 materialId）'}` : '',
    reference: `${reference?.materialId ?? '（无 materialId）'}${reference?.fileName
      ? `/${reference.fileName}` : ''}`,
    reason: referenceIndex === 0 ? blockerReason(item) : '',
    resolver: WHO[item.resolvableBy] ?? WHO.user,
  }));
}));

const preparationProblemTable = (items) => renderTable([
  { key: 'number', label: '序号', max: 6 },
  { key: 'missing', label: '准备缺项', max: 32 },
  { key: 'subject', label: '关联材料/明细', max: 24 },
  { key: 'resolver', label: '处理人', max: 10 },
], (items ?? []).map((problem, index) => ({
  number: index + 1,
  missing: blockerReason(problem),
  subject: problem.fileName ?? problem.materialId ?? problem.lineId ?? problem.field ?? '准备材料',
  resolver: WHO[problem.resolvableBy] ?? WHO.user,
})));

const preparationPackageText = (o) => {
  const packageInfo = o.preparationPackage ?? o.preparation?.package ?? null;
  if (!packageInfo) return '核对材料正在生成。';
  const files = packageInfo.files;
  const fileCount = files && typeof files === 'object'
    ? Object.values(files).reduce((count, value) => count + (Array.isArray(value) ? value.length : 1), 0)
    : 0;
  return fileCount ? `核对材料已生成，共 ${fileCount} 份文件。` : '核对材料已生成。';
};

const preparationMoney = (line) => {
  if (Number.isInteger(line?.totalCents)) return `${(line.totalCents / 100).toFixed(2)} 元`;
  return line?.totalAmount ?? '缺失';
};

const PREPARATION_SOURCE_LABELS = {
  invoice_face: '票面',
  user_allocation: '你确认的分摊',
  itinerary_conserved: '行程单与票面核对一致',
};

/** 准备确认只展示用户需要核对的摘要和每条明细，所有长文本受列宽控制。 */
const preparationConfirmationTable = (preparation = {}) => {
  const document = preparation.document && typeof preparation.document === 'object'
    ? preparation.document : {};
  const lines = document.lines ?? [];
  const invoices = new Map((document.invoices ?? [])
    .map((invoice) => [invoice.materialId, invoice]));
  const summary = renderTable([
    { key: 'field', label: '项目', max: 18 },
    { key: 'value', label: '当前准备结果', max: 58 },
  ], [
    { field: '阶段', value: document.phase === 'pre-erp' ? '报销材料准备' : document.phase ?? '报销材料准备' },
    { field: '状态', value: document.status === 'ready_for_preparation' ? '材料已备齐'
      : document.status ? '草稿（材料不足）' : '—' },
    { field: '报销事由', value: document.purpose ?? '—' },
    { field: '常驻城市', value: document.homeCity ?? '—' },
    { field: '发票/明细数', value: `${(document.invoices ?? []).length} / ${lines.length}` },
    { field: '明细总额', value: lines.every((line) => Number.isInteger(line.totalCents))
      ? `${(lines.reduce((sum, line) => sum + line.totalCents, 0) / 100).toFixed(2)} 元` : '缺失' },
  ]);
  const detail = renderTable([
    { key: 'line', label: '明细', max: 10 },
    { key: 'invoice', label: '发票号', max: 22 },
    { key: 'date', label: '日期', max: 24 },
    { key: 'where', label: '城市/行程', max: 24 },
    { key: 'total', label: '价税合计', max: 14 },
    { key: 'project', label: '项目', max: 22 },
    { key: 'expense', label: '费用项目', max: 20 },
    { key: 'source', label: '金额来源', max: 22 },
  ], lines.map((line, index) => {
    const invoice = invoices.get(line.voucherMaterialId);
    const project = [line.projectCode, line.projectName].filter(Boolean).join(' / ') || '—';
    const expense = [line.expenseItemCode, line.expenseItemName].filter(Boolean).join(' / ') || '—';
    return {
      line: line.lineId ?? index + 1,
      invoice: invoice?.identity?.number ?? invoice?.fields?.invoiceNumber ?? '—',
      date: line.checkOut && line.checkOut !== line.date
        ? `${line.date ?? '—'} 至 ${line.checkOut}` : line.date ?? '—',
      where: line.route ?? line.city ?? '—',
      total: preparationMoney(line),
      project,
      expense,
      source: PREPARATION_SOURCE_LABELS[line.amountSource] ?? line.amountSource ?? '—',
    };
  }));
  return `${summary}\n\n${detail}`;
};

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
const NEEDS_RESULT = new Set(['run', 'read_images', 'extract_images', 'read_markdown', 'ask_user']);

/**
 * 状态 -> step + 原话。纯函数：同一个状态加同一份观测，永远得到同一句话。
 *
 * `blockedBy` 是判定那一侧算好的开放项，材料这一段要按它逐条说话。
 */
function rawStepFor(state, observation = {}, blockedBy = []) {
  const o = observation;
  const systemBrowser = o.browserMode === SYSTEM_BROWSER
    || ['system', 'default'].includes(o.probe?.transport);
  const who = o.probe?.identity?.displayName ?? o.probe?.identity?.account ?? null;
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
        speak: '这批报销材料需要更新版本的报销工具才能继续。请先完成更新，之后我会从当前进度继续。',
        context: `数据目录里记的格式版本是 ${o.schemaVersion}，这个内核只认到 ${SCHEMA_VERSION}。`
          + '版本闸看的是数据格式，不是代码版本号。',
        progress: null,
        exit: BLOCKED,
      });

    case 'env_node_unsupported':
      return tellUser({
        speak: '当前运行环境版本过低，暂时不能继续。请先完成环境更新，之后我会从当前进度继续。',
        context: systemBrowser
          ? 'baox 的内核运行需要 Node 21 或更高版本。'
          : 'ego-browser 的内核运行需要 Node 21 或更高版本。',
        exit: BLOCKED,
      });

    case 'env_runtime_missing': {
      const install = o.runtimeDependencies?.install ?? runtimeDependencyStep();
      return run(install.argv, {
        out: install.out,
        env: install.env,
        runtimes: install.runtimes,
        speak: '报销工具还缺少处理材料所需的组件。请先完成环境准备；准备失败时我会停在这里，不会开始处理材料。',
        context: 'MarkItDown 和 extract-reimbursement-images OCR 必须在材料解析前准备好。'
          + '安装只写入 BAOX_HOME 下的固定目录，解析阶段不会临时同步或下载，也不使用全局 Python。',
      });
    }

    case 'env_chrome_down':
      if (systemBrowser) {
        const reason = o.browserReadError?.message ?? o.probe?.hint;
        return tellUser({
          speak: '当前浏览器暂时无法读取报销系统页面，身份尚未确认。请按提示恢复浏览器权限后再试。',
          context: reason
            ?? 'system browser transport 不依赖专用 Chrome 或 CDP，但仍需要当前浏览器的只读能力。',
          exit: BLOCKED,
        });
      }
      return tellUser({
        speak: '报销专用浏览器空间还没有准备好。请先按环境准备提示完成设置，之后我会继续。',
        context: o.egoError?.message
          ?? '所有 ERP、本地页面和项目簿操作都必须复用同一个 ego task space。',
        exit: BLOCKED,
      });

    case 'env_not_logged_in':
      return tellUser({
        speak: '请在报销系统中使用本人账号登录。登录完成后告诉我，我会继续。',
        context: 'ERP 的登录页和主控制台是同一个网址，所以我按页面上有没有登录表单来判断。'
          + '另外登录页上也读得出你上次登录的账号，那不算已登录。',
      });

    case 'env_identity_unknown':
      if (systemBrowser && o.probe?.status === 'no_tab') {
        return run(argvFor('browser-open', '--url', ERP_ENTRY), {
          speak: '我还没有找到报销系统页面。请先打开报销系统并使用本人账号登录，完成后告诉我。',
          context: 'browser-open 只调用操作系统默认 URL 打开方式，不启动专用 Chrome、CDP 或其他测试浏览器。'
            + '打开页面和读出当前登录身份是两件事，读不出来时我会明确报告能力或权限问题。',
        });
      }
      if (systemBrowser && (o.browserReadError
        || ['browser_read_unavailable', 'read_unavailable'].includes(o.probe?.status))) {
        const reason = o.browserReadError?.message ?? o.probe?.hint;
        return tellUser({
          speak: '暂时无法确认报销系统当前登录身份。请按提示恢复浏览器权限后再试。',
          context: reason
            ?? '当前浏览器拒绝了只读 AppleEvents 能力，或系统不支持所需的浏览器读取接口。',
        });
      }
      return tellUser({
        speak: '暂时无法确认报销系统当前登录的是谁。请检查登录页面，完成后告诉我。身份未确认前不会继续。',
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
        speak: '当前登录身份还没有登记。请核对身份表；确认是本人后在当前会话中回复「确认」。如果不是，请先在报销系统切换到本人账号。',
        context: '绑定判据是登录账号加账套，不含显示名 —— 显示名在 ERP 里改得动，'
          + '拿它当门栓等于把门栓拴在别人能拧的东西上。表里的每个值都是我自己从 ERP '
          + '读出来的，我不接受口述的账号；记下之后这台机器就只替这个身份报销。',
        progress: IDENTITY_PROGRESS,
        exit: 0,
        // 凭据钉在**这一份身份**上。回传时内核会重新读一次 ERP，读出来的人
        // 和你刚才看过的这一个对不上，这次点头当场作废 —— 你认的永远只是你看过的那一个。
        stepMeta: { account: id.account ?? null, tenant: id.tenant ?? null },
      };
    }

    case 'env_identity_mismatched':
      return tellUser({
        speak: '当前登录身份与已登记的报销人不一致。请在报销系统切换回本人账号；已有报销不能中途更换报销人。',
        context: '判据是登录账号加账套。换账套等于换一整套主数据，也算换了人。'
          + '中途换人会把一份报销记在两个人头上，所以这里是硬阻塞。',
        exit: BLOCKED,
      });

    case 'home_city_required': {
      const id = o.probe?.identity ?? {};
      const taskId = o.task?.taskId ?? null;
      const suggestedHomeCity = validHomeCity(o.homeCitySuggestion)
        ? o.homeCitySuggestion.trim() : null;
      const prompt = suggestedHomeCity
        ? `我检测到你当前所在城市可能是${suggestedHomeCity}。若它是你的常驻城市，请在当前会话中回复「确认」；`
          + '如果不是，请直接输入你的常驻城市名称。输入后会直接继续。'
        : '请直接填写你的常驻城市名称（例如：广州市）。输入后会直接继续。';
      return {
        step: {
          kind: 'ask_user',
          prompt,
          questions: [{ id: 'homeCity', question: '你的常驻城市是哪里？请直接填写城市名称。' }],
          answersPath: o.homeCityAnswerPath ?? homeCityAnswerIn(),
          answersFormat: { homeCity: suggestedHomeCity
            ? '用户回复「确认」时填写 suggestedHomeCity；否则填写用户直接提供的城市名称'
            : '用户本人直接填写的城市名称' },
          ...(suggestedHomeCity ? { suggestedHomeCity } : {}),
          outsourceable: false,
        },
        speak: suggestedHomeCity
          ? `开始前请确认常驻城市：如果是${suggestedHomeCity}，请在当前会话中回复「确认」；如果不是，请直接输入你的常驻城市。`
          : '开始前请直接输入你的常驻城市。之后新建报销会沿用这个设置，已经开始的报销不会被后来修改的设置改变。',
        context: '常驻城市只用于按材料上的费用发生城市推导本地或外地市内交通，不能从发票或行程单猜。'
          + `当前确认身份是 ${id.account ?? '（账号未知）'} / ${id.tenant ?? '（账套未知）'}。`,
        progress: IDENTITY_PROGRESS,
        exit: 0,
        stepMeta: { account: id.account ?? null, tenant: id.tenant ?? null, taskId,
          suggestedHomeCity },
      };
    }

    case 'profile_confirmation': {
      const id = o.probe?.identity ?? o.binding ?? {};
      const homeCity = o.employeeHomeCity ?? o.homeCity ?? null;
      return {
        step: {
          kind: 'ask_user',
          prompt: `${profileTable(id, homeCity)}\n请核对以上信息。无误请在当前会话中回复「确认」；常驻城市不正确时，直接输入新的城市名称。`,
          questions: [{ id: 'homeCity', question: '回复「确认」或直接填写新的常驻城市。' }],
          answersPath: o.homeCityAnswerPath ?? homeCityAnswerIn(),
          answersFormat: { homeCity: '用户回复「确认」或直接填写新的常驻城市名称' },
          outsourceable: false,
        },
        speak: `请确认本次报销信息：报销人是${id.displayName ?? id.account ?? '当前登录用户'}，常驻城市是${homeCity ?? '（未设置）'}。无误请在当前会话中回复「确认」；城市不正确时请直接输入新的城市名称。`,
        context: '这一步发生在创建新任务之前。回复新的城市会覆盖员工默认值，当前新任务会使用最新城市；已经开始的任务仍保留创建时的城市快照。',
        progress: IDENTITY_PROGRESS,
        exit: 0,
        stepMeta: { account: id.account ?? null, tenant: id.tenant ?? null, homeCity },
      };
    }

    // —— 材料这一段 ——

    case 'task_none':
      return run(argvFor('intake', '--dir', o.sourceDir), {
        speak: '我正在整理这批报销材料：确认材料数量、格式和是否可读取。整理过程中不会移动或删除原文件。',
        context: '盘点会给这批材料建一个报销任务，并按"每份材料的路径 + 内容哈希 + 大小"'
          + '算出一个版本号。后面每一步都挂在这个版本上，材料一动版本就变。',
        progress: MATERIAL_PROGRESS,
      });

    case 'inventory_stale':
      return run(argvFor('intake', '--dir', o.sourceDir), {
        speak: `${label} 的材料有变化。我会重新整理后继续，避免沿用旧内容。`,
        context: '这是内核自己比出来的：每次问"下一步做什么"都重新走一遍目录、重算内容哈希，'
          + '和任务上记的版本号一比就知道。不靠谁记得说一声。',
        progress: MATERIAL_PROGRESS,
      });

    case 'pdf_markdown_conversion_required': {
      const response = run(argvFor('markdown-convert', '--dir', o.sourceDir), {
        speak: '我正在整理 PDF 材料，确认每份材料的内容后再继续。',
        context: `转换器固定为 MarkItDown ${MARKITDOWN_VERSION}，运行时必须用锁定依赖；缺运行时、空结果或转换失败都会停住。`
          + '原 PDF 不改，artifact 会按当前材料 hash 绑定。',
        progress: MATERIAL_PROGRESS,
      });
      return { ...response, step: { ...response.step,
        schemaPath: PDF_MARKDOWN_SCHEMA_PATH,
        materials: blockedBy.map((item) => ({ materialId: item.materialId, fileName: item.fileName,
          relPath: item.relPath ?? null,
          sourcePath: item.relPath ? path.join(o.sourceDir, item.relPath) : null,
          contentHash: item.contentHash ?? null, artifactPath: item.artifactPath ?? null,
          markdownPath: item.markdownPath ?? null, numberedMarkdownPath: item.numberedMarkdownPath ?? null,
          templatePath: item.templatePath ?? null })),
      } };
    }

    case 'pdf_markdown_conversion_empty':
      return tellUser({
        speak: '这份 PDF 没有可读取的内容。请提供电子发票原件或能正常读取文字的 PDF。',
        context: '空 Markdown 没有票种、金额或日期证据。替换原件后材料 hash 会变化，内核会重新生成工单。',
        progress: MATERIAL_PROGRESS,
      });

    case 'pdf_markdown_conversion_failed': {
      const response = run(argvFor('markdown-convert', '--dir', o.sourceDir), {
        speak: '这份 PDF 暂时无法读取。请更换文件或修复后重试；在读取成功前不会继续。',
        context: '转换失败不会被当成空文本或已解析；当前错误来自锁定的 MarkItDown '
          + MARKITDOWN_VERSION + ' 运行时。',
        progress: MATERIAL_PROGRESS,
      });
      return { ...response, step: { ...response.step,
        materials: blockedBy.map((item) => ({ materialId: item.materialId, fileName: item.fileName,
          relPath: item.relPath ?? null,
          sourcePath: item.relPath ? path.join(o.sourceDir, item.relPath) : null,
          artifactPath: item.artifactPath ?? null, error: item.error ?? null })),
      } };
    }

    case 'pdf_markdown_candidate_required':
    case 'pdf_markdown_candidate_review': {
      return readMarkdown({
        materials: blockedBy.map((item) => ({ materialId: item.materialId, fileName: item.fileName,
          relPath: item.relPath ?? null,
          artifactPath: item.artifactPath ?? null, markdownPath: item.markdownPath ?? null,
          numberedMarkdownPath: item.numberedMarkdownPath ?? null, templatePath: item.templatePath ?? null,
          candidatePath: item.candidatePath ?? null, candidateRecordPath: item.candidateRecordPath ?? null,
          markdownHash: item.markdownHash ?? null, issue: item.hint ?? null })),
        argv: argvFor('markdown-ingest', '--dir', o.sourceDir),
        speak: '我正在逐份核对 PDF 内容；核对完成前不会生成费用明细。',
        context: 'candidatePath 只能由带编号 Markdown 和 templatePath 产生；source、materialId、PDF hash、'
          + 'Markdown hash 都由内核校验，候选不能伪装成 kernel 或视觉事实。',
      });
    }

    case 'intake_open_items': {
      // 这里报的不只是盘点那一层的待办：分流、事件划分、费用类别推导报上来的
      // 拦路项也走这个出口 —— 它们的收场都在用户那一侧，措辞因此不能写死成
      // "我重新盘一遍材料"，那对一条"这张合并发票拆不出来"是答非所问。
      const openItems = blockedBy.filter((b) => b.blocking);
      const table = itemTable(openItems);
      return tellUser({
        speak: `${label} 还有 ${openItems.length} 项需要处理：\n`
          + `${table}\n`
          + (openItems.some((item) => item.kind === 'multi_page_invoice')
            ? '多页发票不在 V1 支持范围内，请把它从本次报销中排除，或替换为单页发票。\n'
            : '')
          + '处理完成后告诉我，我会重新核对。',
        table,
        context: '这些是盘点和解析报上来的开放项。我不会替你把它们当作不存在 ——'
          + '带着读不出、认不出的材料往下走，等于把问题推到 ERP 那一头去暴露。'
          + (blockedBy.some((b) => !b.blocking)
            ? '另外还有几条不拦路的，一并记在 blockedBy 里。'
            : ''),
        progress: MATERIAL_PROGRESS,
      });
    }

    case 'classify_pending':
      return run(argvFor('classify', '--dir', o.sourceDir), {
        speak: '材料已经盘点完成，我正在按报销用途整理每份材料。',
        context: '分类结果挂在当前这个盘点版本上，落进任务工作区。材料一变，'
          + '这一版分类就不再代表现在的材料，得重来。',
        progress: MATERIAL_PROGRESS,
      });

    case 'image_awaiting_reading': {
      if (imageAdapterOf(o) === IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED) {
        return extractImages({
          images,
          workspace: o.task.workspace,
          readingsPath,
          argv: submitArgv(),
          speak: `${label} 里有 ${images.length} 张图片材料需要读取：${imageNames}。我先用 OCR 批量提取，缺字段再交给模型视觉。`,
          context: '当前图片 Adapter 是 ocr-assisted：OCR 只产生候选，缺字段或校验失败的材料自动交给模型视觉。'
            + '两条路径都先进入候选，最后在整张 ERP 明细清单中统一核对。',
        });
      }
      return readImages({
        images,
        readingsPath,
        argv: submitArgv(),
        speak: `${label} 中有 ${images.length} 张图片需要读取：${imageNames}。我正在处理。`,
        context: '当前图片 Adapter 是 vision-direct：模型直接读取原图并产生候选。候选先进入分类，'
          + '不在单张材料完成后打断用户；最终 ERP 明细清单会统一核对。',
      });
    }

    case 'reading_rejected': {
      // 驳回的处置永远是**重读**，不是把数字改到过关。守恒式不平是一个正常结果：
      // 要么再看一遍看清楚，要么老实说这个字段读不出来 —— 内核不接受第三种收场。
      const why = images.flatMap((i) => (i.rejection?.reasons ?? []).map((r) => `${i.fileName}：${r}`));
      return readImages({
        images,
        readingsPath,
        argv: submitArgv(),
        speak: '上次读取的结果需要重新核对，我会重新检查这些图片：\n'
          + `${why.map((w, n) => `${n + 1}. ${sanitizeUserText(w)}`).join('\n')}`,
        context: '过不了就重读，或者老实说这个字段读不出来 —— 我不会去调整某一位数字把式子凑平。'
          + '凑平的那个数字看起来最像对的，实际上是这条链子上唯一一个没有来源的值。',
      });
    }

    case 'reading_stale': {
      const speak = `${imageNames || '图片材料'} 已经发生变化，之前的读取结果不能继续使用。我会重新处理。`;
      const context = '读数钉在内容哈希上。文件一改，旧读数当场失效 ——'
        + '沿用它等于拿上一张图的数字去报这一张图。'
        + (imageAdapterOf(o) === IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED
          ? '当前 Adapter 是 ocr-assisted，OCR 仍只产生候选，缺字段自动交给模型视觉。'
          : '当前 Adapter 是 vision-direct，候选会进入分类，最后在整单 ERP 明细清单中统一核对。');
      if (imageAdapterOf(o) === IMAGE_RECOGNITION_ADAPTERS.OCR_ASSISTED) {
        return extractImages({ images, workspace: o.task.workspace, readingsPath,
          argv: submitArgv(), speak, context });
      }
      return readImages({ images, readingsPath, argv: submitArgv(), speak, context });
    }

    case 'reading_awaiting_confirmation': {
      const pending = o.pendingReadings ?? [];
      // 刚从争议里收场回来的那几份，收场的说法跟着这张表一起摆出来。
      // 不说的话，用户会在表上看见一个和他上次说的不一样（或者一样）的值，
      // 却不知道中间那次独立重读读出了什么 —— 而那正是他这次点头的依据。
      const settled = pending.flatMap((p) => (p.disputeResolution?.fields ?? []).map((f) =>
        `· ${p.fileName}：${convergenceLine(f)}`));
      const settledSpeak = settled.length
        ? `先说刚才那几处争议是怎么收的：\n${settled.join('\n')}\n`
        : '';
      return confirmTable({
        table: readingTable(pending),
        materialIds: pending.map((p) => p.materialId),
        correctionPath,
        speak: settledSpeak
          + `图已读完。下面是${pending.length > 1 ? `这 ${pending.length} 张` : '这张'}图的读数，`
          + '请对照原件确认；有不一致就指出字段和值。',
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
          speak: `${d.fileName} 上的${names}存在分歧，我会重新核对这一处。\n`
            + `${evidence}\n`
            + '请你对照原件；重新核对完成后，我会请你确认最终结果。'
            + `请先处理这一处，${more}`,
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
          speak: `按你说的改完之后，这张发票上的金额不一致：不含税金额 ${g.netAmount} + 税额 ${g.taxAmount} `
            + `= ${g.sum}，而价税合计是 ${g.totalAmount}，差 ${g.delta} 元。\n`
            + '我不会替你推算缺少的金额。\n'
            + '请你对照原件把这三个数一起告诉我，或者回复看不清；'
            + '认不出的话我把这条读数整条退回待办，等你换一份看得清的原件。',
          context: '守恒式不让路：不含税金额 + 税额必须分毫不差地等于价税合计。'
            + '不平的读数不进事实链，只会落回开放项 —— 带着一个不平的数往 ERP 写，'
            + '错误会在最不该暴露的地方暴露。',
        });
      }

      // phase === 'ruling'：重读回来了，三种收敛各说各的话，最后请用户拍板。
      const lines = d.fields
        .map((f) => convergenceLine({ ...f, rereadValue: f.reread })).join('\n');
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
        speak: `${d.fileName}：重新核对的结果出来了。\n${lines}${bad}`,
        context: '重读是在一个完全不知道我们刚才争过什么的子 Agent 里做的，只读了这一个字段。'
          + '三次读数里没有哪一次天然更可信 —— 定夺的是你对着原件看到的那个值。'
          + '你定完之后这份读数还会整张再摆一次请你过目，改过的字段会标明来源是你。',
      });
    }

    case 'duplicate_blocked': {
      const hits = blockedBy.filter((b) => b.kind === 'duplicate_across_tasks');
      const table = itemTable(hits);
      return tellUser({
        speak: `${label} 暂停：发现 ${hits.length} 张重复发票，同一张发票不能报两次。\n`
          + `${table}\n`
          + '请移出本次材料，或处理之前的报销记录；完成后告诉我。',
        table,
        context: '这是拿发票身份（不是文件内容）跨任务比出来的：两个字节不同的 PDF '
          + '只要是同一张法定发票，照样算重复。命中就停整批 —— 一批材料里混着一张报过的票，'
          + '整批都得重看，而不是把那一张挑出去了事。'
          + '另外这只比对得了 baox 在本机记过的任务，直接在 ERP 里录过的查不到。',
        progress: MATERIAL_PROGRESS,
      });
    }

    case 'events_pending':
      return run(argvFor('events', '--dir', o.sourceDir), {
        speak: `${label} 的材料已经整理完成。接下来我会把它们对应到具体费用：行程、住宿和车票分别处理。`,
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
        speak: `${why}\n各段的价税合计需要你确认：加起来必须正好是 ${a.totalAmount} 元，`
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

    case 'classified_detail_confirmation': {
      const preview = o.classifiedPreview ?? { lines: o.lines ?? [], homeCity: o.homeCity ?? null };
      const materialIds = (preview.evidence ?? []).map((item) => item.materialId).filter(Boolean);
      const digest = classifiedDetailDigest(preview);
      const correctionOptions = o.classifiedCorrectionOptions ?? [];
      const correctable = correctionOptions.filter((item) => item.fields.length > 0
        || item.action === 'reextract_same_hash');
      const acceptsCorrection = correctable.length > 0;
      const derivedFacts = (preview.evidence ?? []).flatMap((item) => Object.entries(
        item.candidateSources?.fieldStatus ?? {}).filter(([, status]) => status === 'derived')
        .map(([field]) => `${item.materialId}:${field}`));
      return {
        step: {
          kind: 'confirm_table',
          table: [invoiceSummaryTable(preview), classifiedDetailTable(preview)].join('\n\n'),
          materialIds,
          homeCity: preview.homeCity ?? null,
          lineCount: preview.lines?.length ?? 0,
          candidateEvidence: (preview.evidence ?? []).filter((item) => item.source === 'agent_from_markdown'
            || item.candidateSources?.source === 'agent_from_markdown').map((item) => ({
              materialId: item.materialId,
              markdownHash: item.markdownHash ?? item.candidateSources?.markdownHash ?? null,
              fieldEvidence: item.candidateSources?.fieldEvidence ?? item.fieldEvidence ?? {},
              fieldStatus: item.candidateSources?.fieldStatus ?? item.fieldStatus ?? {},
              fieldBasis: item.candidateSources?.fieldBasis ?? {},
              segments: item.candidateSources?.segments ?? [],
            })),
          correctionPath,
          acceptsCorrection,
          ...(acceptsCorrection ? { correctionFormat: {
            corrections: correctable.map((item) => item.action === 'reextract_same_hash'
              ? { materialId: item.materialId, reextract: true }
              : { materialId: item.materialId,
                fields: Object.fromEntries(item.fields.map((field) =>
                  [field, '用户对着原件确认的值'])) }),
            note: '看图读数只写声明的字段；PDF 候选只写 reextract: true。内核会使当前候选失效，'
              + '重新校验同 hash Markdown 候选，不会直接采纳口述值。',
          } } : {}),
          outsourceable: false,
        },
        speak: `材料已经整理成 ${preview.lines?.length ?? 0} 条费用明细，常驻城市是 ${preview.homeCity ?? '（未取到）'}。`
          + '请在这张整单明细清单中一次性核对所有将填入报销系统的信息：发票/材料、发票类型、不含税金额、税额和价税合计，以及起始日期、结束日期、城市、出发点、目的地、材料关联、费用类别和费用项目；确认后进入项目选择。'
          + ((preview.evidence ?? []).some((item) => item.role === 'primary_voucher'
            && item.kind === 'rail_eticket')
            ? '铁路电子客票只核对票面总额；费用税额按业务规则默认为 0.00。'
            : '')
          + (derivedFacts.length ? '表中有根据材料整理出的信息，请一并核对。' : '')
          + (acceptsCorrection
            ? '如果材料上的字段不对，请指出对应材料和字段，我会重新核对。'
            : '如果材料上的字段不对，目前没有可重读或可重新抽取的证据；请替换原材料后重新解析，再确认。'),
        context: '这张确认表绑定材料证据、日期、金额分摊、常驻城市和费用类别；项目归属和报销事由属于下一步。'
          + '只更换项目不会让这次分类确认失效；材料、日期、分摊或费用类别变化会让确认摘要失效并重新确认。',
        progress: EVENT_PROGRESS,
        exit: 0,
        stepMeta: {
          digest,
          taskId: o.task?.taskId ?? null,
          account: o.task?.identity?.account ?? null,
          tenant: o.task?.identity?.tenant ?? null,
        },
      };
    }

    case 'project_unassigned': {
      // 项目归属仍必须由用户在本地页面提交；对话里的项目号不会直接落盘。
      const lines = o.lines ?? [];
      const missing = lines.filter((l) => !l.project);
      return run(argvFor('select-task', '--dir', o.sourceDir), {
        speak: `${label} 已经切成 ${lines.length} 条费用明细，金额和日期都对上了。`
          + `再往下还差一样东西：${missing.length === lines.length ? '每一条' : `其中 ${missing.length} 条`}`
          + '都还没有项目。请在个人项目选择页完成选择并提交，之后我会继续核对。',
        context: '项目归属是业务事实：项目号只能从当前本人项目簿里选；需要增加项目时先打开项目簿维护页。',
        progress: PROJECT_PROGRESS,
        outsourceable: false,
      });
    }

    case 'project_book_empty':
      return run(argvFor('projects-page'), {
        speak: '当前没有可用的项目。请先打开项目维护页完成设置，之后回来继续。',
        context: '项目簿按 tenant/account 隔离，维护页只允许当前身份写入；项目簿里的失效条目不会自动删除。',
        progress: PROJECT_PROGRESS,
        outsourceable: false,
      });

    case 'catalog_unverified':
      return run(argvFor('catalog', '--dir', o.sourceDir), {
        speak: '我正在核对报销系统中的项目和费用项目，确认它们可以用于本次报销。',
        context: '走的是金蝶自带的查询服务，只查这一个地址。查得通只证明主数据在目录里可以引用，'
          + '不证明它在费用明细上保存得进去 —— 后者只有真保存并回读才算数。',
        progress: CATALOG_PROGRESS,
      });

    case 'catalog_mismatch': {
      const table = itemTable(blockedBy);
      return tellUser({
        speak: `报销信息核对发现 ${blockedBy.length} 项不匹配：\n`
          + `${table}\n`
          + '请修正后告诉我，我会重新核对。',
        table,
        context: '核对判的是四件事：编码在不在、名称对不对得上、单据状态已审核、没有被禁用。'
          + '编码对得上而名称对不上时我也停 —— 那说明对照表和 ERP 已经错位，'
          + '改个名字将就过去只会把错误带进单据。',
        progress: CATALOG_PROGRESS,
        exit: BLOCKED,
      });
    }

    case 'preparation_package_pending':
      return run(argvFor('prepare', '--dir', o.sourceDir), {
        speak: `${label} 的材料已经整理完成，我正在生成本次报销的核对材料。`,
        context: 'observe 只读检查现有材料；这一步只在本地生成审阅文件，不会打开 ERP、导入发票、创建单据或保存。',
        progress: PREPARATION_PROGRESS,
      });

    case 'preparation_blocked': {
      const problems = blockedBy.length ? blockedBy : (o.preparation?.problems ?? []);
      const table = preparationProblemTable(problems);
      return tellUser({
        speak: `${label} 的核对材料已经生成，但还有 ${problems.length} 项需要补充或调整：\n`
          + `${table}\n`
          + `处理完成后告诉我，我会重新核对。${preparationPackageText(o)}`,
        table,
        context: '这一步只生成本地审阅材料，不会导入发票、填写或保存 ERP 单据。缺失铁路票面净额/税额时保留为缺失，不反算、不补零。',
        progress: PREPARATION_PROGRESS,
        exit: BLOCKED,
      });
    }

    case 'preparation_confirmation': {
      const preparation = o.preparation ?? {};
      const digest = preparation.digest ?? null;
      return {
        step: {
          kind: 'confirm_table',
          table: preparationConfirmationTable(preparation),
          digest,
          package: o.preparationPackage ?? preparation.package ?? null,
          problems: preparation.problems ?? [],
          acceptsCorrection: false,
          outsourceable: false,
        },
        speak: '本次报销的核对材料已准备好。请逐项核对发票、金额、日期、项目和常驻城市；'
          + '确认后进入下一阶段。\n'
          + preparationPackageText(o),
        context: '准备确认绑定当前材料、字段、项目候选、只读目录证据和任务版本。任一变化都会重新检查；此确认不能生成 ERP 写入授权。',
        progress: PREPARATION_PROGRESS,
        exit: 0,
        stepMeta: {
          preparationDigest: digest,
          taskId: o.task?.taskId ?? null,
          account: o.task?.identity?.account ?? null,
          tenant: o.task?.identity?.tenant ?? null,
          packageManifestHash: o.preparationPackage?.manifestHash ?? null,
          packageBundleHash: o.preparationPackage?.bundleHash ?? null,
        },
      };
    }

    case 'preparation_complete':
      return done({
        speak: '本次报销的核对材料已确认并交接。当前阶段已完成，后续处理会从这里继续。\n'
          + preparationPackageText(o),
        context: '这次确认只记录本地准备材料，不是 ERP 写入批准。材料任何变化都会使确认失效并重新检查。',
        progress: PREPARATION_PROGRESS,
      });

    case 'handed_off_recover': {
      // 只有当前已定义的 marker 有本地恢复协议。未知 marker 仍保守停在
      // 交接态，但不能把它伪装成可以执行的恢复命令。
      if (o.task?.erpWriteState !== 'upload_dispatched') {
        return handoff({
          skill: 'baox-recover',
          speak: '当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。',
          context: '未知 ERP 写入标记必须保守交接，不能猜测其含义，也不能再次上传、保存或重置任务。',
          progress: WRITE_PROGRESS,
        });
      }
      return run(argvFor('resume-local-preparation', '--dir', o.sourceDir), {
        speak: '当前报销需要先完成一次人工核对。材料和状态已保留，核对完成后我会从当前进度继续。',
        context: '恢复凭据会核对当前身份、任务材料版本、每张票的完整发票号、收票单号、金额，'
          + '以及唯一的空白新增单。它只允许常驻城市、分类、项目和写入预览准备，ERP 写入闸仍然关闭。',
        progress: WRITE_PROGRESS,
        outsourceable: false,
      });
    }

    case 'recovery_write_blocked':
      return tellUser({
        speak: '当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。',
        context: '恢复凭据的能力闭集只有常驻城市、事件、分类、个人项目选择和写入预览准备；'
          + '它不能把旧任务变成新的可写任务。',
        progress: WRITE_PROGRESS,
        exit: BLOCKED,
      });

    case 'env_ready':
      return done({
        speak: `环境准备完成${who ? `，当前报销人是 ${who}` : ''}。接下来可以开始整理报销材料。`,
        context: '这一步之后不需要你再打开任何浏览器页面，除非要改绑身份或者浏览项目目录。',
      });

    default:
      // 状态落成了却没给它写 step，是内核自己的 bug，不能装作没看见。
      throw new Error(`状态 ${state} 还没有对应的 step`);
  }
}

/** Add the stable employee interaction metadata after the state-specific step is shaped. */
export function stepFor(state, observation = {}, blockedBy = []) {
  return decorateStep(state, rawStepFor(state, observation, blockedBy));
}

/**
 * 一次 `next` 的完整应答：观测 -> 状态 -> step，中间过一道凭据核对。
 *
 * 状态永远来自**这一次的观测**，不来自模型的自述：模型说「做完了」不推进状态，
 * 推进的依据是内核自己看得见的事实。所以 `--result` 在这里不被解读，
 * 它只是「你确实跑了那条命令」的凭证。
 */
export function nextResponse({ observation, sourceKey, after = null, hasResult = false,
  resultPath = null, hasCorrection = false }) {
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
    } else if (outstanding.state === (shaped.stepKey ?? verdict.state)
      && shaped.step.out && resultPath
      && path.resolve(resultPath) !== path.resolve(shaped.step.out)) {
      ignored = { reason: 'wrong_result_path',
        note: '这一步只接收内核发出的 step.out，其他文件不能作为安装结果' };
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
    observation.sourceDir ?? null, shaped.stepMeta ?? null, shaped.step?.argv ?? null,
    shaped.step?.out ?? null);
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
    interaction: shaped.interaction,
    actor: verdict.actor,
    stepToken: record.token,
    step: shaped.step,
    speak: shaped.speak,
    context: sanitizeUserText(shaped.context),
    blockedBy: verdict.blockedBy,
    ...(observation.recovery ? { recovery: observation.recovery } : {}),
    ...(observation.preparation ? {
      preparation: {
        digest: observation.preparation.digest ?? null,
        ready: observation.preparation.ready === true,
        problems: observation.preparation.problems ?? [],
        confirmed: observation.preparationConfirmed === true,
        packageCurrent: observation.preparationPackageCurrent === true,
        packageProblems: observation.preparationInspection?.problems ?? [],
        package: observation.preparationPackage ?? observation.preparation.package ?? null,
      },
    } : {}),
    ...(ignored ? { ignored } : {}),
    exit: shaped.exit,
  };
}
