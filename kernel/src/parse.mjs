import fs from 'node:fs';
import { extractPdfText } from './pdftext.mjs';

// 从一份材料里提取事实。这一层只认**票面上写着的东西**：
// 认不出就说认不出，取不到就标 missing，绝不从文件名、目录名或金额相近去推断。
//
// 分成两类结论：
//   - 已解析值（fields）：票面直接写明、且有证据行支撑的法定事实。
//   - 字段候选（candidates）：靠位置或上下文推断出来的，只能作参考，不能直接进 ERP。

/** 票种。v1 只认这几种，其余一律 unrecognized。 */
const KINDS = [
  {
    kind: 'rail_eticket', role: 'primary_voucher', label: '铁路电子客票',
    test: (t) => t.includes('电子发票(铁路电子客票)'),
  },
  {
    kind: 'vat_special', role: 'primary_voucher', label: '增值税专用发票',
    test: (t) => t.includes('电子发票(增值税专用发票)'),
  },
  {
    kind: 'passenger_transport', role: 'primary_voucher', label: '旅客运输服务电子普通发票',
    test: (t) => (t.includes('电子发票(普通发票)') || t.includes('增值税电子普通发票'))
      && (t.includes('旅客运输服务')
        || (t.includes('旅游服务') && t.includes('代订车服务费'))),
  },
  {
    kind: 'vat_common', role: 'primary_voucher', label: '电子普通发票',
    test: (t) => t.includes('电子发票(普通发票)')
      || (t.includes('增值税电子普通发票') && t.includes('发票代码') && t.includes('发票号码')),
  },
  {
    kind: 'ride_itinerary', role: 'reference', label: '网约车行程单',
    test: (t) => t.includes('行程单') && (t.includes('AMAPITINERARY') || t.includes('高德地图')),
  },
  {
    kind: 'hotel_folio', role: 'reference', label: '酒店结账单',
    test: (t) => t.includes('结账单'),
  },
];

/**
 * 匹配前先归一：去掉全部空白，再做 NFKC。
 * 空白是因为发票 PDF 常把一个词拆成多个文字块；NFKC 是因为实测踩到过 ——
 * AA 那张发票的字体把"电子"的"子"映射成了康熙部首 ⼦（U+2F26），
 * 肉眼一模一样，字符串比较却不相等。NFKC 顺带把全角括号、冒号、￥ 统一成半角，
 * 所以下面的模式一律按半角写。
 */
const compact = (t) => t.replace(/\s+/g, '').normalize('NFKC');

const toCents = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const money = (s) => (toCents(s) === null ? null : { text: String(s).replace(/,/g, ''), cents: toCents(s) });

/** 找出最早提到这个值的原始行，作为解析证据。 */
const evidenceFor = (lines, needle) =>
  lines.find((l) => compact(l).includes(compact(String(needle)))) ?? null;

