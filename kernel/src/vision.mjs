import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';
import { shapeOfBuffer, shapeMatches, SHAPES, SHAPE_LABELS } from './imageshape.mjs';

// 图片材料的读取协议。
//
// 图片默认由模型视觉直接读取；明确选择 ocr-assisted 时，先由受管本地 OCR
// 产生文字观测和字段候选，证据不足时再由模型视觉重读。
//
// 但读不等于判。这里的整个设计就是为了让"模型读了一眼"不至于变成"模型说了算"：
//
//   1. 读取对象是**在册材料**：有材料标识、有内容哈希、属于某个盘点版本。
//      读数必须带上内容哈希，内核会重新算一遍；对不上就作废。
//      这让一次读取永远指向一个确定的字节序列，文件一改读数自动失效。
//   2. 读数要带**看过的凭据**：这张图的形状档（见 imageshape.mjs）。内核从字节里
//      算得出准确答案，看着图的人一眼就知道，没打开过的猜不中。0.9.2 那次
//      "一张没看就说图片显示不出来"，在这里变成机制上过不去 —— 说"看不清"
//      也要先答对形状，因为看不清说的是"看着的图上认不出这个字段"。
//   3. 读数只能是**逐字抄写**。模型不得计算、推断、补全，看不清必须说看不清。
//   4. 内核**结构校验**：位数、日期、金额守恒。这些是模型控制不了的算术，
//      编出来的号码和金额过不了。守恒不平是一个**正常结果** —— 处置是重读，
//      或者判定这个字段读不出，绝不是把某一位数字改到平。
//   5. 校验通过也只是**字段候选**，不是已解析值。必须由用户在最终整单明细表上确认。
//      确认由"用户就着那张表点头、模型带着一次性凭据回传"构成 ——
//      聊天里的"对的""没问题"不构成确认。
//
// 换句话说：材料仍然是证据，模型只是读它的人，内核和用户是两道闸。

export const READING_VERSION = 1;

export const IMAGE_RECOGNITION_ADAPTERS = Object.freeze({
  VISION_DIRECT: 'vision-direct',
  OCR_ASSISTED: 'ocr-assisted',
});

export const DEFAULT_IMAGE_RECOGNITION_ADAPTER = IMAGE_RECOGNITION_ADAPTERS.VISION_DIRECT;

/**
 * 连着答错几次「看过的凭据」就不再让模型重试。
 *
 * 一次答错是看走眼，接连答错是在试 —— 五个档位轮着交，早晚会撞对一次，
 * 而撞对的那一次和真看过的那一次在内核眼里一模一样。所以次数本身要成为证据：
 * 到了上限，这张图就从「模型再读一遍」变成一条摆给用户的开放项。
 */
export const MAX_SIGHT_FAILURES = 3;

/**
 * 连着交几份「一个字段都没有」的读数，就不再让模型重试。
 *
 * 空读数不是一个正当的答案，哪怕它把每个字段都老老实实写进了 `unreadable`：
 * 内核这一侧已经确认这张图是完好的（解得开图像头、量得出尺寸），一张完好的票
 * 上整整一屏字**一个都认不出**，几乎只有一种解释 —— 这次读取根本没有看到图。
 *
 * 真机 QA（2026-09-07）里就是这样：跑这套流程的模型看不见 `Read` 交回来的图片，
 * 于是转头去敲 `file`、`mdls`、`tesseract`、`swift` 找外部识图工具，
 * 拿元数据凑出"看过的凭据"，字段全填 `unreadable` 交上来 —— 而内核收下了它，
 * 用户于是在确认表上看到一张什么都没有的表。
 *
 * 一次驳回是"再看一遍"；接连两次就不再是模型的事了，它变成一条摆给用户的开放项：
 * 这个模型读不了图，换一个有视觉能力的模型，或者补一份 PDF 原件。
 */
export const MAX_EMPTY_READINGS = 2;

/** 图片可能是什么。闭集：模型不能自己发明一个类型。 */
export const DOC_TYPES = {
  invoice: { role: 'primary_voucher', label: '发票', needsIdentity: true },
  rail_ticket: { role: 'primary_voucher', label: '铁路客票', needsIdentity: true },
  road_passenger_ticket: { role: 'primary_voucher', label: '道路客票', needsIdentity: true },
  ride_itinerary: { role: 'reference', label: '网约车行程单', needsIdentity: false },
  hotel_folio: { role: 'reference', label: '酒店结账单', needsIdentity: false },
  payment_slip: { role: 'reference', label: '支付水单/付款凭证', needsIdentity: false },
  other: { role: null, label: '其他', needsIdentity: false },
  unreadable: { role: null, label: '看不清', needsIdentity: false },
};

