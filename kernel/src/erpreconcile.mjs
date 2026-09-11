import { readFormTabs, readGridByColumn, readHeaderField } from './erpread.mjs';

// ERP 对账：把当前这张费用报销单归到一个**对账中断点**，并给出仅有的两种处置。
// 契约在 docs/research/erp-expense-flow/save-contract.md 的「erp-reconcile 判定契约」一节
// （issue #36 定，issue #35 的真单读数推出来的）。这个模块一个字都不往 ERP 写。
//
// 拆成两半是为了让判定能不开浏览器测：
//   classifyReconciliation(readings) —— 纯函数，不碰 session、不碰时间。
//   readReconciliation(page)         —— 只读采集，不做任何判定。
//
// 四项读数每一项自带 `readable`，不用 `null` 兼表「没有」和「读不到」——
// 这两件事在这里的后果完全不同：`空` 是一个结论，`读不到` 是拒绝下结论。

export const BUCKETS = ['未知', '未保存·导入前', '未保存·已导入未写明细', '未保存·就绪待保存', '已保存', '不自洽'];
export const ACTIONS = ['原地等待', '转人工'];

/** 收票网格认这一列，明细网格认这一列。两边都含税，这是唯一的恒等式。 */
export const RECEIPTS_COLUMN = '价税合计';
export const DETAIL_COLUMN = '申请报销金额';
/** 旁证列：不进恒等式，不等也不判红。 */
export const PAYABLE_COLUMN = '申请付款金额';
export const NET_COLUMN = '费用金额';
export const TAX_COLUMN = '税额';
export const PROJECT_COLUMN = '项目';
export const EXPENSE_ITEM_COLUMN = '费用项目';
export const START_DATE_COLUMN = '开始日期';
export const END_DATE_COLUMN = '结束日期';
export const INVOICE_TYPE_COLUMN = '发票类型';
export const RECEIPT_NET_COLUMN = '不含税金额';
export const RECEIPT_NUMBER_COLUMN = '收票单';
export const INVOICE_NUMBER_COLUMN = '发票号码';
export const DETAIL_RECEIPT_NUMBER_COLUMN = '收票单号';

/**
 * 金额文本 -> 分（整数）。回读带货币符号和千分位（实测 `¥1,234.56`）。
 *
 * **不做浮点换算**：整数部分和小数部分分开算，`0.1 + 0.2` 那类误差在这里不存在。
 * 空串、`-`、任何解析不出来的东西一律回 `null` —— 调用方必须把 `null` 当**读不到**，
 * 绝不当 0（新增单自带的空白明细行就是空串，当 0 会凑出「0 == 0」的假绿）。
 */
