import fs from 'node:fs';
import path from 'node:path';
import { taskDir } from './workspace.mjs';
import { maskNumber } from './parse.mjs';

// 费用事件与候选明细。
//
// 一个`费用事件`代表现实中发生过的一次费用：交通按一个可辨识的行程段，
// 连续住宿按一次连续入住，火车票按一张票。一个事件恰好有一个主要报销凭证，
// 参考材料零个或多个；一个事件投影成一条`候选明细`。
//
// 这一层的两条纪律：
//
//   1. **拆分必须有证据。** 三段合并交通发票之所以能拆成三个事件，是因为
//      行程单上逐行写着三段行程。没有这个证据就不拆 —— 不按金额猜、不按文件名猜。
//   2. **金额不能由系统分摊。** 系统不平均、不按比例、不按距离、不按时长 ——
//      这几种都是在票面事实之外**造**一个数出来。差额落在哪一段只有用户知道。
//
//      唯一的例外不是分摊，是**核对**：行程单逐段金额之和与票面价税合计分毫不差时，
//      这几个数已经被票面自己印证过了，内核直接定案，一个字都不问
//      （state-machine.md 的 allocation_required 一行：「相等则内核自动定案，不进此态」）。
//      差一分钱就整张退回用户逐段给 —— 那时候行程单只是候选，不是答案。

/** 参考材料自己声明的合计金额，单位分。用来和主要凭证的价税合计对上。 */
function referenceTotalCents(r) {
  const c = (f) => r.candidates?.find((x) => x.field === f)?.value;
  const text = c('itineraryTotal') ?? c('folioTotal');
  if (text) return Math.round(Number(String(text).replace(/,/g, '')) * 100);
  // 看图读取的参考材料没有这两个候选，读数里的 totalAmount 就是它声明的合计。
  return r.fields?.totalAmount?.cents ?? null;
}

/** 行程单声明的逐段明细。取不到就是取不到，不构造。 */
const segmentsOf = (r) => r?.candidates?.find((x) => x.field === 'segments')?.value ?? null;

/**
 * 从一份材料上取某个字段。已解析值优先，其次是字段候选 ——
 * 看图读取的参考材料把日期、城市、起终点放在候选里（它们不是法定事实，
 * 但确实是那份材料上印着的字）。
 */
const factOf = (r, key) => r?.fields?.[key] ?? r?.candidates?.find((x) => x.field === key)?.value ?? null;

/**
 * 材料证据关联。不做两两配对，只按**声明的合计金额相等**这一条确定性规则连线，
 * 而且要求唯一：一个金额同时对上多份材料就是有歧义，必须由用户处置，不能随便挑一个。
 */