/** 允许回报的字段。不在这张表里的键一律拒收 —— 不给自由发挥留缝。 */
const FIELD_RULES = {
  invoiceNumber: { label: '发票号码', test: (v) => /^\d{20}$/.test(v), hint: '20 位数字' },
  issueDate: { label: '开票日期', test: isDate, hint: 'YYYY-MM-DD' },
  netAmount: { label: '不含税金额', test: isMoney, hint: '金额，两位小数' },
  taxAmount: { label: '税额', test: isMoney, hint: '金额，两位小数' },
  totalAmount: { label: '价税合计', test: isMoney, hint: '金额，两位小数' },
  sellerName: { label: '销售方', test: isText, hint: '票面上的销售方名称' },
  buyerName: { label: '购买方', test: isText, hint: '票面上的购买方名称' },
  itemName: { label: '项目名称', test: isText, hint: '票面上的项目名称' },
  city: { label: '城市', test: isText, hint: '票面或单据上写明的城市' },
  travelDate: { label: '行程日期', test: isDate, hint: 'YYYY-MM-DD' },
  origin: { label: '起点', test: isText, hint: '起点' },
  destination: { label: '终点', test: isText, hint: '终点' },
  travelTime: { label: '行程时间', test: (v) => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v), hint: 'HH:MM' },
  traveler: { label: '出行人', test: isText, hint: '票面上的出行人' },
  trainNumber: { label: '车次', test: isText, hint: '车次' },
  seat: { label: '席别', test: isText, hint: '席别或座位' },
  hotelName: { label: '酒店', test: isText, hint: '酒店名称' },
  guestName: { label: '入住人', test: isText, hint: '入住人' },
  checkIn: { label: '入住日期', test: isDate, hint: 'YYYY-MM-DD' },
  checkOut: { label: '离店日期', test: isDate, hint: 'YYYY-MM-DD' },
  folioTotal: { label: '结账合计', test: isMoney, hint: '金额，两位小数' },
  payer: { label: '付款方', test: isText, hint: '付款方' },
  payee: { label: '收款方', test: isText, hint: '收款方' },
  paidAt: { label: '支付时间', test: isText, hint: '票面支付时间' },
  transactionNumber: { label: '交易号', test: isText, hint: '票面交易号' },
  title: { label: '标题', test: isText, hint: '凭证标题' },
  merchant: { label: '商户', test: isText, hint: '商户名称' },
};

export const INVOICE_BUSINESS_FIELDS = Object.freeze([
  'netAmount', 'taxAmount', 'totalAmount',
]);

export const INVOICE_READING_FIELDS = Object.freeze([
  'invoiceNumber', ...INVOICE_BUSINESS_FIELDS,
]);

/** 行程单逐段读数。和普通字段分开闭集，避免其他材料借 `segments` 塞任意结构。 */
export const SEGMENT_RULES = {
  travelDate: { label: '行程日期', test: isDate, hint: 'YYYY-MM-DD', required: true },
  city: { label: '城市', test: isText, hint: '票面写明的城市', required: false },
  origin: { label: '起点', test: isText, hint: '票面写明的起点', required: true },
  destination: { label: '终点', test: isText, hint: '票面写明的终点', required: true },
  amount: { label: '金额', test: isPositiveMoney, hint: '正数金额，两位小数', required: false },
};

/** 字段的中文名。表格给用户看，键名不给用户看。 */
export const FIELD_LABELS = Object.fromEntries(
  Object.entries(FIELD_RULES).map(([k, v]) => [k, v.label]));

function isMoney(v) { return typeof v === 'string' && /^-?\d{1,9}\.\d{2}$/.test(v); }
function isPositiveMoney(v) { return typeof v === 'string' && /^\d{1,9}\.\d{2}$/.test(v) && Number(v) > 0; }
function isText(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= 120; }
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || !v.startsWith(String(d.getUTCFullYear()))) return false;
  // 明天以后的开票日期一定是读错了；十年前的也不该出现在报销材料里。
  const now = Date.now();
  return d.getTime() < now + 36 * 3600 * 1000 && d.getTime() > now - 10 * 365 * 24 * 3600 * 1000;
}

export const cents = (s) => Math.round(Number(s) * 100);

/**
 * 字段的规则表对外开放（争议那一层要拿它校验用户口述的值）。
 * 用户给的值和模型抄的值走**同一道格式闸** —— 换一道宽一点的闸给人用，
 * 等于承认「人说的不用查」，而这一整票的前提正是两边都可能错。
 */
export { FIELD_RULES };

/**
 * 这个值过不过得了这个字段的格式闸。过得了就是 `null`，过不了就是那句话。
 *
 * 三个地方要问同一个问题：模型抄的读数、争议里的独立重读、用户口述的终值。
 * 抄三遍的话，哪天放宽某一条规则（比如金额允许三位小数），漏改的那一处
 * 会变成一条**只对某一类来源成立**的规矩 —— 而那正是这一整套设计不允许的：
 * 值的来源不同，闸必须一样。
 *
 * `byLabel` 只改称呼：对模型说键名（它填的是 JSON），对用户说中文名。
 */
