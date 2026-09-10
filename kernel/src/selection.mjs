import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';
import { CATEGORIES, normalizeCity } from './categories.mjs';
import {
  PROJECT_BOOK_EMPTY, noCandidatesNote, sameIdentity, isSafeProjectNumber,
} from './projects.mjs';

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
    [l.lineId, l.voucherMaterialId, l.date, l.endDate ?? l.checkOut, l.city, l.totalAmount].join('|'));
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

/**
 * 一份旧记录（任务选择 / 只读核对）是不是还站在当前这批明细上。
 *
 * 指纹和盘点版本**两个都要对上**，因为它们各自漏掉对方管的那一半：
 *
 *   - 指纹管版本内的变化：材料没变，但用户重新分摊了一张合并交通票，明细从一行变成三行。
 *   - 版本管指纹看不见的变化：指纹只取 [lineId, 凭证材料, 日期, 城市, 价税合计]，
 *     换一张日期城市金额都相同、但发票号码和税额不同的发票，指纹一动不动 ——
 *     旧的 erp_catalog_confirmed 会被一张从没核对过的发票继承走。
 *
 * 缺 versionId 的旧记录一律算过期：宁可让用户重做一次，也不能把旧结论套在新材料上。
 */
export const sameBasis = (record, built) => !!record
  && record.linesDigest === linesDigest(built)
  && record.versionId === built.versionId;

