import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';

// 图片材料的读取协议。
//
// 内核没有 OCR，也不该有 —— 装一个本地 OCR 就等于要求每个同事的电脑上都有它，
// 而 Claude Code 本身就有视觉能力，零安装、跨平台。所以图片由**模型来读**。
//
// 但读不等于判。这里的整个设计就是为了让"模型读了一眼"不至于变成"模型说了算"：
//
//   1. 读取对象是**在册材料**：有材料标识、有内容哈希、属于某个盘点版本。
//      读数必须带上内容哈希，内核会重新算一遍；对不上就作废。
//      这让一次读取永远指向一个确定的字节序列，文件一改读数自动失效。
//   2. 读数只能是**逐字抄写**。模型不得计算、推断、补全，看不清必须说看不清。
//   3. 内核**结构校验**：位数、日期、金额守恒。这些是模型控制不了的算术，
//      编出来的号码和金额过不了。
//   4. 校验通过也只是**字段候选**，不是已解析值。必须由用户在本地 Web 上确认。
//      确认由提交动作构成 —— 这和契约里其他确认走的是同一条权威通道。
//
// 换句话说：材料仍然是证据，模型只是读它的人，内核和用户是两道闸。

export const READING_VERSION = 1;

/** 图片可能是什么。闭集：模型不能自己发明一个类型。 */
export const DOC_TYPES = {
  invoice: { role: 'primary_voucher', label: '发票', needsIdentity: true },
  ride_itinerary: { role: 'reference', label: '网约车行程单', needsIdentity: false },
  hotel_folio: { role: 'reference', label: '酒店结账单', needsIdentity: false },
  payment_slip: { role: 'reference', label: '支付水单/付款凭证', needsIdentity: false },
  other: { role: null, label: '其他', needsIdentity: false },
  unreadable: { role: null, label: '看不清', needsIdentity: false },
};

/** 允许回报的字段。不在这张表里的键一律拒收 —— 不给自由发挥留缝。 */
const FIELD_RULES = {
  invoiceNumber: { test: (v) => /^\d{20}$/.test(v), hint: '20 位数字' },
  issueDate: { test: isDate, hint: 'YYYY-MM-DD' },
  netAmount: { test: isMoney, hint: '金额，两位小数' },
  taxAmount: { test: isMoney, hint: '金额，两位小数' },
  totalAmount: { test: isMoney, hint: '金额，两位小数' },
  sellerName: { test: isText, hint: '票面上的销售方名称' },
  buyerName: { test: isText, hint: '票面上的购买方名称' },
  itemName: { test: isText, hint: '票面上的项目名称' },
  city: { test: isText, hint: '票面或单据上写明的城市' },
  travelDate: { test: isDate, hint: 'YYYY-MM-DD' },
  origin: { test: isText, hint: '起点' },
  destination: { test: isText, hint: '终点' },
};

function isMoney(v) { return typeof v === 'string' && /^-?\d{1,9}\.\d{2}$/.test(v); }
function isText(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= 120; }
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || !v.startsWith(String(d.getUTCFullYear()))) return false;
  // 明天以后的开票日期一定是读错了；十年前的也不该出现在报销材料里。
  const now = Date.now();
  return d.getTime() < now + 36 * 3600 * 1000 && d.getTime() > now - 10 * 365 * 24 * 3600 * 1000;
}

const cents = (s) => Math.round(Number(s) * 100);
const readingsDir = (task) => path.join(taskDir(task), 'readings');
const readingFile = (task, materialId) => path.join(readingsDir(task), `${materialId}.json`);

/**
 * 生成读取工单：哪些材料需要看图，每份要回报什么。
 * `absPath` 只在这一次输出里出现（模型需要它才能打开文件），不写进任何产物。
 */