export function fieldComplaint(key, value, { byLabel = false } = {}) {
  const rule = FIELD_RULES[key];
  const name = byLabel ? (FIELD_LABELS[key] ?? key) : key;
  if (!rule) return `不认识的字段 ${name}`;
  if (!rule.test(value)) return `${name} 的格式不对（要求：${rule.hint}）`;
  return null;
}

/**
 * 清晰度。模型抄下一个字段时顺带说一句它当时看得清不清楚 ——
 * 争议那一步要把这句话摆给用户：「我读到 10，但我当时就觉得这一位发虚」
 * 和「我读到 10，看得清清楚楚」，是两种完全不同的证据。
 *
 * 闭集，且**可选**：#62 之前交上来的读数没有这一栏，那时候没人问过。
 * 缺席时争议那一层会明说是内核替它推的，不冒充成模型当时的判断。
 */
export const CLARITY = { clear: '清楚', blurry: '发虚，但认得出' };
export const CLARITY_UNSTATED = '模型当时没说清不清楚（内核不替它补一个判断）';
const readingsDir = (task) => path.join(taskDir(task), 'readings');
const readingFile = (task, materialId) => path.join(readingsDir(task), `${materialId}.json`);
/**
 * 被驳回的那一次读取也要落盘。
 *
 * 不落盘的话，下一次 `next` 看到的只是"这张图还没读"，于是内核会再发一遍
 * 一模一样的指令，一个字都不提上次为什么没过 —— 模型只好照原样再读一遍，
 * 再被驳回一次。**驳回的理由是下一次读取唯一有用的输入**，它得活到下一次。
 */
const rejectionFile = (task, materialId) => path.join(readingsDir(task), `${materialId}.rejected.json`);

/**
 * 生成读取工单：哪些材料需要看图，每份要回报什么。
 * `absPath` 只在这一次输出里出现（模型需要它才能打开文件），不写进任何产物。
 */
export function buildWorkOrder(sourceDir, inventory, classification, task, { force = false } = {}) {
  const root = path.resolve(sourceDir);
  const items = [];
  for (const r of classification.results) {
    const m = inventory.materials.find((x) => x.materialId === r.materialId);
    if (!m) continue;
    // 已确认的读数会被投影成 parsed，正常就不再出现在工单里。
    // `force` 是给"读过了但漏了后面才需要的字段"准备的重读入口。
    const isImage = m.format === 'png' || m.format === 'jpg';
    if (r.parseStatus !== 'needs_ocr' && !(force && isImage)) continue;
    // 内核自己都解不开的图不派给模型看：那是材料的问题，模型看多少遍都一样。
    if (r.imageDecodable === false) continue;
    const existing = loadReading(task, r.materialId);
    const rejection = loadRejection(task, r.materialId);
    const freshRejection = rejection && rejection.contentHash === m.contentHash;
    // 连着答不出「看过的凭据」的那几张也不再派出去：再读一遍只是再试一次。
    if (freshRejection && (rejection.sightFailures ?? 0) >= MAX_SIGHT_FAILURES) continue;
    // 连着交空读数的那几张同样不再派出去。到这一步它已经不是"再读一遍"能解的事：
    // 多半是这一侧根本看不见图，而那要换模型或者换材料，只有人做得到。
    if (freshRejection && (rejection.emptyReadings ?? 0) >= MAX_EMPTY_READINGS) continue;
    // 争议中的那几张不进普通工单。它们不是「还没读」—— 读过了，两边对不上，
    // 处置是**只重读那一个字段**（干净上下文，见 dispute.mjs），不是从头再抄一遍整张票。
    // 混进工单的话，模型会带着刚吵完的那段上下文重读一整张，第二次读数也就不独立了。
    if (freshRejection && (rejection.disputed?.length ?? 0) > 0) continue;
    // 争议收不了场、用户也认不出的那几张：整条读数已经退回待办，等的是人换一份原件。
    const parked = loadUnreadable(task, r.materialId);
    if (parked && parked.contentHash === m.contentHash) continue;
    items.push({
      materialId: m.materialId,
      fileName: m.fileName,
      absPath: path.join(root, m.relPath),
      contentHash: m.contentHash,
      format: m.format,
      // 同一份字节已经读过就不用再读；文件改过则旧读数已失效，要重读。
      alreadyRead: !!existing && existing.contentHash === m.contentHash,
      confirmed: !!existing && existing.contentHash === m.contentHash && !!existing.confirmedAt,
      // 上一次为什么没过。跟着字节走：图换过了，上次的理由也就无从谈起。
      rejection: rejection && rejection.contentHash === m.contentHash
        ? { reasons: rejection.reasons, rejectedAt: rejection.rejectedAt }
        : null,
    });
  }
  return items;
}