export function linkEvidence(vouchers, references) {
  const links = new Map(vouchers.map((v) => [v.materialId, []]));
  const usedBy = new Map(references.map((r) => [r.materialId, []]));

  for (const ref of references) {
    const cents = referenceTotalCents(ref);
    if (cents === null) continue;
    for (const v of vouchers) {
      if (v.fields?.totalAmount?.cents === cents) usedBy.get(ref.materialId).push(v.materialId);
    }
  }
  const ambiguous = [];
  for (const ref of references) {
    const hits = usedBy.get(ref.materialId);
    if (hits.length === 1) links.get(hits[0]).push(ref.materialId);
    else if (hits.length > 1) ambiguous.push({ materialId: ref.materialId, fileName: ref.fileName, vouchers: hits });
  }
  // 反过来也要唯一：同一张发票对上两份同类参考材料（两份行程单），同样有歧义。
  for (const [voucherId, refIds] of links) {
    const kinds = new Map();
    for (const id of refIds) {
      const k = references.find((r) => r.materialId === id).kind;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    for (const [k, n] of kinds) {
      if (n > 1) ambiguous.push({ materialId: voucherId, sameKind: k, count: n });
    }
  }
  const unlinked = references.filter((r) => (usedBy.get(r.materialId) ?? []).length === 0);
  return { links, ambiguous, unlinked };
}

/* ---------------------------------------------------------------- 逐段分摊 */

const allocDir = (task) => path.join(taskDir(task), 'allocations');
const allocFile = (task, materialId) => path.join(allocDir(task), `${materialId}.json`);

export function loadAllocation(task, materialId) {
  if (!task?.createdAt) return null;
  try { return JSON.parse(fs.readFileSync(allocFile(task, materialId), 'utf8')); } catch { return null; }
}

/**
 * 把每段价税合计切成不含税和税额。
 *
 * 这不是"分摊费用"，而是把一个**已经确定**的价税合计按发票自己票面的
 * 不含税/价税比拆成两截 —— 税率是票面事实，不是推测。切完必须与票面三项
 * 分别守恒；分位除不尽时余数落在价税合计最大的那一段（并列取最靠前的一段），
 * 并把这件事如实报出来，不藏。
 */
export function splitTax(segTotals, netTotal, taxTotal) {
  const total = segTotals.reduce((a, b) => a + b, 0);
  if (total !== netTotal + taxTotal) return null;
  const nets = segTotals.map((t) => Math.round((t * netTotal) / total));
  const residue = netTotal - nets.reduce((a, b) => a + b, 0);
  let residueOn = null;
  if (residue !== 0) {
    let idx = 0;
    for (let i = 1; i < segTotals.length; i += 1) if (segTotals[i] > segTotals[idx]) idx = i;
    nets[idx] += residue;
    residueOn = idx;
  }
  const taxes = segTotals.map((t, i) => t - nets[i]);
  if (nets.some((n) => n < 0) || taxes.some((t) => t < 0)) return null;
  if (nets.reduce((a, b) => a + b, 0) !== netTotal) return null;
  if (taxes.reduce((a, b) => a + b, 0) !== taxTotal) return null;
  return { nets, taxes, residueCents: residue, residueOn };
}

/**
 * 一个金额写下来该长什么样：两位小数的正数。**一处定义** ——
 * 终端多选和行程单核对两处收的是同一种东西，各写一份的话，
 * 迟早有一处比别处松（比如把 0.00 收进来），而松的那一处不会有人发现。
 */
export const MONEY = /^\d{1,9}\.\d{2}$/;

/** 一串钱转成分；不合格（格式不对、不大于 0）就是 null。 */
export function moneyCents(text) {
  const s = String(text ?? '').trim();
  if (!MONEY.test(s)) return null;
  const c = Math.round(Number(s) * 100);
  return c > 0 ? c : null;
}

/**
 * 逐段分摊那两种开放项。它们各有自己的状态，不混进材料待办 ——
 * 一处定义，三处使用（观测里挑出来问、观测里排除出待办、收答案时认凭据）。
 */
export const ALLOCATION_KINDS = new Set(['allocation_required', 'allocation_stale']);

/**
 * 收下一次用户提交的逐段金额。校验是**结构性**的：段数对得上、金额格式合法、
 * 逐段价税合计之和与票面价税合计**按分精确相等**。差一分都不收 ——
 * 不给"接近就行"的余地，也不替用户把差额抹到某一段上。
 */
export function submitAllocation(task, voucher, segmentTotals, expectedCount, { via = 'terminal' } = {}) {
  const reasons = [];
  if (!Array.isArray(segmentTotals) || segmentTotals.length !== expectedCount) {
    reasons.push(`需要 ${expectedCount} 段金额，收到 ${Array.isArray(segmentTotals) ? segmentTotals.length : 0} 段`);
  }
  const cents = [];
  for (const [i, v] of (segmentTotals ?? []).entries()) {
    const c = moneyCents(v);
    if (c === null) { reasons.push(`第 ${i + 1} 段的金额格式不对（要两位小数、且大于 0）`); continue; }
    cents.push(c);
  }
  const totalCents = voucher.fields?.totalAmount?.cents ?? null;
  if (totalCents === null) reasons.push('这张发票没有取到价税合计，无法核对分摊');
  if (!reasons.length) {
    const sum = cents.reduce((a, b) => a + b, 0);
    if (sum !== totalCents) {
      reasons.push(`逐段价税合计相加 ${(sum / 100).toFixed(2)}，与票面价税合计 ${(totalCents / 100).toFixed(2)} `
        + `差 ${((sum - totalCents) / 100).toFixed(2)}；请逐段核对，不要把差额随便加到某一段上`);
    }
  }
  if (reasons.length) return { verdict: 'rejected', reasons };

  const record = {
    materialId: voucher.materialId,
    // 分摊绑定在发票的这一串字节上；材料一换，分摊自动失效。
    contentHash: voucher.contentHash,
    segmentCount: expectedCount,
    segmentTotalCents: cents,
    submittedAt: new Date().toISOString(),
    // 这几个数是在哪儿给的。1.0.0 起只剩终端多选一条路（本地分摊页已下线），
    // 但事后排障时「用户在哪儿说的这句话」仍然要能查出来 —— 旧任务里存着 `local-web`。
    submittedVia: via,
  };
  fs.mkdirSync(allocDir(task), { recursive: true, mode: 0o700 });
  const p = allocFile(task, voucher.materialId);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
  return { verdict: 'accepted', reasons: [], record };
}

/* ------------------------------------------------------------ 事件与明细 */

/**
 * 行程单逐段金额与票面价税合计**分毫不差**时的那几个数，单位分；对不上就是 null。
 *
 * 判据只有一条：按分精确相等。不设容差 —— 一分钱的容差意味着这一分钱没有来源，
 * 而它最后一定要落在某一段上，也就是由内核替用户决定它落在哪里。
 */
export function conservingSegments(segments, totalCents) {
  if (!segments || totalCents === null || totalCents === undefined) return null;
  const cents = [];
  for (const seg of segments) {
    const c = moneyCents(seg?.amount);
    if (c === null) return null;
    cents.push(c);
  }
  if (!cents.length) return null;
  return cents.reduce((a, b) => a + b, 0) === totalCents ? cents : null;
}

/** 一张主要凭证要拆成几个事件，以及依据是什么。拆分永远要有证据。 */
function planSegments(voucher, refs) {
  if (voucher.kind === 'rail_eticket') {
    return { count: 1, basis: 'rail_ticket', segments: null,
      note: '一张铁路电子客票就是一次费用' };
  }
  if (voucher.kind === 'vat_special' || voucher.kind === 'vat_common') {
    return { count: 1, basis: 'single_stay', segments: null,
      note: '按一次连续入住作一个费用事件' };
  }
  const itinerary = refs.find((r) => r.kind === 'ride_itinerary');
  const rows = segmentsOf(itinerary);
  if (rows && rows.length > 1) {
    return { count: rows.length, basis: 'itinerary_rows', segments: rows,
      note: `行程单逐行列出 ${rows.length} 段行程，因此拆成 ${rows.length} 个费用事件` };
  }
  if (rows && rows.length === 1) {
    return { count: 1, basis: 'itinerary_rows', segments: rows, note: '行程单只有一段行程' };
  }
  if (itinerary) {
    return { count: 1, basis: 'itinerary_without_rows', segments: null,
      note: '有行程单，但没取到逐段明细，按一次行程处理；'
        + '如果这张行程单其实列了多段行程，请重新读取或改用可提取文字的原件' };
  }
  return { count: 1, basis: 'no_itinerary', segments: null,
    note: '没有行程单佐证，按一次行程处理；如果这张票其实包含多段行程，请补充行程单' };
}

/**
 * 从分流结果构建费用事件和候选明细。
 * `task` 用来读已提交的逐段分摊；没有 task 就一律当作还没分摊。
 */
export function buildEvents(classification, task = null) {
  const usable = classification.results.filter((r) => r.parseStatus === 'parsed');
  const vouchers = usable.filter((r) => r.role === 'primary_voucher');
  const references = usable.filter((r) => r.role === 'reference');
  const { links, ambiguous, unlinked } = linkEvidence(vouchers, references);

  const events = [];
  const notes = [];

  for (const v of vouchers) {
    const refIds = links.get(v.materialId) ?? [];
    const refs = refIds.map((id) => references.find((r) => r.materialId === id));
    const plan = planSegments(v, refs);
    const base = {
      voucherMaterialId: v.materialId,
      voucherFileName: v.fileName,
      kind: v.kind,
      kindLabel: v.kindLabel ?? null,
      maskedNumber: maskNumber(v.fields?.invoiceNumber),
      referenceMaterialIds: refIds,
      splitBasis: plan.basis,
      splitNote: plan.note,
    };

    if (plan.count === 1) {
      events.push({ ...base, index: 1, of: 1,
        ...singleEventFacts(v, refs, plan),
        amounts: {
          netCents: v.fields?.netAmount?.cents ?? null,
          taxCents: v.fields?.taxAmount?.cents ?? null,
          totalCents: v.fields?.totalAmount?.cents ?? null,
        },
        amountSource: 'invoice_face',
        residueCents: 0,
      });
      continue;
    }

    // 多段：金额要么来自用户提交的逐段分摊，要么来自与票面分毫不差的行程单。
    const alloc = loadAllocation(task, v.materialId);
    const fresh = alloc && alloc.contentHash === v.contentHash && alloc.segmentCount === plan.count;
    const net = v.fields?.netAmount?.cents ?? null;
    const tax = v.fields?.taxAmount?.cents ?? null;
    const total = v.fields?.totalAmount?.cents ?? null;
    // 用户明确给过的分摊优先于行程单：他是对着原件报的数，行程单只是一份参考材料。
    const conserved = fresh ? null : conservingSegments(plan.segments, total);

    if (net === null || tax === null || total === null) {
      notes.push({ kind: 'allocation_amounts_incomplete', blocking: true,
        materialId: v.materialId, fileName: v.fileName, segmentCount: plan.count,
        note: '这张票要拆成多段，但票面不含税金额、税额、价税合计没取全，无法做逐段守恒检查' });
      continue;
    }
    if (!fresh && !conserved) {
      notes.push({
        kind: alloc ? 'allocation_stale' : 'allocation_required',
        blocking: true,
        materialId: v.materialId,
        fileName: v.fileName,
        // 分摊钉在这张票当前的字节上，问和收用的是同一个哈希 ——
        // 问到一半用户把发票换了，收上来的那几个数就不该落在新发票上。
        contentHash: v.contentHash,
        segmentCount: plan.count,
        totalAmount: (total / 100).toFixed(2),
        netAmount: (net / 100).toFixed(2),
        taxAmount: (tax / 100).toFixed(2),
        // 行程单的逐段行只作为**候选**摆出来给用户看，不自动采用：
        // 行程单是参考材料，它的金额不是票面法定金额。
        candidateSegments: plan.segments ?? null,
        candidateFromItinerary: plan.segments?.map((s) => s.amount) ?? null,
        note: alloc
          ? '发票材料变了，之前提交的逐段金额已经失效，需要重新分摊'
          : `票面只有一个合计金额，但行程单显示有 ${plan.count} 段行程，`
            + '而且逐段金额之和与票面价税合计对不上（对得上的话我自己就定了，不会来问你）；'
            + '每段的价税合计要由你直接给出，系统不会平均、按比例或按距离分摊',
      });
      continue;
    }

    const segTotals = conserved ?? alloc.segmentTotalCents;
    const split = splitTax(segTotals, net, tax);
    if (!split) {
      notes.push({ kind: 'allocation_amounts_incomplete', blocking: true,
        materialId: v.materialId, fileName: v.fileName,
        note: '逐段金额无法与票面的不含税金额和税额同时守恒，请重新提交分摊' });
      continue;
    }
    for (let i = 0; i < plan.count; i += 1) {
      const seg = plan.segments?.[i] ?? null;
      events.push({ ...base, index: i + 1, of: plan.count,
        date: seg?.date ?? null,
        city: seg?.city ?? null,
        route: seg?.route ?? null,
        dateEvidence: seg ? `行程单第 ${i + 1} 行` : null,
        amounts: { netCents: split.nets[i], taxCents: split.taxes[i], totalCents: segTotals[i] },
        // 两种来源分得清清楚楚：用户逐段报的，和内核拿行程单与票面核对上的。
        // 它们不是同一种事实，后面每一层都还看得见这个区别。
        amountSource: conserved ? 'itinerary_conserved' : 'user_allocation',
        allocatedAt: conserved ? null : alloc.submittedAt,
        residueCents: split.residueOn === i ? split.residueCents : 0,
      });
    }
  }

  // 事件编号在一次构建内稳定：按凭证材料标识排序，再按段序。
  events.sort((a, b) => (a.voucherMaterialId < b.voucherMaterialId ? -1
    : a.voucherMaterialId > b.voucherMaterialId ? 1 : a.index - b.index));
  events.forEach((e, i) => { e.eventId = `ev-${String(i + 1).padStart(2, '0')}`; });

  return {
    versionId: classification.versionId,
    builtAt: new Date().toISOString(),
    events,
    lineItems: events.map(projectLineItem),
    evidence: {
      ambiguous,
      unlinked: unlinked.map((r) => ({ materialId: r.materialId, fileName: r.fileName, kind: r.kind })),
    },
    notes,
  };
}

/** 单事件的行程事实：能从材料上取到什么就写什么，取不到就留空。 */
function singleEventFacts(v, refs, plan) {
  if (v.kind === 'rail_eticket') {
    return { date: v.fields?.travelDate ?? null, city: null,
      route: v.fields?.railFrom && v.fields?.railTo ? `${v.fields.railFrom} → ${v.fields.railTo}` : null,
      dateEvidence: v.fields?.travelDate ? '票面乘车日期' : null };
  }
  if (v.kind === 'vat_special' || v.kind === 'vat_common') {
    const folio = refs.find((r) => r.kind === 'hotel_folio');
    const c = (f) => folio?.candidates?.find((x) => x.field === f)?.value ?? null;
    const inn = c('checkIn');
    const outd = c('checkOut');
    return { date: inn, checkOut: outd, city: null, route: null,
      dateEvidence: inn ? '酒店结账单入住日期' : null };
  }
  const seg = plan.segments?.[0] ?? null;
  if (seg) {
    return { date: seg.date, city: seg.city, route: seg.route, dateEvidence: '行程单第 1 行' };
  }
  // 看图读取的行程单没有逐行明细，但读数里通常有日期、城市和起终点。
  const ref = refs.find((r) => r.kind === 'ride_itinerary');
  const date = factOf(ref, 'travelDate');
  const from = factOf(ref, 'origin');
  const to = factOf(ref, 'destination');
  return {
    date,
    city: factOf(ref, 'city'),
    route: from && to ? `${from} → ${to}` : null,
    dateEvidence: date ? '看图读取的行程单，已确认' : null,
  };
}

/** 候选明细：一个事件投影成一行。费用类别和 ERP 费用项目留到任务选择阶段。 */
function projectLineItem(e) {
  const yuan = (c) => (c === null || c === undefined ? null : (c / 100).toFixed(2));
  return {
    lineId: e.eventId,
    eventId: e.eventId,
    voucherMaterialId: e.voucherMaterialId,
    maskedNumber: e.maskedNumber,
    kind: e.kind,
    date: e.date ?? null,
    city: e.city ?? null,
    route: e.route ?? null,
    netAmount: yuan(e.amounts.netCents),
    taxAmount: yuan(e.amounts.taxCents),
    totalAmount: yuan(e.amounts.totalCents),
    amountSource: e.amountSource,
    referenceMaterialIds: e.referenceMaterialIds,
    category: null,
    categoryNote: '费用类别、ERP 项目和费用项目在任务选择阶段确定，这一层不推断',
  };
}

/** 事件层能产生的待确认项。 */
export function eventOpenItems(built) {
  const items = [...built.notes];

  for (const a of built.evidence.ambiguous) {
    items.push({ kind: 'evidence_ambiguous', blocking: true, ...a,
      note: a.sameKind
        ? '同一张发票对上了多份同类参考材料，无法确定哪一份才是它的证据；请移除不属于本次报销的那一份'
        : '这份参考材料的合计金额同时对上了多张发票，证据归属不唯一；请确认它属于哪一次费用' });
  }
  for (const u of built.evidence.unlinked) {
    items.push({ kind: 'reference_unlinked', blocking: false, ...u,
      note: '这份参考材料的合计金额没有对上任何一张发票。它可能属于另一次报销，'
        + '也可能说明对应的发票还没放进来 —— 请自己判断，系统不替你决定' });
  }
  for (const e of built.events) {
    if (e.amounts.totalCents === null || e.amounts.totalCents === undefined) {
      // 一条没有金额的明细不能往下走。它在写入前那张表上会显示成「—」，
      // 而总数会**悄悄**当它是 0 —— 用户点头的那个合计里少了一笔，
      // 这是最不该在不可撤销的那一格上发生的事。
      items.push({ kind: 'event_amount_missing', blocking: true,
        eventId: e.eventId, materialId: e.voucherMaterialId, fileName: e.voucherFileName,
        note: '这次费用没有取到价税合计，不能形成一条能写进 ERP 的明细；'
          + '请确认这张凭证上的金额读得出来' });
    }
    if (!e.date) {
      items.push({ kind: 'event_date_missing', blocking: true,
        eventId: e.eventId, materialId: e.voucherMaterialId, fileName: e.voucherFileName,
        note: '这次费用没有可追溯到材料的发生日期；开票日期不等于费用发生日期，不能拿来顶替' });
    }
  }
  if (!built.events.length && !built.notes.some((n) => n.blocking)) {
    items.push({ kind: 'no_expense_event', blocking: true,
      note: '没有构成任何费用事件，这个目录还不能形成一次报销' });
  }
  return items;
}

/** 金额守恒：每张发票的各段之和必须回到票面三项。 */
export function reconcile(built, classification) {
  const rows = [];
  const byVoucher = new Map();
  for (const e of built.events) {
    if (!byVoucher.has(e.voucherMaterialId)) byVoucher.set(e.voucherMaterialId, []);
    byVoucher.get(e.voucherMaterialId).push(e);
  }
  for (const [id, es] of byVoucher) {
    const v = classification.results.find((r) => r.materialId === id);
    const sum = (k) => es.reduce((a, e) => a + (e.amounts[k] ?? 0), 0);
    const face = { net: v.fields?.netAmount?.cents ?? null, tax: v.fields?.taxAmount?.cents ?? null,
      total: v.fields?.totalAmount?.cents ?? null };
    const cmp = (a, b) => (a === null ? 'not_on_face' : a === b ? 'ok' : 'mismatch');
    rows.push({
      voucherMaterialId: id,
      fileName: v.fileName,
      eventCount: es.length,
      net: cmp(face.net, sum('netCents')),
      tax: cmp(face.tax, sum('taxCents')),
      total: cmp(face.total, sum('totalCents')),
    });
  }
  return rows;
}
