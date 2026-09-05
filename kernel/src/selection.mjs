import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';
import { CATEGORIES, normalizeCity } from './categories.mjs';

// 任务选择：把候选明细补齐成 ERP 明细行还缺的那几件事。
//
// 缺的东西分成两类，来源完全不同，绝不能混：
//
//   1. **费用类别**由内核按规则从费用事实推导。它不是用户的选择题 ——
//      同一张票、同一个常驻城市，结论必须每次都一样。推不出来就阻塞。
//   2. **项目归属、常驻城市、事由**是材料上根本没有的业务事实。它们只能由用户给，
//      而且只能通过本地任务选择 Web 的**提交动作**给：用户在对话里说"项目是 111454"
//      不构成任务选择（设计共识第四节）。
//
// 这两类的边界就是这一层的全部意义：能从材料推出来的不要问用户，
// 材料证明不了的也绝不替用户决定。

/* ------------------------------------------------------------ 费用类别推导 */

/**
 * 从一个费用事件推导费用类别。依据只有三样：票种、关联上的参考材料、以及任务的常驻城市。
 * 推不出来就返回 `category: null` 并说明原因 —— 不按文件名、金额或目录名猜。
 */
export function deriveCategory(event, classification, homeCity) {
  const refKinds = event.referenceMaterialIds
    .map((id) => classification.results.find((r) => r.materialId === id)?.kind)
    .filter(Boolean);

  if (event.kind === 'rail_eticket') {
    return { category: 'long_distance', basis: '票种是铁路电子客票' };
  }
  if (refKinds.includes('hotel_folio')) {
    return { category: 'accommodation', basis: '关联的参考材料是酒店结账单' };
  }
  const isRide = event.kind === 'passenger_transport' || refKinds.includes('ride_itinerary');
  if (!isRide) {
    return {
      category: null,
      reason: 'category_undecidable',
      note: `${event.kindLabel ?? '这张凭证'}既不是铁路客票，也没有酒店结账单或行程单佐证，`
        + '无法确定它属于 v1 的哪一类费用；请补充能证明费用性质的参考材料，或把它排除出本次报销',
    };
  }
  if (!event.city) {
    return {
      category: null,
      reason: 'category_city_missing',
      note: '市内交通要按费用发生城市与常驻城市比对，才能分出本地还是外地；'
        + '这次费用没有取到城市，不能拿常驻城市顶替',
    };
  }
  const local = normalizeCity(event.city) === normalizeCity(homeCity);
  return {
    category: local ? 'local_city_transport' : 'remote_city_transport',
    basis: local
      ? `费用发生城市 ${event.city} 与常驻城市 ${homeCity} 相同`
      : `费用发生城市 ${event.city} 不是常驻城市 ${homeCity}`,
  };
}

/* -------------------------------------------------------------- 选择的存取 */

const selectionFile = (task) => path.join(taskDir(task), 'selection.json');

/**
 * 这一次任务选择所依附的那批候选明细的指纹。
 *
 * 绑的不是盘点版本而是**明细本身**：材料没变、但用户重新分摊了一张合并交通票时，
 * 明细行会从一行变成三行，之前那次"给这一行选了项目"就不再有意义了。
 */