/**
 * 校验并存下一次读取。返回每份材料的裁决。
 * 这里只判**结构**：位数、日期、金额守恒。内容对不对由用户确认那一步兜底。
 */
export function ingestReadings(sourceDir, inventory, task, submission) {
  if (!submission || submission.version !== READING_VERSION) {
    const e = new Error(`读数格式版本不对，期望 ${READING_VERSION}`);
    e.code = 'BAD_SUBMISSION';
    throw e;
  }
  const root = path.resolve(sourceDir);
  const verdicts = [];

  for (const raw of submission.readings ?? []) {
    const m = inventory.materials.find((x) => x.materialId === raw.materialId);
    if (!m) { verdicts.push({ materialId: raw.materialId, verdict: 'rejected', reasons: ['本次盘点版本里没有这份材料'] }); continue; }

    const reasons = [];

    // 内容哈希是这次读取和那串字节之间的绑定。重新算一遍，不信提交上来的值。
    const bytes = fs.readFileSync(path.join(root, m.relPath));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (raw.contentHash !== actual) {
      reasons.push('读数携带的内容哈希与材料当前内容不一致，这次读取已作废，请重新看图');
    }

    // 看过的凭据。这一条排在所有字段校验前面，因为它决定的是**这次读取算不算数**：
    // 一份没看过图的读数，里面的字段对不对都没有意义。
    const ocrSource = raw.source === 'ocr';
    const shape = shapeOfBuffer(bytes);
    let sightFailed = false;
    if (!shape) {
      // 内核自己都解不开这张图 —— 那是材料的问题，不是模型的说法，也不该让模型去看。
      // 正常情况下分类那一层已经把它拦成开放项了，走到这里说明材料刚刚被换掉。
      reasons.push('内核解不开这个文件的图像头，它不是一张完整的 png / jpg；'
        + '这不是"看不清"，是这份材料本身要换');
    } else if (!ocrSource && !shapeMatches(shape.width, shape.height, raw.sighted?.shape)) {
      sightFailed = true;
      // 故意不回报正解，也不说错在哪一边：这是一道凭据，不是一道有反馈的题。
      // 把差在哪里说清楚，等于把五选一变成三选一，几个回合就蒙对了。
      reasons.push('sighted.shape 和这张图对不上 —— 它是"你正看着的这张图长什么样"，'
        + '不是从文件名或者上下文推得出来的东西。答不上就说明这张图没有真的打开过：'
        + '请用 Read 工具打开它，看着它再读一遍。');
    }

    const type = DOC_TYPES[raw.docType];
    if (!type) reasons.push(`docType 必须是这几个之一：${Object.keys(DOC_TYPES).join('、')}`);

    const fields = {};
    const invoiceFields = raw.docType === 'invoice' ? new Set(INVOICE_READING_FIELDS) : null;
    const unreadable = Array.isArray(raw.unreadable) ? raw.unreadable.filter((k) => typeof k === 'string') : [];
    for (const field of unreadable) {
      if (invoiceFields && !invoiceFields.has(field)) {
        reasons.push(`发票读数只允许隐藏身份和三项金额，不能回报 ${field}`);
      }
    }
    // 清晰度：模型抄这个字段时看得清不清楚。可选，但给了就得是闭集里的档位 ——
    // 自由发挥的形容词（"还行"、"一般"）在争议那一步摆给用户看时说明不了任何事。
    const clarity = {};
    for (const [k, v] of Object.entries(raw.clarity ?? {})) {
      if (!(k in FIELD_RULES)) { reasons.push(`clarity 里有不认识的字段 ${k}`); continue; }
      if (invoiceFields && !invoiceFields.has(k)) {
        reasons.push(`发票读数只允许隐藏身份和三项金额，不能回报 clarity.${k}`);
        continue;
      }
      if (!(v in CLARITY)) { reasons.push(`clarity.${k} 只能是：${Object.keys(CLARITY).join(' / ')}`); continue; }
      clarity[k] = v;
    }
    for (const [k, v] of Object.entries(raw.fields ?? {})) {
      if (invoiceFields && !invoiceFields.has(k)) {
        reasons.push(`发票读数只允许隐藏身份和三项金额，不能回报 fields.${k}`);
        continue;
      }
      const complaint = fieldComplaint(k, v);
      if (complaint) { reasons.push(complaint); continue; }
      fields[k] = v;
    }

    const segments = [];
    if (raw.segments !== undefined) {
      if (raw.docType !== 'ride_itinerary') {
        reasons.push('只有 ride_itinerary 可以提交 segments');
      } else if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
        reasons.push('segments 必须是非空数组');
      } else {
        for (const [i, segment] of raw.segments.entries()) {
          if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
            reasons.push(`segments[${i}] 必须是对象`);
            continue;
          }
          const before = reasons.length;
          const normalized = {};
          for (const [key, value] of Object.entries(segment)) {
            const rule = SEGMENT_RULES[key];
            if (!rule) { reasons.push(`segments[${i}] 有不认识的字段 ${key}`); continue; }
            if (!rule.test(value)) {
              reasons.push(`segments[${i}].${key} 的格式不对（要求：${rule.hint}）`);
              continue;
            }
            normalized[key] = value;
          }
          for (const [key, rule] of Object.entries(SEGMENT_RULES)) {
            if (rule.required && !(key in normalized)) reasons.push(`segments[${i}] 缺少 ${key}`);
          }
          if (reasons.length === before) segments.push(normalized);
        }
      }
    }

    // 平铺行程单只有一个整体日期，必须抄进顶层 fields 或明确列入 unreadable；
    // 多段行程的日期由每个 segments[i].travelDate 承担，不能用开票日期代替。
    if (raw.docType === 'ride_itinerary' && raw.segments === undefined
      && !fields.travelDate && !unreadable.includes('travelDate')) {
      reasons.push('平铺行程单必须回报 fields.travelDate，不能用开票日期代替行程日期');
    }

    // 一个字段都没有的读数不是读数。
    //
    // 这一条和「看不清是正当答案」不冲突，两者说的是不同的东西：`unreadable` 是
    // **这张图上的某个字段**认不出来，而整张图上一个字段都认不出，说的是这张图
    // 没有真的被看见。内核这边刚量出它的尺寸，图是好的。
    //
    // 它比「看过的凭据」更难绕：凭据是五选一，外部工具答得出来；而一张票上的字
    // 只有看见了才抄得出来，抄不出来就是没看见。
    let emptyReading = false;
    if (shape && Object.keys(fields).length === 0 && segments.length === 0) {
      emptyReading = true;
      reasons.push(`这份读数一个字段都没有。这张图在我这边是完好的（${shape.width}×${shape.height}），`
        + '一张完好的票上整屏的字一个都认不出，通常不是"看不清"，是这次读取没有真的看到图。'
        + '请用 Read 工具重新打开它，看着它抄 —— 哪怕只抄下一个金额或者一个日期，'
        + '也比整份空着强。'
        + '另外：识别这一步只能靠你自己看，file / mdls / sips / tesseract / OCR 之类的'
        + '外部工具在这里一律不算数，用它们凑出来的东西我不会收。'
        + '如果你这一侧根本显示不出图片（比如当前模型没有视觉能力），就照实说出来，'
        + '别拿工具去补 —— 那件事我会转给用户处理。');
    }

    // 发票候选必须同时具备隐藏身份和三项金额。开票日期不是报销业务字段，
    // 即使没有它也不阻断；但身份用于重复检查，三项金额用于 ERP 明细和守恒校验。
    if (raw.docType === 'invoice') {
      if (!fields.invoiceNumber) reasons.push('识别为发票但没有回报 20 位发票号码，无法做重复检查');
      for (const field of INVOICE_BUSINESS_FIELDS) {
        if (!fields[field]) reasons.push(`识别为发票但没有回报 ${FIELD_LABELS[field]}`);
      }
    }

    // 行程单靠自己的票面合计金额和发票做确定性关联。看得见就逐字抄，
    // 认不出就明确列入 unreadable，不能让它缺席后悄悄变成未关联材料。
    if (raw.docType === 'ride_itinerary'
      && !fields.totalAmount && !unreadable.includes('totalAmount')) {
      reasons.push('识别为行程单时，请把票面合计抄进 fields.totalAmount；看不清则把 totalAmount 写进 unreadable');
    }

    // 金额守恒。模型没法把编出来的数字凑平，所以这一条是最硬的一道结构闸。
    let amountCheck = null;
    if (fields.netAmount && fields.taxAmount && fields.totalAmount) {
      const ok = cents(fields.netAmount) + cents(fields.taxAmount) === cents(fields.totalAmount);
      amountCheck = ok ? 'balanced' : 'mismatch';
      if (!ok) reasons.push('不含税金额 + 税额 ≠ 价税合计；请重新逐字核对票面，不要调整数字去凑平');
    } else if (fields.totalAmount) {
      amountCheck = 'partial';
    }

    const verdict = reasons.length ? 'rejected' : 'accepted';
    if (verdict === 'rejected') {
      // 答错凭据的次数要累计。五个档位、每次可以重交，光靠一次驳回是拦不住
      // 「不看图，挨个试」的 —— 几个回合就蒙对了。累计到上限就不再是模型的事，
      // 而是一条摆给用户看的开放项：我没能证明我打开过这张图。
      const prev = loadRejection(task, m.materialId);
      const fresh = prev && prev.contentHash === actual;
      const carried = fresh ? prev.sightFailures ?? 0 : 0;
      const carriedEmpty = fresh ? prev.emptyReadings ?? 0 : 0;
      writeRejection(task, { materialId: m.materialId, fileName: m.fileName, contentHash: actual,
        reasons, rejectedAt: new Date().toISOString(),
        sightFailures: carried + (sightFailed ? 1 : 0),
        // 空读数也要累计，理由和凭据那一条一样：接连交空的，就不再是"再读一遍"能解的事。
        emptyReadings: carriedEmpty + (emptyReading ? 1 : 0),
        ...(prev && prev.contentHash === actual && prev.disputed ? { disputed: prev.disputed } : {}) });
    }
    if (verdict === 'accepted') {
      clearRejection(task, m.materialId);
      writeReading(task, {
        materialId: m.materialId,
        fileName: m.fileName,
        contentHash: actual,
        inventoryVersionId: inventory.versionId,
        docType: raw.docType,
        role: DOC_TYPES[raw.docType].role,
        fields,
        ...(segments.length ? { segments } : {}),
        unreadable,
        notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : null,
        amountCheck,
        source: ocrSource ? 'ocr' : 'vision',
        // 每个字段各自记来源。整份读数一个 source 是不够的：争议收场之后，
        // 同一份读数里会同时有模型抄的和用户给的，而"这个数是谁说的"
        // 恰恰是后面每一次复核唯一要问的问题。
        fieldSources: Object.fromEntries(Object.keys(fields).map((k) => [k, ocrSource ? 'ocr' : 'vision'])),
        clarity,
        sighted: ocrSource
          ? { shape: null, width: shape.width, height: shape.height }
          : { shape: raw.sighted.shape, width: shape.width, height: shape.height },
        readAt: new Date().toISOString(),
        confirmedAt: null,
      });
    }
    verdicts.push({ materialId: m.materialId, fileName: m.fileName, verdict, reasons, amountCheck,
      docType: raw.docType ?? null, unreadable });
  }
  return verdicts;
}

