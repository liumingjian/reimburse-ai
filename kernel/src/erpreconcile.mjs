import { formTabs, readGridByColumn, headerField } from './erpform.mjs';

// ERP 对账：把当前这张费用报销单归到一个**对账中断点**，并给出仅有的两种处置。
// 契约在 docs/research/erp-expense-flow/save-contract.md 的「erp-reconcile 判定契约」一节
// （issue #36 定，issue #35 的真单读数推出来的）。这个模块一个字都不往 ERP 写。
//
// 拆成两半是为了让判定能不开浏览器测：
//   classifyReconciliation(readings) —— 纯函数，不碰 session、不碰时间。
//   readReconciliation(session)      —— 只读采集，不做任何判定。
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
export async function readReconciliation(session) {
  const tabs = await formTabs(session);
  const formMode = tabs.length === 1
    ? { readable: true, value: tabs[0].mode }
    : { readable: false, value: null,
        reason: tabs.length === 0
          ? '页面上没有打开的费用报销单（既没有「新增」也没有「修改」页签）'
          : `页面上同时开着 ${tabs.length} 个费用报销单页签（${tabs.map((t) => t.label).join('、')}），认不出对的是哪一张` };

  const bill = await headerField(session, 'FBILLNO', { scroll: false });
  const billNo = bill.ok
    ? { readable: true, value: bill.value === '' ? null : bill.value }
    : { readable: false, value: null, reason: bill.reason };

  const receiptsGrid = await readGridByColumn(session, RECEIPTS_COLUMN);
  const detailGrid = await readGridByColumn(session, DETAIL_COLUMN);

  const receipts = sumColumn(receiptsGrid, RECEIPTS_COLUMN);
  const detail = sumColumn(detailGrid, DETAIL_COLUMN);
  // 旁证：和明细同一个网格，读不到就算了，它不进判定。
  const payable = sumColumn(detailGrid, PAYABLE_COLUMN);

  return { formMode, billNo, receipts, detail,
    payable: { readable: payable.readable, totalCents: payable.totalCents } };
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
    },
  };
}