export function toCents(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).replace(/[¥￥,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

/**
 * 把一个网格的某一列逐行相加。三条 fail-closed 判据都落在这里：
 *   - 认不出这一列 -> 整个网格不可读（不猜相近的列名）。
 *   - 任一行的这一格空着或读不成金额 -> 整个网格不可读。
 *   - ERP 自渲染的合计行和逐行相加对不上 -> 整个网格不可读。
 */
export function sumColumn(grid, column) {
  const none = (reason, extra = {}) => ({ readable: false, totalCents: null, rowCount: null, reason, ...extra });
  if (!grid || grid.ok !== true) return none(grid?.reason ?? `读不到「${column}」所在的网格`);
  if (!grid.columns.some((c) => c.label === column)) {
    return none(`网格的表头里认不出「${column}」列`, { columns: grid.columns.map((c) => c.label) });
  }
  const data = grid.rows.filter((r) => r.kind === 'data');
  const rows = [];
  let sum = 0;
  for (const [i, r] of data.entries()) {
    const cents = toCents(r.values[column]);
    if (cents === null) {
      return none(`第 ${i + 1} 行的「${column}」是空的或者读不成金额；空单元格判不可读，不当 0`,
        { rowCount: data.length });
    }
    sum += cents;
    rows.push({ row: i + 1, cents });
  }
  // 合计行读不成金额时不作数（0 行的网格合计格本来就是空的）；能读出来就必须一致。
  for (const t of grid.rows.filter((r) => r.kind === 'total')) {
    const shown = toCents(t.values[column]);
    if (shown === null) continue;
    if (shown !== sum) {
      return none(`ERP 自渲染的合计行「${column}」是 ${shown} 分，逐行相加是 ${sum} 分，两者不一致`,
        { rowCount: data.length });
    }
  }
  return { readable: true, totalCents: sum, rowCount: data.length, rows };
}

/**
 * 六格判定。**纯函数**：同一组读数永远得到同一格，可以不开浏览器把六格全测一遍。
 *
 * 顺序是契约的一部分，`未知` 最先求值 —— 否则读不到会伪装成别的格。
 * 契约表里第 1 行「任一项不可读 -> 未知」和第 4 行「... 且（明细不可读 或 明细合计为 0）」
 * 在字面上互相盖住，这里按**更保守的那一边**解：
 * 新增单、无单号、收票有行时，明细读不出来就是「还没写明细」（转人工，发票已被消耗），
 * 其余任何一项读不到都回 `未知`（原地等待）。两种解释里这是处置更重的一种。
 */
export function classifyReconciliation(readings) {
  const { formMode, billNo, receipts, detail, payable } = readings;
  const reasons = [];
  const verdict = (bucket, action) => ({ bucket, action, identity: identityOf(receipts, detail), reasons });

  // 恒等式两边都读到了才谈得上相等；读不到就是 applicable: false，不是「不相等」。
  const mode = formMode?.readable ? formMode.value : null;
  const noBill = billNo?.readable && !billNo.value;
  const hasBill = billNo?.readable && !!billNo.value;

  if (!formMode?.readable) reasons.push(`页签模式读不到：${formMode?.reason ?? '没有原因'}`);
  if (!billNo?.readable) reasons.push(`单据编号读不到：${billNo?.reason ?? '没有原因'}`);
  if (!receipts?.readable) reasons.push(`收票${RECEIPTS_COLUMN}读不到：${receipts?.reason ?? '没有原因'}`);
  if (!detail?.readable) reasons.push(`明细${DETAIL_COLUMN}读不到：${detail?.reason ?? '没有原因'}`);
  if (payable?.readable && detail?.readable && payable.totalCents !== detail.totalCents) {
    // 旁证不等只记进证据，不改中断点。
    reasons.push(`旁证：${PAYABLE_COLUMN}合计 ${payable.totalCents} 分与${DETAIL_COLUMN}合计 ${detail.totalCents} 分不等，不进判定`);
  }

  if (!formMode?.readable || !billNo?.readable || !receipts?.readable) return verdict('未知', '原地等待');

  const imported = receipts.rowCount > 0;
  if (mode === 'new' && noBill && imported && !detail.readable) {
    reasons.push('收票已有行、明细读不出来：按「还没写明细」处置，发票已被 ERP 消耗');
    return verdict('未保存·已导入未写明细', '转人工');
  }
  if (!detail.readable) return verdict('未知', '原地等待');

  // 有 expectedPreview 时，金额和行数相等仍不足以证明这张任务已经写对。
  // 只要严格逐行回读失败，就不能把新增单报成待保存；已有单仍只能转人工复核。
  if (readings.taskMatch && !readings.taskMatch.ok) {
    reasons.push(...(readings.taskMatch.reasons ?? ['逐行任务回读未通过']));
    return verdict(mode === 'modify' && hasBill ? '已保存' : '不自洽', '转人工');
  }

  if (mode === 'modify' && hasBill) {
    const id = identityOf(receipts, detail);
    reasons.push(`页签是「修改」且单据编号是 ${billNo.value}，草稿已落库`);
    if (id.equal) return verdict('已保存', '原地等待');
    reasons.push(`已落库但恒等式不成立：收票 ${id.receiptsCents} 分 ≠ 明细 ${id.detailCents} 分`);
    return verdict('已保存', '转人工');
  }
  if (mode === 'new' && noBill) {
    if (!imported) {
      reasons.push('收票网格 0 行：ERP 上没落任何东西，发票没被消耗');
      return verdict('未保存·导入前', '原地等待');
    }
    if (detail.totalCents === 0) {
      reasons.push(`收票 ${receipts.rowCount} 行、明细${DETAIL_COLUMN}合计为 0：发票已被 ERP 消耗，明细还没写`);
      return verdict('未保存·已导入未写明细', '转人工');
    }
    if (receipts.totalCents === detail.totalCents) {
      reasons.push(`两边都是 ${receipts.totalCents} 分，按分相等，差保存这一下`);
      return verdict('未保存·就绪待保存', '原地等待');
    }
    reasons.push(`收票 ${receipts.totalCents} 分与明细 ${detail.totalCents} 分不等`);
    return verdict('不自洽', '转人工');
  }
  // 新增却有单号 / 修改却无单号：原样报读数，不解释。
  reasons.push(`页签是「${mode === 'modify' ? '修改' : '新增'}」，单据编号${billNo.value ? `是 ${billNo.value}` : '为空'}，两者对不上`);
  return verdict('不自洽', '转人工');
}

/** 恒等式：两边含税、按分整数比较、零容差。 */
function identityOf(receipts, detail) {
  const applicable = !!(receipts?.readable && detail?.readable);
  return {
    applicable,
    receiptsCents: receipts?.readable ? receipts.totalCents : null,
    detailCents: detail?.readable ? detail.totalCents : null,
    equal: applicable && receipts.totalCents === detail.totalCents,
  };
}

/**
 * 只读采集四项读数（外加一项旁证）。**不做判定**，也不点击、不滚动、不导航、不写入——
 * 这个函数里一次 `Input.*` 都不发。
 *
 * 明细网格是懒渲染的：没被点开过就不在 DOM 里，那时明细这一项就是读不到。
 * 对账不会替用户去点开它 —— 点开是页面副作用，而这里的立场是一个字都不改。
 */
export async function readReconciliation(page, {
  // These hooks keep the collector testable without a browser. The defaults
  // are the ego-only reader above; no Chrome session shape is accepted there.
  readTabs = readFormTabs,
  readHeader = readHeaderField,
  readGrid = readGridByColumn,
  expectedLines = null,
  expectedPreview = null,
} = {}) {
  const tabs = await readTabs(page);
  const formMode = tabs.length === 1
    ? { readable: true, value: tabs[0].mode }
    : { readable: false, value: null,
        reason: tabs.length === 0
          ? '页面上没有打开的费用报销单（既没有「新增」也没有「修改」页签）'
          : `页面上同时开着 ${tabs.length} 个费用报销单页签（${tabs.map((t) => t.label).join('、')}），认不出对的是哪一张` };

  const bill = await readHeader(page, 'FBILLNO');
  const billNo = bill.ok
    ? { readable: true, value: bill.value === '' ? null : bill.value }
    : { readable: false, value: null, reason: bill.reason };

  const receiptsGrid = await readGrid(page, RECEIPTS_COLUMN);
  const detailGrid = await readGrid(page, DETAIL_COLUMN);

  const receipts = sumColumn(receiptsGrid, RECEIPTS_COLUMN);
  const detail = sumColumn(detailGrid, DETAIL_COLUMN);
  // 旁证：和明细同一个网格，读不到就算了，它不进判定。
  const payable = sumColumn(detailGrid, PAYABLE_COLUMN);
  const expected = expectedPreview ?? expectedLines;

  return { formMode, billNo, receipts, detail,
    payable: { readable: payable.readable, totalCents: payable.totalCents },
    // Keep the raw, serialized rows available to a later strict line matcher.
    // attemptRecord deliberately projects these down to totals and counts.
    receiptsGrid, detailGrid,
    taskMatch: expected ? matchTaskLines(detailGrid, expected, receiptsGrid) : null };
}

const textOf = (value) => (value === null || value === undefined ? '' : String(value))
  .normalize('NFKC').replace(/\s+/g, ' ').trim();

const expectedLinesOf = (expected) => Array.isArray(expected) ? expected : expected?.lines;

const amountOf = (value) => {
  if (value === null || value === undefined || textOf(value) === '') return null;
  return toCents(value);
};

const dateOf = (value) => {
  const s = textOf(value);
  const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(s)
    ?? /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1
      || d.getUTCDate() !== day) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const columnOf = (grid, label) => grid?.columns?.some((column) => column.label === label) === true;

const dataRowsOf = (grid) => grid?.ok === true && Array.isArray(grid.rows)
  ? grid.rows.filter((row) => row.kind === 'data') : [];

const sumKnown = (values) => values.every((value) => value !== null)
  ? values.reduce((sum, value) => sum + value, 0) : null;

const receiptNumberOf = (value) => {
  const s = textOf(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) ? s : null;
};

const invoiceNumberOf = (value) => {
  const s = textOf(value).replace(/\s+/g, '');
  const matches = s.match(/\d{20}/g) ?? [];
  return matches.length === 1 ? matches[0] : null;
};

// ERP may mask the middle of a 20-digit invoice number. Only the exact full
// number or an exact four-digit prefix/suffix mask is trusted; arbitrary
// fragments would let an equal-amount receipt pass as the wrong material.
const invoiceMatches = (actual, expected) => {
  const actualText = textOf(actual).replace(/\s+/g, '');
  const expectedText = textOf(expected);
  if (!/^\d{20}$/.test(expectedText)) return false;
  if (actualText === expectedText) return true;
  const masked = /^(\d{4})\*+(\d{4})$/.exec(actualText);
  return !!masked && expectedText.startsWith(masked[1]) && expectedText.endsWith(masked[2]);
};

const normalizeReceiptBinding = (raw, index) => {
  const voucherMaterialId = textOf(raw?.voucherMaterialId);
  const identityKey = textOf(raw?.identityKey ?? raw?.invoiceIdentityKey);
  const identity = /^einvoice-20:(\d{20})$/.exec(identityKey);
  const invoiceNumber = textOf(raw?.invoiceNumber) || identity?.[1] || '';
  const receiptNumber = receiptNumberOf(raw?.receiptNumber ?? raw?.receiptNo);
  return {
    index, voucherMaterialId, identityKey, invoiceNumber, receiptNumber,
    valid: !!voucherMaterialId && !!identity && invoiceNumber === identity[1] && !!receiptNumber,
  };
};

const receiptBindingsOf = (expected) => {
  if (!Array.isArray(expected?.receiptBindings)) return { present: false, bindings: [] };
  return { present: true, bindings: expected.receiptBindings.map(normalizeReceiptBinding) };
};

const projectSourceConfirmed = (line, expected) => textOf(expected?.projectSource) === 'erp_catalog_confirmed'
  && textOf(expected?.projectsFrom) === 'project_book'
  && textOf(line?.projectSource) === 'erp_catalog_confirmed'
  && textOf(line?.projectsFrom) === 'project_book';

const accommodationLine = (line) => textOf(line?.category) === 'accommodation';
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票']);
const validInvoiceTypeSource = (value) => {
  const source = textOf(value);
  return !!source && !/(?:unknown|guess|guessed|inferred|default|fallback|猜|推断|默认)/i.test(source);
};

/**
 * 把当前 ERP 明细和已确认的写入预览逐行核对。
 *
 * 这里故意没有“金额唯一就选它”的回退：项目、费用项目、开始/结束日期、
 * 不含税/税额和对应收票号必须全部相等。收票身份由预览里的绑定数组提供，
 * 再用 ERP 真实发票号（或严格的四位首尾掩码）和收票号定位，金额不能建立身份。
 */
export function matchTaskLines(grid, expected, receiptsGrid = null) {
  const expectedLines = expectedLinesOf(expected);
  const reasons = [];
  const amountSources = [];
  if (!Array.isArray(expectedLines) || expectedLines.length === 0) {
    return { ok: false, reasons: ['没有可用于逐行核对的已确认明细预览'], amountSources };
  }
  if (!grid?.ok) return { ok: false, reasons: ['无法逐行核对当前任务明细'], amountSources };
  if (Array.isArray(expected)) reasons.push('逐行核对必须使用包含来源和 receiptBindings 的 expectedPreview');
  if (textOf(expected?.projectSource) !== 'erp_catalog_confirmed'
      || textOf(expected?.projectsFrom) !== 'project_book') {
    reasons.push('expectedPreview 缺少 erp_catalog_confirmed/project_book 来源证据');
  }

  const rows = dataRowsOf(grid);
  if (rows.length !== expectedLines.length) {
    reasons.push(`任务要求 ${expectedLines.length} 条明细，ERP 实际为 ${rows.length} 条`);
  }

  const expectedData = expectedLines.map((line, index) => {
    const total = amountOf(line?.totalAmount);
    const net = line?.netAmount === null ? null : amountOf(line?.netAmount);
    const tax = line?.taxAmount === null ? null : amountOf(line?.taxAmount);
    const hasNet = Object.prototype.hasOwnProperty.call(line ?? {}, 'netAmount');
    const hasTax = Object.prototype.hasOwnProperty.call(line ?? {}, 'taxAmount');
    const lineId = textOf(line?.lineId) || `line-${index + 1}`;
    const voucherMaterialId = textOf(line?.voucherMaterialId);
    const kind = textOf(line?.kind);
    const projectCode = textOf(line?.projectCode ?? line?.projectNumber);
    const projectName = textOf(line?.projectName);
    const expenseItemCode = textOf(line?.expenseItemCode);
    const expenseItem = textOf(line?.expenseItemName);
    const invoiceType = textOf(line?.invoiceTypeLabel ?? line?.invoiceType);
    const date = dateOf(line?.date);
    const explicitEndDate = dateOf(line?.endDate ?? line?.checkOut);
    const endDate = explicitEndDate ?? (!accommodationLine(line) ? date : null);
    if (total === null) reasons.push(`任务第 ${index + 1} 行没有有效的价税合计预览`);
    if (!hasNet) reasons.push(`任务第 ${index + 1} 行缺少不含税金额来源（未知值也必须显式为 null）`);
    else if (line.netAmount !== null && net === null) reasons.push(`任务第 ${index + 1} 行的不含税金额预览无效`);
    if (!hasTax) reasons.push(`任务第 ${index + 1} 行缺少税额来源（未知值也必须显式为 null）`);
    else if (line.taxAmount !== null && tax === null) reasons.push(`任务第 ${index + 1} 行的税额预览无效`);
    if (kind !== 'rail_eticket' && (net === null || tax === null)) {
      reasons.push(`任务第 ${index + 1} 行不是铁路客票，却缺少票面不含税金额或税额；不能从收票替代票面事实`);
    }
    if (!voucherMaterialId) reasons.push(`任务第 ${index + 1} 行缺少 voucherMaterialId`);
    if (!projectCode || !projectName) reasons.push(`任务第 ${index + 1} 行缺少已核验的项目编码和完整名称`);
    if (!projectSourceConfirmed(line, expected)) {
      reasons.push(`任务第 ${index + 1} 行的项目来源不是 project_book + erp_catalog_confirmed`);
    }
    if (!expenseItemCode || !expenseItem) reasons.push(`任务第 ${index + 1} 行缺少完整的费用项目编码和名称`);
    if (!date) reasons.push(`任务第 ${index + 1} 行没有有效的费用日期预览`);
    if (!endDate) reasons.push(`任务第 ${index + 1} 行没有有效的结束日期预览`);
    if (!ERP_INVOICE_TYPES.has(invoiceType)) reasons.push(`任务第 ${index + 1} 行缺少有效 ERP 发票类型枚举`);
    if (!validInvoiceTypeSource(line?.invoiceTypeSource)) {
      reasons.push(`任务第 ${index + 1} 行缺少发票类型映射出处`);
    }
    return {
      line, index, lineId, voucherMaterialId, kind, total, net, tax, projectCode, projectName,
      expenseItemCode, expenseItem, date, endDate,
      invoiceType,
      groupKey: voucherMaterialId || `line-${index + 1}`,
    };
  });

  const groups = new Map();
  for (const item of expectedData) {
    const group = groups.get(item.groupKey) ?? { key: item.groupKey, items: [] };
    group.items.push(item);
    groups.set(item.groupKey, group);
  }

  const receiptGroups = new Map();
  const receiptRows = dataRowsOf(receiptsGrid);
  const receiptUsed = new Set();
  const bindings = receiptBindingsOf(expected);
  const bindingByGroup = new Map();
  const bindingInvoices = new Set();
  const bindingReceipts = new Set();
  if (receiptsGrid === null) reasons.push('没有提供收票网格，不能核对收票身份和三项金额守恒');
  if (!bindings.present) reasons.push('收票逐凭证核对缺少 expectedPreview.receiptBindings，不能用金额代替唯一身份');
  for (const binding of bindings.bindings) {
    if (!binding.valid) {
      reasons.push(`第 ${binding.index + 1} 条收票身份绑定缺少可信的 voucherMaterialId、发票号或收票号`);
      continue;
    }
    if (!groups.has(binding.voucherMaterialId)) {
      reasons.push(`收票身份绑定 ${binding.voucherMaterialId} 不在已确认明细预览中`);
      continue;
    }
    if (bindingByGroup.has(binding.voucherMaterialId)) {
      reasons.push(`任务凭证组 ${binding.voucherMaterialId} 有重复的收票身份绑定`);
      continue;
    }
    if (bindingInvoices.has(binding.invoiceNumber) || bindingReceipts.has(binding.receiptNumber)) {
      reasons.push(`收票身份 ${binding.voucherMaterialId} 与另一凭证重复，不能安全核对`);
      continue;
    }
    bindingByGroup.set(binding.voucherMaterialId, binding);
    bindingInvoices.add(binding.invoiceNumber);
    bindingReceipts.add(binding.receiptNumber);
  }
  for (const group of groups.values()) {
    if (!bindingByGroup.has(group.key)) {
      reasons.push(`任务凭证组 ${group.key} 没有可信的发票号/收票号绑定，不能安全核对`);
    }
  }
  const receiptColumns = [RECEIPTS_COLUMN, RECEIPT_NET_COLUMN, TAX_COLUMN,
    RECEIPT_NUMBER_COLUMN, INVOICE_NUMBER_COLUMN];
  const receiptsReadable = receiptsGrid?.ok === true;
  for (const column of receiptColumns) {
    if (receiptsReadable && !columnOf(receiptsGrid, column)) {
      reasons.push(`收票网格没有「${column}」列，不能逐凭证核对`);
    }
  }
  const identityColumnsReadable = receiptsReadable
    && columnOf(receiptsGrid, RECEIPTS_COLUMN)
    && columnOf(receiptsGrid, RECEIPT_NET_COLUMN)
    && columnOf(receiptsGrid, TAX_COLUMN)
    && columnOf(receiptsGrid, RECEIPT_NUMBER_COLUMN)
    && columnOf(receiptsGrid, INVOICE_NUMBER_COLUMN);
  if (receiptsGrid !== null && !receiptsReadable) {
    reasons.push('对应收票网格无法读取，不能核对各行身份和金额');
  }

  for (const group of groups.values()) {
    const binding = bindingByGroup.get(group.key);
    if (!identityColumnsReadable || !binding) {
      receiptGroups.set(group.key, { group, row: null, receiptIndex: null });
      continue;
    }
    const candidates = receiptRows.filter((row, index) => {
      if (receiptUsed.has(index)) return false;
      const values = row.values ?? {};
      return receiptNumberOf(values[RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber
        && invoiceMatches(values[INVOICE_NUMBER_COLUMN], binding.invoiceNumber);
    });
    if (candidates.length !== 1) {
      const sameReceipt = receiptRows.filter((row, index) => !receiptUsed.has(index)
        && receiptNumberOf(row.values?.[RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber);
      reasons.push(candidates.length === 0 && sameReceipt.length
        ? `任务凭证组 ${group.key} 的收票号对应发票号与预览不一致`
        : candidates.length === 0
          ? `任务凭证组 ${group.key} 没有唯一对应的 ERP 收票行`
          : `任务凭证组 ${group.key} 对应多条 ERP 收票行，无法安全核对`);
      receiptGroups.set(group.key, { group, row: null, receiptIndex: null });
      continue;
    }
    const row = candidates[0];
    const receiptIndex = receiptRows.indexOf(row);
    receiptUsed.add(receiptIndex);
    const actualGross = amountOf(row.values?.[RECEIPTS_COLUMN]);
    const actualNet = amountOf(row.values?.[RECEIPT_NET_COLUMN]);
    const actualTax = amountOf(row.values?.[TAX_COLUMN]);
    const expectedGross = sumKnown(group.items.map((item) => item.total));
    if (actualGross === null || actualNet === null || actualTax === null) {
      reasons.push(`任务凭证组 ${group.key} 的收票不含税金额、税额或价税合计不可读`);
    }
    if (actualGross !== null && actualNet !== null && actualTax !== null
        && actualNet + actualTax !== actualGross) {
      reasons.push(`任务凭证组 ${group.key} 的收票不含税金额与税额不守恒`);
    }
    if (expectedGross === null || actualGross === null || expectedGross !== actualGross) {
      reasons.push(`任务凭证组 ${group.key} 的收票价税合计与已确认预览不一致`);
    }
    receiptGroups.set(group.key, { group, row, receiptIndex, actualGross, actualNet, actualTax });
  }
  if (identityColumnsReadable) {
    for (const [index] of receiptRows.entries()) {
      if (!receiptUsed.has(index)) reasons.push(`ERP 收票第 ${index + 1} 行没有对应的已确认任务凭证`);
    }
  }

  for (const item of expectedData) {
    const receiptGroup = receiptGroups.get(item.groupKey);
    const singleLine = receiptGroup?.group.items.length === 1;
    const receipt = singleLine ? receiptGroup?.row : null;
    const receiptNet = receipt ? amountOf(receipt.values?.[RECEIPT_NET_COLUMN]) : null;
    const receiptTax = receipt ? amountOf(receipt.values?.[TAX_COLUMN]) : null;
    const targetNet = item.net ?? (singleLine ? receiptNet : null);
    const targetTax = item.tax ?? (singleLine ? receiptTax : null);
    const netSource = item.net === null ? (targetNet === null ? 'unknown' : 'erp_receipt') : 'expected_preview';
    const taxSource = item.tax === null ? (targetTax === null ? 'unknown' : 'erp_receipt') : 'expected_preview';
    amountSources.push({ line: item.index + 1, net: netSource, tax: taxSource });
    if (item.net === null && targetNet === null) {
      reasons.push(`任务第 ${item.index + 1} 行不含税金额在票面未知，且对应收票没有可读值；不从合计反推`);
    }
    if (item.tax === null && targetTax === null) {
      reasons.push(`任务第 ${item.index + 1} 行税额在票面未知，且对应收票没有可读值；不从合计反推`);
    }
    item.targetNet = targetNet;
    item.targetTax = targetTax;
  }

  const detailColumns = [DETAIL_COLUMN, NET_COLUMN, TAX_COLUMN, PROJECT_COLUMN,
    EXPENSE_ITEM_COLUMN, START_DATE_COLUMN, END_DATE_COLUMN, DETAIL_RECEIPT_NUMBER_COLUMN];
  detailColumns.push(INVOICE_TYPE_COLUMN);
  for (const column of detailColumns) {
    if (!columnOf(grid, column)) reasons.push(`明细网格没有「${column}」列，不能完整逐行核对`);
  }
  const detailReadable = detailColumns.every((column) => columnOf(grid, column));
  const usedRows = new Set();
  const matchedByGroup = new Map();
  for (const item of expectedData) {
    if (item.total === null || item.targetNet === null || item.targetTax === null) continue;
    const binding = bindingByGroup.get(item.groupKey);
    if (!detailReadable || !binding) continue;
    const candidates = rows.map((row, index) => ({ row, index })).filter(({ row, index }) => {
      if (usedRows.has(index)) return false;
      const values = row.values ?? {};
      return amountOf(values[DETAIL_COLUMN]) === item.total
        && textOf(values[PROJECT_COLUMN]) === item.projectName
        && textOf(values[EXPENSE_ITEM_COLUMN]) === item.expenseItem
        && dateOf(values[START_DATE_COLUMN]) === item.date
        && dateOf(values[END_DATE_COLUMN]) === item.endDate
        && amountOf(values[NET_COLUMN]) === item.targetNet
        && amountOf(values[TAX_COLUMN]) === item.targetTax
        && receiptNumberOf(values[DETAIL_RECEIPT_NUMBER_COLUMN]) === binding.receiptNumber
        && textOf(values[INVOICE_TYPE_COLUMN]) === item.invoiceType;
    });
    if (candidates.length !== 1) {
      reasons.push(candidates.length > 1
        ? `任务第 ${item.index + 1} 行有多条 ERP 明细满足相同字段，无法安全逐行对应`
        : `任务第 ${item.index + 1} 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的 ERP 明细；金额相等不能代替逐行一致`);
      continue;
    }
    const chosen = candidates[0];
    usedRows.add(chosen.index);
    const values = chosen.row.values ?? {};
    const matched = matchedByGroup.get(item.groupKey) ?? [];
    matched.push({ item, actualNet: amountOf(values[NET_COLUMN]), actualTax: amountOf(values[TAX_COLUMN]),
      actualTotal: amountOf(values[DETAIL_COLUMN]) });
    matchedByGroup.set(item.groupKey, matched);
  }
  if (detailReadable) {
    for (const [index] of rows.entries()) {
      if (!usedRows.has(index)) reasons.push(`ERP 明细第 ${index + 1} 行没有对应的已确认任务明细`);
    }
  }

  // 每张收票分别验证不含税、税额和价税合计守恒，不能只比较全单总额。
  for (const [key, receiptGroup] of receiptGroups) {
    if (!receiptGroup.row) continue;
    const matched = matchedByGroup.get(key) ?? [];
    if (matched.length !== receiptGroup.group.items.length) continue;
    const detailNet = sumKnown(matched.map((line) => line.actualNet));
    const detailTax = sumKnown(matched.map((line) => line.actualTax));
    const detailGross = sumKnown(matched.map((line) => line.actualTotal));
    if (detailNet === null || detailTax === null || detailGross === null) {
      reasons.push(`任务凭证组 ${key} 的明细金额不可读，不能验证三项守恒`);
      continue;
    }
    if (detailNet !== receiptGroup.actualNet) reasons.push(`任务凭证组 ${key} 的明细不含税金额合计与对应收票不一致`);
    if (detailTax !== receiptGroup.actualTax) reasons.push(`任务凭证组 ${key} 的明细税额合计与对应收票不一致`);
    if (detailGross !== receiptGroup.actualGross) reasons.push(`任务凭证组 ${key} 的明细价税合计与对应收票不一致`);
  }

  return { ok: reasons.length === 0, reasons, amountSources };
}

/**
 * 审计记录：四项读数、中断点、处置。
 * 只留**脱敏的事实**（金额的分、行数、原因），不留页面副本 —— 它不还原报销内容。
 */
export function attemptRecord({ bucket, action, identity, reasons, readings }) {
  const cell = (r) => ({ readable: !!r?.readable, totalCents: r?.readable ? r.totalCents : null,
    rowCount: r?.readable ? r.rowCount : null, reason: r?.reason ?? null });
  return {
    at: new Date().toISOString(),
    kind: 'erp-reconcile',
    bucket, action, identity, reasons,
    readings: {
      formMode: { readable: !!readings.formMode?.readable, value: readings.formMode?.value ?? null,
        reason: readings.formMode?.reason ?? null },
      // 单据编号是 ERP 生成的单号，不是报销内容，原样留着才够复原当时的判断依据。
      billNo: { readable: !!readings.billNo?.readable, value: readings.billNo?.value ?? null,
        reason: readings.billNo?.reason ?? null },
      receipts: cell(readings.receipts),
      detail: cell(readings.detail),
      payable: { readable: !!readings.payable?.readable, totalCents: readings.payable?.totalCents ?? null },
      taskMatch: readings.taskMatch ?? null,
    },
  };
}