export function loadSelection(task) {
  if (!task?.createdAt) return null;
  try { return JSON.parse(fs.readFileSync(selectionFile(task), 'utf8')); } catch { return null; }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const textOk = (s, max) => typeof s === 'string'
  && s.trim().length > 0 && s.trim().length <= max && !CONTROL.test(s);

/**
 * 收下一次任务选择。项目号必须来自提交瞬间的本人项目簿可选集合；页面展示的集合
 * 只是一份提示，真正的门禁在这里重新读取候选。合法历史选择可以继续保留，即使它
 * 后来从项目簿删除，但一次新的项目归属不能使用已经不在当前集合里的项目号。
 */
export function isBookSelection(selection) {
  return selection?.projectsFrom === 'project_book'
    && selection.projectSource === 'erp_catalog_confirmed';
}

export function submitSelection(task, built, payload, candidates = null, identity = null,
  previous = null) {
  const reasons = [];
  const homeCity = String(task?.homeCity ?? '').trim();
  const purpose = String(payload?.purpose ?? '').trim();
  if (!textOk(homeCity, 20)) reasons.push('常驻城市必须填写，且不超过 20 个字');
  if (payload?.homeCity !== undefined && String(payload.homeCity).trim() !== homeCity) {
    reasons.push('任务选择不能修改已固定的常驻城市；请先完成常驻城市确认');
  }
  if (!textOk(purpose, 100)) reasons.push('报销事由必须填写，且不超过 100 个字');

  const strictBook = Array.isArray(candidates);
  const allowed = new Map((strictBook ? candidates : [])
    .filter((project) => isSafeProjectNumber(project?.number))
    .map((project) => [project.number, project]));
  if (!strictBook) reasons.push('提交缺少当前本人项目簿可选集合，不能收下项目归属');
  if (strictBook && !sameIdentity(task?.identity, identity)) {
    reasons.push('任务身份与当前登录身份不一致，不能提交项目归属');
  }
  const canKeepPrevious = strictBook && sameBasis(previous, built) && isBookSelection(previous)
    && sameIdentity(previous.identity, identity);
  let emptyBook = strictBook && allowed.size === 0;
  const wanted = built.lineItems.map((l) => l.lineId);
  const given = payload?.projects && typeof payload.projects === 'object' ? payload.projects : {};
  const projects = {};
  for (const lineId of wanted) {
    const v = given[lineId];
    if (!textOk(v ?? '', 40)) { reasons.push(`明细 ${lineId} 还没有选项目`); continue; }
    const number = String(v).trim();
    if (!strictBook) continue;
    if (!allowed.has(number)
      && !(canKeepPrevious && isSafeProjectNumber(number)
        && previous.projects?.[lineId] === number)) {
      reasons.push(`明细 ${lineId} 的项目 ${number} 不在当前本人项目簿可选集合中；要用它请先在维护页重新核验`);
      continue;
    }
    projects[lineId] = number;
  }
  for (const k of Object.keys(given)) {
    if (!wanted.includes(k)) reasons.push(`提交里出现了不存在的明细 ${k}，这批明细可能已经变了`);
  }
  if (strictBook && emptyBook && !canKeepPrevious) {
    reasons.push(`当前本人项目簿没有可选项目；${noCandidatesNote()}`);
  }
  if (reasons.length) return { verdict: 'rejected', reasons,
    ...(strictBook && emptyBook ? { state: PROJECT_BOOK_EMPTY } : {}) };

  const record = {
    linesDigest: linesDigest(built),
    versionId: built.versionId,
    homeCity,
    purpose,
    projects,
    projectSource: 'erp_catalog_confirmed',
    projectsFrom: 'project_book',
    identity: { account: identity.account, tenant: identity.tenant },
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
 * 把任务选择和推导出来的费用类别贴回候选明细。没有项目选择时，仍按任务快照
 * 推导分类；项目归属本身保持未确认，等个人项目簿提交。
 */
/**
 * 项目号的来源等级。只有维护页录入时已经通过 ERP 核验、并由当前本人在任务选择
 * 页面提交的记录才是 confirmed。旧任务里的全局 ERP 选择不因旧值或 catalog 记录
 * 自动合法化。
 */
const projectSourceOf = (number, selection, fresh) => {
  return number && fresh && isBookSelection(selection)
    ? 'erp_catalog_confirmed' : 'user_input_unverified';
};

export function applySelection(built, classification, selection, catalog = null,
  candidates = null, identity = null, taskHomeCity = null) {
  // `catalog` remains in this positional slot for callers from older task records;
  // project source is now established only by the identity-scoped project book.
  const basisFresh = sameBasis(selection, built);
  const bookFresh = isBookSelection(selection);
  const identityFresh = sameIdentity(selection?.identity, identity);
  const fresh = basisFresh && bookFresh && identityFresh;
  const bookEmpty = Array.isArray(candidates) && candidates.length === 0;
  const categoryHomeCity = String(taskHomeCity ?? '').trim()
    || (fresh ? String(selection.homeCity ?? '').trim() : '');
  const notes = [];

  if (!selection) {
    notes.push(bookEmpty ? {
      kind: PROJECT_BOOK_EMPTY, blocking: true,
      note: `个人项目簿里没有当前可选项目；${noCandidatesNote()}`,
    } : {
      kind: 'task_selection_required', blocking: true,
      note: '常驻城市、报销事由和每条明细的项目归属，材料上没有，也不能由系统推断；'
        + '跑 select-task 打开任务选择页，由用户提交',
    });
  } else if (!basisFresh) {
    notes.push({
      kind: 'task_selection_stale', blocking: true,
      note: '候选明细在上次任务选择之后变过了（材料或逐段分摊有改动），'
        + '之前的项目归属不再对应现在这几行，需要重新选择',
    });
    if (bookEmpty) notes.push({ kind: PROJECT_BOOK_EMPTY, blocking: true,
      note: `个人项目簿里没有当前可选项目；${noCandidatesNote()}` });
  } else if (!bookFresh) {
    notes.push({ kind: 'project_selection_reconfirmation_required', blocking: true,
      note: '这份任务选择没有个人项目簿来源证据；原记录保留不动，请从本人项目簿重新确认' });
    if (bookEmpty) notes.push({ kind: PROJECT_BOOK_EMPTY, blocking: true,
      note: `个人项目簿里没有当前可选项目；${noCandidatesNote()}` });
  } else if (!identityFresh) {
    notes.push({ kind: 'project_selection_identity_mismatch', blocking: true,
      note: '任务选择记录属于另一 tenant/account 身份，不能沿用；请回到任务所属身份重新确认' });
  }

  const lines = built.lineItems.map((l) => {
    const event = built.events.find((e) => e.eventId === l.eventId);
    const d = categoryHomeCity ? deriveCategory(event, classification, categoryHomeCity) : null;
    const cat = d?.category ? CATEGORIES[d.category] : null;
    if (d && !d.category) {
      notes.push({
        kind: d.reason, blocking: true, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, note: d.note,
      });
    } else if (cat && !cat.expenseItemCode) {
      notes.push({
        kind: 'expense_item_unverified', blocking: true, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, category: d.category, categoryLabel: cat.label,
        note: cat.blockedNote,
      });
    } else if (cat && cat.source !== 'erp_save_readback') {
      // 编码有来源但还没在 ERP 上落过明细：不拦，但必须说出来。
      notes.push({
        kind: 'expense_item_unconfirmed', blocking: false, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, category: d.category, categoryLabel: cat.label,
        expenseItemCode: cat.expenseItemCode, source: cat.source,
        note: cat.unconfirmedNote,
      });
    }

    if (!fresh) {
      return {
        ...l,
        category: d?.category ?? null,
        categoryLabel: cat?.label ?? null,
        categoryBasis: d?.basis ?? null,
        categoryNote: d?.note ?? null,
        expenseItemCode: cat?.expenseItemCode ?? null,
        expenseItemName: cat?.expenseItemName ?? null,
        expenseItemSource: cat?.source ?? null,
        project: null, projectSource: 'user_input_unverified', purpose: null,
      };
    }
    return {
      ...l,
      category: d?.category ?? null,
      categoryLabel: cat?.label ?? null,
      categoryBasis: d?.basis ?? null,
      categoryNote: d?.note ?? null,
      expenseItemCode: cat?.expenseItemCode ?? null,
      expenseItemName: cat?.expenseItemName ?? null,
      expenseItemSource: cat?.source ?? null,
      project: selection.projects[l.lineId] ?? null,
      projectSource: projectSourceOf(selection.projects[l.lineId] ?? null, selection, fresh),
      purpose: selection.purpose,
    };
  });

  return { lines, notes, homeCity: categoryHomeCity || null, applied: fresh };
}