export function linesDigest(built) {
  const shape = built.lineItems.map((l) =>
    [l.lineId, l.voucherMaterialId, l.date, l.city, l.totalAmount].join('|'));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

export function loadSelection(task) {
  if (!task?.createdAt) return null;
  try { return JSON.parse(fs.readFileSync(selectionFile(task), 'utf8')); } catch { return null; }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const textOk = (s, max) => typeof s === 'string'
  && s.trim().length > 0 && s.trim().length <= max && !CONTROL.test(s);

/**
 * 收下一次任务选择。校验是结构性的：字段齐、长度合法、每一条候选明细都有项目、
 * 没有多出来的行。**内核不校验项目号在 ERP 里是否存在** —— 那要等 ERP 只读查询，
 * 所以这里如实记下它未经核验，由后面的 ERP 层去对账。
 */
export function submitSelection(task, built, payload) {
  const reasons = [];
  const homeCity = String(payload?.homeCity ?? '').trim();
  const purpose = String(payload?.purpose ?? '').trim();
  if (!textOk(homeCity, 20)) reasons.push('常驻城市必须填写，且不超过 20 个字');
  if (!textOk(purpose, 100)) reasons.push('报销事由必须填写，且不超过 100 个字');

  const wanted = built.lineItems.map((l) => l.lineId);
  const given = payload?.projects && typeof payload.projects === 'object' ? payload.projects : {};
  const projects = {};
  for (const lineId of wanted) {
    const v = given[lineId];
    if (!textOk(v ?? '', 40)) { reasons.push(`明细 ${lineId} 还没有选项目`); continue; }
    projects[lineId] = String(v).trim();
  }
  for (const k of Object.keys(given)) {
    if (!wanted.includes(k)) reasons.push(`提交里出现了不存在的明细 ${k}，这批明细可能已经变了`);
  }
  if (reasons.length) return { verdict: 'rejected', reasons };

  const record = {
    linesDigest: linesDigest(built),
    versionId: built.versionId,
    homeCity,
    purpose,
    projects,
    // 项目号来自用户，还没有和 ERP 项目目录核对过。这件事必须写在记录里，
    // 免得后面的层把它当成已经验证过的主数据。
    projectSource: 'user_input_unverified',
    submittedAt: new Date().toISOString(),
    submittedVia: 'local-web',
  };
  const p = selectionFile(task);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
  return { verdict: 'accepted', reasons: [], record };
}

/* ---------------------------------------------------------- 明细补齐与门禁 */

/**
 * 把任务选择和推导出来的费用类别贴回候选明细。
 * 没有选择时不猜任何东西：整批明细停在"等任务选择"上。
 */
export function applySelection(built, classification, selection) {
  const fresh = !!selection && selection.linesDigest === linesDigest(built);
  const notes = [];

  if (!selection) {
    notes.push({
      kind: 'task_selection_required', blocking: true,
      note: '常驻城市、报销事由和每条明细的项目归属，材料上没有，也不能由系统推断；'
        + '跑 select-task 打开任务选择页，由用户提交',
    });
  } else if (!fresh) {
    notes.push({
      kind: 'task_selection_stale', blocking: true,
      note: '候选明细在上次任务选择之后变过了（材料或逐段分摊有改动），'
        + '之前的项目归属不再对应现在这几行，需要重新选择',
    });
  }

  const lines = built.lineItems.map((l) => {
    const event = built.events.find((e) => e.eventId === l.eventId);
    if (!fresh) {
      return {
        ...l, category: null, categoryLabel: null, categoryBasis: null,
        expenseItemCode: null, expenseItemName: null, project: null, purpose: null,
      };
    }
    const d = deriveCategory(event, classification, selection.homeCity);
    const cat = d.category ? CATEGORIES[d.category] : null;
    if (!d.category) {
      notes.push({
        kind: d.reason, blocking: true, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, note: d.note,
      });
    } else if (!cat.expenseItemCode) {
      notes.push({
        kind: 'expense_item_unverified', blocking: true, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, category: d.category, categoryLabel: cat.label,
        note: cat.blockedNote,
      });
    }
    return {
      ...l,
      category: d.category,
      categoryLabel: cat?.label ?? null,
      categoryBasis: d.basis ?? null,
      categoryNote: d.note ?? null,
      expenseItemCode: cat?.expenseItemCode ?? null,
      expenseItemName: cat?.expenseItemName ?? null,
      project: selection.projects[l.lineId] ?? null,
      projectSource: 'user_input_unverified',
      purpose: selection.purpose,
    };
  });

  return { lines, notes, homeCity: fresh ? selection.homeCity : null, applied: fresh };
}