export function loadReading(task, materialId) {
  try { return JSON.parse(fs.readFileSync(readingFile(task, materialId), 'utf8')); }
  catch { return null; }
}

/**
 * 「这条读数整条退回待办」的标记。
 *
 * 争议收不了场（用户对着原件也认不出、或者守恒式的缺口补不上）时写下它。
 * 它必须**钉在字节上并且拦住重派**：不然读数文件一没，下一次 `next` 看到的
 * 又是「这张图还没读」，于是内核会把同一张图再派给模型，模型再读出同一个读不准的值，
 * 用户再被问一遍同一个他已经说过认不出的字段 —— 一个转不出去的圈。
 *
 * 解法只有一个，而且只有人做得到：换一份看得清的原件。文件一换，
 * 内容哈希就变了，这个标记自动不再新鲜，这张图重新回到正常的看图流程。
 */
const unreadableFile = (task, materialId) => path.join(readingsDir(task), `${materialId}.unreadable.json`);

export function loadUnreadable(task, materialId) {
  try { return JSON.parse(fs.readFileSync(unreadableFile(task, materialId), 'utf8')); }
  catch { return null; }
}

export function writeUnreadable(task, record) {
  writeRecord(task, unreadableFile(task, record.materialId), record);
}

/** 上一次被驳回的理由，没有就是 null。 */
export function loadRejection(task, materialId) {
  try { return JSON.parse(fs.readFileSync(rejectionFile(task, materialId), 'utf8')); }
  catch { return null; }
}