function extractInvoiceFields(kind, text, lines) {
  const c = compact(text);
  const fields = {};
  const evidence = {};
  const put = (key, value, needle) => {
    if (value === null || value === undefined) return;
    fields[key] = value;
    evidence[key] = evidenceFor(lines, needle ?? value);
  };

  // 全电发票（含铁路电子客票）用 20 位发票号码作身份；传统票保留发票代码和 8 位号码，
  // 后面的 invoiceIdentity 按票面格式生成不同的身份方案，不能把旧号码补成 20 位。
  const code = c.match(/发票代码:?(\d{12}|\d{10})(?!\d)/);
  put('invoiceCode', code?.[1] ?? null, code?.[1]);
  const modernNo = c.match(/发票号码:?(\d{20})(?!\d)/);
  const legacyNo = c.match(/发票号码:?(\d{8})(?!\d)/);
  const no = modernNo ?? legacyNo;
  put('invoiceNumber', no?.[1] ?? null, no?.[1]);

  const d = c.match(/开票日期:?(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (d) put('issueDate', `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`, `${d[1]}年`);

  // 合计行是不含税金额和税额；"价税合计"里也含"合计"两字，必须排除掉。
  // 两个方向都要试：多数票把金额印在"合计"右边，但 AA 那张印在"合计"上面一行，
  // 压平成一行之后金额就跑到了标签前面。
  const sum = c.match(/(?<!价税)合计¥(-?[\d,]+\.\d{2})¥(-?[\d,]+\.\d{2})/)
    ?? c.match(/¥(-?[\d,]+\.\d{2})¥(-?[\d,]+\.\d{2})(?=合计)/);
  put('netAmount', sum ? money(sum[1]) : null, sum?.[1]);
  put('taxAmount', sum ? money(sum[2]) : null, sum?.[2]);

  const total = c.match(/价税合计\(大写\).*?\(小写\)¥?(-?[\d,]+\.\d{2})/);
  put('totalAmount', total ? money(total[1]) : null, total?.[1]);

  if (kind === 'rail_eticket') {
    // 铁路电子客票票面只有票价：不含税金额和税额票面上没有，
    // 是 ERP 收票回读时才产生的外部事实，这里必须留空而不是自己算。
    const fare = c.match(/票价:?¥?(\d+\.\d{2})/);
    put('totalAmount', fare ? money(fare[1]) : null, fare?.[1]);
    // 车次行必须按**原始行**匹配，不能在压平后的整页文本里找：
    // 压平之后"开票日期:2026年09月02日合肥南站"里的"日"也是汉字，
    // 起点站名会从这里开始往前吃（实测吃成了大半页票面）。
    const tripLine = lines.map((l) => l.normalize('NFKC').trim())
      .find((l) => /^\S+站\s+[A-Z]?\d{1,4}\s+\S+站$/.test(l));
    if (tripLine) {
      const trip = tripLine.match(/^(\S+?)站\s+([A-Z]?\d{1,4})\s+(\S+?)站$/);
      fields.railTrain = trip[2];
      fields.railFrom = trip[1];
      fields.railTo = trip[3];
      evidence.railTrain = tripLine;
      evidence.railFrom = tripLine;
      evidence.railTo = tripLine;
    }
    const depart = c.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})开/);
    if (depart) {
      put('travelDate', `${depart[1]}-${depart[2].padStart(2, '0')}-${depart[3].padStart(2, '0')}`, `${depart[4]}:${depart[5]}开`);
    }
  }

  return { fields, evidence };
}