export function buildWorkOrder(sourceDir, inventory, classification, task) {
  const root = path.resolve(sourceDir);
  const items = [];
  for (const r of classification.results) {
    if (r.parseStatus !== 'needs_ocr') continue;
    const m = inventory.materials.find((x) => x.materialId === r.materialId);
    if (!m) continue;
    const existing = loadReading(task, r.materialId);
    items.push({
      materialId: m.materialId,
      fileName: m.fileName,
      absPath: path.join(root, m.relPath),
      contentHash: m.contentHash,
      format: m.format,
      // 同一份字节已经读过就不用再读；文件改过则旧读数已失效，要重读。
      alreadyRead: !!existing && existing.contentHash === m.contentHash,
      confirmed: !!existing && existing.contentHash === m.contentHash && !!existing.confirmedAt,
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
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, m.relPath))).digest('hex');
    if (raw.contentHash !== actual) {
      reasons.push('读数携带的内容哈希与材料当前内容不一致，这次读取已作废，请重新看图');
    }

    const type = DOC_TYPES[raw.docType];
    if (!type) reasons.push(`docType 必须是这几个之一：${Object.keys(DOC_TYPES).join('、')}`);

    const fields = {};
    const unreadable = Array.isArray(raw.unreadable) ? raw.unreadable.filter((k) => typeof k === 'string') : [];
    for (const [k, v] of Object.entries(raw.fields ?? {})) {
      const rule = FIELD_RULES[k];
      if (!rule) { reasons.push(`不认识的字段 ${k}`); continue; }
      if (!rule.test(v)) { reasons.push(`${k} 的格式不对（要求：${rule.hint}）`); continue; }
      fields[k] = v;
    }

    // 发票必须有能构成发票身份的号码，否则没法做重复检查。
    if (raw.docType === 'invoice') {
      if (!fields.invoiceNumber) reasons.push('识别为发票但没有回报 20 位发票号码，无法做重复检查');
      if (!fields.totalAmount) reasons.push('识别为发票但没有回报价税合计');
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
    if (verdict === 'accepted') {
      writeReading(task, {
        materialId: m.materialId,
        fileName: m.fileName,
        contentHash: actual,
        inventoryVersionId: inventory.versionId,
        docType: raw.docType,
        role: DOC_TYPES[raw.docType].role,
        fields,
        unreadable,
        notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : null,
        amountCheck,
        source: 'vision',
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

function writeReading(task, reading) {
  const dir = readingsDir(task);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = readingFile(task, reading.materialId);
  const prev = loadReading(task, reading.materialId);
  // 内容没变时保留原来的确认；变了就必须重新确认。
  if (prev && prev.contentHash === reading.contentHash) reading.confirmedAt = prev.confirmedAt ?? null;
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(reading, null, 2), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
}

/** 记下用户在本地 Web 上的确认。确认由提交动作构成，对话里说"确认了"不算。 */
export function confirmReadings(task, materialIds) {
  const at = new Date().toISOString();
  const done = [];
  for (const id of materialIds) {
    const r = loadReading(task, id);
    if (!r) continue;
    r.confirmedAt = at;
    r.confirmedVia = 'local-web';
    fs.writeFileSync(readingFile(task, id), JSON.stringify(r, null, 2), { mode: 0o600 });
    done.push(id);
  }
  return { confirmedAt: at, materialIds: done };
}

/**
 * 把已确认的读数投影成和 PDF 解析同构的结果，好让后面的重复检查、
 * 金额守恒、上传清单一视同仁地处理它们。**未确认的读数不投影** ——
 * 它们停在候选状态，构成阻塞。
 */
export function projectReading(reading) {
  if (!reading || !reading.confirmedAt) return null;
  const type = DOC_TYPES[reading.docType];
  const f = reading.fields;
  const money = (v) => (v ? { text: v, cents: cents(v) } : undefined);
  const fields = {};
  if (f.invoiceNumber) fields.invoiceNumber = f.invoiceNumber;
  if (f.issueDate) fields.issueDate = f.issueDate;
  if (money(f.netAmount)) fields.netAmount = money(f.netAmount);
  if (money(f.taxAmount)) fields.taxAmount = money(f.taxAmount);
  if (money(f.totalAmount)) fields.totalAmount = money(f.totalAmount);
  return {
    parseStatus: 'parsed',
    kind: reading.docType === 'invoice' ? 'image_invoice' : reading.docType,
    kindLabel: `${type.label}（看图读取，已确认）`,
    role: type.role,
    fields,
    // 证据不是某一行文字，而是"哪份材料的哪串字节被谁在什么时候读的、什么时候确认的"。
    evidence: Object.fromEntries(Object.keys(fields).map((k) =>
      [k, `看图读取，${reading.contentHash.slice(0, 12)}…，确认于 ${reading.confirmedAt}`])),
    candidates: Object.entries(f)
      .filter(([k]) => !(k in fields))
      .map(([field, value]) => ({ field, value, note: '看图读取的辅助字段', evidence: null })),
    visionSource: { readAt: reading.readAt, confirmedAt: reading.confirmedAt, unreadable: reading.unreadable },
  };
}