/** 读数目录里的一份记录。先写临时文件再改名 —— 中途中断不会留下半个 JSON。 */
function writeRecord(task, file, record) {
  fs.mkdirSync(readingsDir(task), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function writeRejection(task, record) {
  writeRecord(task, rejectionFile(task, record.materialId), record);
}

/** 这一张过了，上一次的理由就不再是待办 —— 留着它只会让状态永远停在"上次没过"。 */
export function clearRejection(task, materialId) {
  try { fs.unlinkSync(rejectionFile(task, materialId)); } catch { /* 本来就没有 */ }
}

/** 读数本身的指纹：用户确认的是这几个字段的这几个值，改一个字就不再是同一次确认。 */
const digestOf = (r) => crypto.createHash('sha256')
  .update(JSON.stringify([r.docType, Object.entries(r.fields ?? {}).sort(), r.segments ?? [], [...(r.unreadable ?? [])].sort()]))
  .digest('hex');

export function writeReading(task, reading) {
  const prev = loadReading(task, reading.materialId);
  // 保留原来的确认，只在**字节和读数都没变**时。
  // 只比内容哈希是不够的：同一张图重读一遍、改了几个字段，
  // 那些新字段用户根本没看过，却会顶着旧的确认时间混过去。
  if (prev && prev.contentHash === reading.contentHash && digestOf(prev) === digestOf(reading)) {
    reading.confirmedAt = prev.confirmedAt ?? null;
    reading.confirmedVia = prev.confirmedVia ?? null;
  }
  writeRecord(task, readingFile(task, reading.materialId), reading);
}

/**
 * 待最终整单明细确认的读数，按材料一行行摆出来。渲染成表格是上一层的事，
 * 这里只负责说清楚"这一批有哪些候选、每份读到了什么"。
 *
 * 只收**这一版字节**上还没确认的读数：图换过了的、已经确认过的都不在里面。
 */
export function pendingConfirmations(task, inventory) {
  const rows = [];
  for (const m of inventory.materials) {
    const r = loadReading(task, m.materialId);
    if (!r || r.contentHash !== m.contentHash || r.confirmedAt) continue;
    const visibleFields = r.docType === 'invoice' ? INVOICE_BUSINESS_FIELDS : null;
    rows.push({
      materialId: m.materialId,
      fileName: m.fileName,
      docType: r.docType,
      docTypeLabel: DOC_TYPES[r.docType]?.label ?? r.docType,
      fields: Object.entries(r.fields ?? {})
        .filter(([key]) => !visibleFields || visibleFields.includes(key))
        .map(([key, value]) =>
        // 来源跟着值一起摆给用户看。一张表上同时有"我看图读的"和"你给的"时，
        // 用户要复核的重点完全不同 —— 前者要对着原件比，后者他自己就是来源。
        ({ key, label: FIELD_LABELS[key] ?? key, value, source: r.fieldSources?.[key] ?? r.source ?? 'vision' })),
      unreadable: (r.unreadable ?? [])
        .filter((key) => !visibleFields || visibleFields.includes(key))
        .map((k) => FIELD_LABELS[k] ?? k),
      segments: (r.segments ?? []).map((segment, i) => ({
        index: i + 1,
        values: Object.entries(segment).map(([key, value]) => ({
          key, label: SEGMENT_RULES[key]?.label ?? key, value,
        })),
      })),
      amountCheck: r.amountCheck ?? null,
      notes: r.notes ?? null,
      // 这份读数是刚从一场争议里收场回来的话，收场的说法跟着它一起摆出来 ——
      // 用户在这张表上看到的那个改过的值，得知道它是怎么来的。
      disputeResolution: r.disputeResolution ?? null,
    });
  }
  return rows;
}

/**
 * 记下用户在最终整单明细表上的确认。
 *
 * 确认由"用户就着内核渲染的整单明细表点头、模型带着当次一次性凭据回传"这一次往返构成。
 * 聊天里的"对的""没问题"不构成确认 —— 那句话没有凭据，内核看不见它，
 * 也就无从落成事实。凭据不对时上一层根本不会走到这里。
 */
export function confirmReadings(task, materialIds) {
  const at = new Date().toISOString();
  const done = [];
  for (const id of materialIds) {
    const r = loadReading(task, id);
    if (!r) continue;
    r.confirmedAt = at;
    r.confirmedVia = 'terminal';
    fs.writeFileSync(readingFile(task, id), JSON.stringify(r, null, 2), { mode: 0o600 });
    done.push(id);
  }
  return { confirmedAt: at, materialIds: done };
}

/**
 * 用户指错了：他给的值和机器读到的不一样。
 *
 * **用户的值不直接落库。** 一个人对着表格口述的数字和一次逐字抄写，都可能错，
 * 内核没有理由偏信哪一个；直接采纳等于把"确认"这道闸变成"改写"这道门。
 * 所以这里做两件事，一件都不多做：
 *
 *  1. **把这一次读数作废。** 用户不认它了，它就不再是候选，先前那次确认
 *     （如果有）也跟着作废 —— 字段改过之后，之前认的已经不是同一份东西。
 *  2. **把分歧留成下一次读取的输入。** 机器读到什么、用户说是什么，一起记在
 *     驳回记录里，下一次看图时原样摆给模型（也摆给用户）。
 *
 * 收敛靠重读，不靠内核在两个值之间选一个：带着分歧派一次**干净上下文**的重读、
 * 把两次机器读数和用户的值一起摆给用户拍板，在 dispute.mjs 里。
 * 这里只负责把分歧**记成一条待收场的争议**，一个值都不落。
 */
export function disputeReading(task, materialId, corrections = {}) {
  const r = loadReading(task, materialId);
  if (!r) return null;
  const disputed = Object.entries(corrections)
    .filter(([key]) => key in FIELD_RULES)
    .map(([key, userValue]) => ({
      field: key,
      label: FIELD_LABELS[key] ?? key,
      machineValue: r.fields?.[key] ?? null,
      userValue: typeof userValue === 'string' ? userValue : String(userValue ?? ''),
      // 机器抄这个字段时说自己看得清不清楚。它是证据的一部分，跟着分歧一起留住 ——
      // 到了摆证据那一步再回头去翻，读数文件已经被作废删掉了。
      machineClarity: r.clarity?.[key] ?? null,
      // 来源分开记：机器抄的是 vision，人说的是 user。合成一个值之前，
      // 两边各是谁说的必须一直看得见。
      source: 'user',
    }))
    .filter((d) => d.userValue !== d.machineValue);

  writeRejection(task, {
    materialId,
    fileName: r.fileName,
    contentHash: r.contentHash,
    rejectedAt: new Date().toISOString(),
    disputed,
    // 被推翻的那一次机器读数**整份留着**。它不再是候选，但它是证据：
    // `reading_disputed` 的收场要把两次机器读数和用户的值一起摆给用户拍板（#63），
    // 删掉它，第二次重读就没有可对照的第一次了。
    machineReading: r,
    reasons: disputed.length
      ? disputed.map((d) => `${d.label}：我读到的是「${d.machineValue ?? '（没读出来）'}」，`
        + `用户对着原件说是「${d.userValue}」。这两个值我不替谁做主，请重新打开这张图逐字核对该字段。`)
      : ['用户看过这张表之后没有认可这份读数，请重新打开这张图逐字读一遍。'],
  });
  // 读数本身作废。留着它会让状态停在「待确认」，而那张表用户已经否掉了。
  try { fs.unlinkSync(readingFile(task, materialId)); } catch { /* 已经没了 */ }
  return { materialId, disputed };
}

/**
 * 把读数投影成和 PDF 解析同构的结果，好让后面的重复检查、金额守恒、上传清单
 * 一视同仁地处理它们。未确认的读数只有在最终整单明细确认后才会被标记为确认，
 * 但在此之前可以用 provisional 形态进入分类和最终清单。
 */
export function projectReading(reading, { provisional = false } = {}) {
  if (!reading || (!reading.confirmedAt && !provisional)) return null;
  const type = DOC_TYPES[reading.docType];
  if (!type) return null;
  const f = reading.fields;
  const money = (v) => (v ? { text: v, cents: cents(v) } : undefined);
  const fields = {};
  if (f.invoiceNumber) fields.invoiceNumber = f.invoiceNumber;
  if (f.issueDate && reading.docType !== 'invoice') fields.issueDate = f.issueDate;
  if (money(f.netAmount)) fields.netAmount = money(f.netAmount);
  if (money(f.taxAmount)) fields.taxAmount = money(f.taxAmount);
  if (money(f.totalAmount)) fields.totalAmount = money(f.totalAmount);
  if (reading.docType === 'rail_ticket') {
    if (f.travelDate) fields.travelDate = f.travelDate;
    if (f.origin) fields.railFrom = f.origin;
    if (f.destination) fields.railTo = f.destination;
  }
  return {
    parseStatus: 'parsed',
    kind: reading.docType === 'invoice' ? 'image_invoice'
      : reading.docType === 'rail_ticket' ? 'rail_eticket' : reading.docType,
    kindLabel: `${type.label}（看图读取${reading.confirmedAt ? '，已确认' : '，待整单确认'}）`,
    role: type.role,
    fields,
    // 证据不是某一行文字，而是"哪份材料的哪串字节被谁在什么时候读的、什么时候确认的"。
    evidence: Object.fromEntries(Object.keys(fields).map((k) =>
      [k, `看图读取，${reading.contentHash.slice(0, 12)}…，${reading.confirmedAt
        ? `确认于 ${reading.confirmedAt}` : '等待整单明细确认'}`])),
    candidates: [
      ...Object.entries(f)
        .filter(([k]) => !(k in fields)
          && !(reading.docType === 'invoice' && !INVOICE_READING_FIELDS.includes(k)))
        .map(([field, value]) => ({ field, value, note: '看图读取的辅助字段', evidence: null })),
      ...(reading.segments?.length ? [{
        field: 'segments',
        value: reading.segments.map((segment, i) => ({
          index: i + 1,
          date: segment.travelDate,
          city: segment.city ?? null,
          route: `${segment.origin} → ${segment.destination}`,
          amount: segment.amount ?? null,
        })),
        note: '看图读取并由用户确认的行程单逐段明细',
        evidence: null,
      }] : []),
    ],
    // 每个字段的来源跟着投影一起往下走。到了 ERP 那一头再问"这个数谁说的"，
    // 答案得还在，不能在投影这一步被抹平成"看图读取"。
    fieldSources: Object.fromEntries(Object.keys(fields).map((k) =>
      [k, reading.fieldSources?.[k] ?? reading.source ?? 'vision'])),
    visionSource: { readAt: reading.readAt, confirmedAt: reading.confirmedAt ?? null,
      provisional: !reading.confirmedAt, unreadable: reading.unreadable },
  };
}