/** 表头列中心和每个序号行的 y 区间，供跨行起终点重建使用。 */
function itineraryRouteLayout(pages, count) {
  const lines = (pages ?? []).flatMap((page) => page.lines ?? []);
  const header = lines.find((line) => {
    const text = line.items?.map((item) => compact(item.text)).join('') ?? '';
    return text.includes('起点') && text.includes('终点') && text.includes('金额');
  });
  if (!header) return null;

  const itemWith = (needle) => header.items.find((item) => compact(item.text).includes(needle));
  const city = itemWith('城市');
  const origin = itemWith('起点');
  const destination = itemWith('终点');
  const amount = itemWith('金额');
  if (!city || !origin || !destination || !amount) return null;

  const center = (item) => item.x + (item.width ?? 0) / 2;
  const cityCenter = center(city);
  const originCenter = center(origin);
  const destinationCenter = center(destination);
  const amountCenter = center(amount);
  const originLeft = (cityCenter + originCenter) / 2;
  const destinationLeft = (originCenter + destinationCenter) / 2;
  const destinationRight = (destinationCenter + amountCenter) / 2;

  const rowY = new Map();
  for (const line of lines) {
    for (const item of line.items ?? []) {
      const value = compact(item.text);
      const index = /^\d+$/.test(value) ? Number(value) : null;
      if (index && index <= count && center(item) < originLeft) rowY.set(index, line.y);
    }
  }
  const ys = Array.from({ length: count }, (_, i) => rowY.get(i + 1) ?? null);
  if (ys.some((y) => y === null)) {
    return new Map(Array.from({ length: count }, (_, i) => [i + 1,
      { origin: null, destination: null, route: null, complete: false }]));
  }
  const byIndex = new Map();
  for (let i = 0; i < count; i += 1) {
    const index = i + 1;
    const y = ys[i];
    if (y === null) {
      byIndex.set(index, { origin: null, destination: null, route: null, complete: false });
      continue;
    }
    const top = i === 0 ? (header.y + y) / 2 : (ys[i - 1] + y) / 2;
    const bottom = i === count - 1 ? -Infinity : (y + ys[i + 1]) / 2;
    const rowLines = lines.filter((line) => line.y <= top && line.y > bottom);
    const inColumn = (left, right) => rowLines.flatMap((line) => line.items ?? [])
      .filter((item) => {
        const x = center(item);
        return x >= left && x < right;
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const textOf = (items) => items.map((item) => item.text).join('').replace(/\s+/g, '') || null;
    const from = textOf(inColumn(originLeft, destinationLeft));
    const to = textOf(inColumn(destinationLeft, destinationRight));
    byIndex.set(index, {
      origin: from,
      destination: to,
      route: from && to ? `${from} → ${to}` : null,
      complete: !!(from && to),
    });
  }
  return byIndex;
}

/**
 * 行程单的逐段明细。日期、城市、金额仍从文字行读取；起终点使用 PDF 文字块坐标，
 * 按表头列和序号行的 y 区间归并，避免把跨行地址按空格硬切。
 */
function itinerarySegments(lines, pages) {
  const rows = [];
  for (const raw of lines) {
    const l = raw.normalize('NFKC').trim();
    const m = l.match(/^(\d+)\s+.*?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S{2,6}市)\s*(.*?)([\d,]+\.\d{2})元$/);
    if (!m) continue;
    rows.push({
      index: Number(m[1]),
      date: m[2],
      time: m[3],
      city: m[4],
      route: m[5].trim() || null,
      amount: m[6].replace(/,/g, ''),
    });
  }
  // 序号必须是从 1 开始的连续整数，否则这份逐段明细不完整。
  if (!rows.every((r, i) => r.index === i + 1)) return [];
  const routeLayout = itineraryRouteLayout(pages, rows.length);
  if (!routeLayout) return rows;
  return rows.map((row) => {
    const route = routeLayout.get(row.index);
    return {
      ...row,
      origin: route?.origin ?? null,
      destination: route?.destination ?? null,
      route: route?.route ?? null,
      routeComplete: route?.complete === true,
    };
  });
}

function extractCandidates(kind, text, lines, pages) {
  const c = compact(text);
  const out = [];
  const add = (field, value, note) => out.push({ field, value, note, evidence: evidenceFor(lines, value) });

  // 购买方税号：靠"第一个出现的统一社会信用代码是购方"这个位置约定推出来的。
  // 位置约定不是票面明文，所以它只能是候选，不能当已解析值。
  //
  // 前后的边界不能省：20 位发票号码里随手一截就是 18 位，形状和统一社会信用代码
  // 完全一样，没有边界时它会被当成税号提出来（实测踩过）。
  const ids = [...c.matchAll(/(?<![0-9A-Z])([0-9A-Z]{2}\d{6}[0-9A-Z]{10})(?![0-9A-Z])/g)].map((m) => m[1]);
  if (ids.length) add('buyerTaxId', ids[0], '按票面位置推断：第一个统一社会信用代码为购买方；需与任务主体核对');

  if (kind === 'ride_itinerary') {
    const m = c.match(/共计(\d+)单行程,合计([\d,]+\.\d{2})元/);
    if (m) {
      add('segmentCount', Number(m[1]), '行程单声明的行程段数；费用事件拆分在下一层裁决');
      add('itineraryTotal', m[2], '行程单合计金额；只作证据，不替代票面价税合计');
    }
    const rows = itinerarySegments(lines, pages);
    // 只有逐行取到的段数和行程单自己声明的段数一致，这份逐段明细才可信。
    // 对不上就说明有行没取全（表格换行是实测踩过的坑），宁可整块作废。
    if (rows.length && m && rows.length === Number(m[1])) {
      out.push({ field: 'segments', value: rows, evidence: null,
        note: '行程单逐段明细；行程单是参考材料，这些金额不是票面法定金额，不能直接当分摊结果用' });
    } else if (rows.length !== Number(m?.[1] ?? -1)) {
      add('segmentRowsIncomplete', String(rows.length), '逐段明细取到的行数与行程单声明的段数对不上，整块作废');
    }
  }
  if (kind === 'hotel_folio') {
    const inn = c.match(/入住日期:(\d{4}-\d{2}-\d{2})/);
    const out2 = c.match(/离店日期:(\d{4}-\d{2}-\d{2})/);
    const paid = c.match(/付款合计([\d,]+\.\d{2})/);
    if (inn) add('checkIn', inn[1], '结账单入住日期');
    if (out2) add('checkOut', out2[1], '结账单离店日期');
    if (paid) add('folioTotal', paid[1], '结账单付款合计；结账单不是发票，金额不构成报销依据');
  }
  return out;
}

/**
 * 解析一份材料。
 * 返回的 `parseStatus` 是事实本身：`needs_ocr` 和 `no_text` 都不是可以绕过的失败。
 */
export function parseMaterial(absPath, format) {
  if (format === 'png' || format === 'jpg') {
    // 内核零依赖，不直接做 OCR。图片候选由当前图片 Adapter 读取：
    // 默认走模型视觉，显式选择 ocr-assisted 时先走受管 OCR，再对缺口视觉复核。
    return { parseStatus: 'needs_ocr', kind: null, role: null, fields: {}, candidates: [], evidence: {} };
  }
  if (format !== 'pdf') {
    return { parseStatus: 'unsupported', kind: null, role: null, fields: {}, candidates: [], evidence: {} };
  }

  let extracted;
  try { extracted = extractPdfText(fs.readFileSync(absPath)); }
  catch (err) { return { parseStatus: 'read_error', note: err.message, kind: null, role: null, fields: {}, candidates: [], evidence: {} }; }

  if (!extracted.hasText) {
    // 取不到字通常意味着这是扫描件（整页是一张图）。同样落到需要 OCR。
    return { parseStatus: 'no_text', pageCount: extracted.pageCount, kind: null, role: null, fields: {}, candidates: [], evidence: {} };
  }

  const text = extracted.text;
  const lines = text.split('\n');
  const c = compact(text);
  const hit = KINDS.find((k) => k.test(c));
  if (!hit) {
    return { parseStatus: 'unrecognized', pageCount: extracted.pageCount, kind: null, role: null,
      fields: {}, candidates: [], evidence: {} };
  }

  const { fields, evidence } = hit.role === 'primary_voucher'
    ? extractInvoiceFields(hit.kind, text, lines)
    : { fields: {}, evidence: {} };

  return {
    parseStatus: 'parsed',
    pageCount: extracted.pageCount,
    kind: hit.kind,
    kindLabel: hit.label,
    role: hit.role,
    fields,
    evidence,
    candidates: extractCandidates(hit.kind, text, lines, extracted.pages),
  };
}

/** 发票身份：按票面格式生成规范键。参考材料没有发票身份。 */
export function invoiceIdentity(parsed) {
  if (parsed.role !== 'primary_voucher') return null;
  const n = parsed.fields?.invoiceNumber;
  const code = parsed.fields?.invoiceCode;
  if (/^(?:\d{10}|\d{12})$/.test(code ?? '') && /^\d{8}$/.test(n ?? '')) {
    return { scheme: 'vat-legacy', key: `vat-legacy:${code}:${n}`, code, number: n };
  }
  if (/^\d{20}$/.test(n ?? '')) {
    return { scheme: 'einvoice-20', key: `einvoice-20:${n}`, number: n };
  }
  return null;
}

/** 发票号码属于敏感事实：报告和终端输出一律脱敏，完整值只留在任务工作区。 */
export const maskNumber = (n) => {
  if (typeof n !== 'string') return n ?? null;
  if (n.length > 8) return `${n.slice(0, 4)}${'*'.repeat(n.length - 8)}${n.slice(-4)}`;
  return n.length > 4 ? `${n.slice(0, 2)}${'*'.repeat(n.length - 4)}${n.slice(-2)}` : n;
};

/** 金额守恒：不含税 + 税额 = 价税合计。三项不全时不判定，只如实说明缺哪一项。 */
export function checkAmounts(fields) {
  const { netAmount, taxAmount, totalAmount } = fields;
  if (!totalAmount) return { status: 'missing', missing: ['totalAmount'] };
  const missing = [];
  if (!netAmount) missing.push('netAmount');
  if (!taxAmount) missing.push('taxAmount');
  if (missing.length) return { status: 'partial', missing };
  const ok = netAmount.cents + taxAmount.cents === totalAmount.cents;
  return { status: ok ? 'balanced' : 'mismatch',
    netCents: netAmount.cents, taxCents: taxAmount.cents, totalCents: totalAmount.cents };
}
