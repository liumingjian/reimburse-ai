import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';
import { CATEGORIES, normalizeCity } from './categories.mjs';
import { selectableProjects, PROJECT_BOOK_EMPTY, BOOK_EMPTY_HINT } from './projects.mjs';

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
const sameBasis = (record, built) => !!record
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
 * 收下一次任务选择。校验是结构性的：字段齐、长度合法、每一条候选明细都有项目、
 * 没有多出来的行。
 *
 * **项目号只能来自个人项目簿的可选集合，选择环节不接受自由输入的项目号。**
 * 这条定在内核里，而不是定在页面上：页面能绕过（改 DOM、直接 POST），
 * 而一个绕过它写进来的项目号会一路带着"已核验"的身份走到 ERP 上。
 * 界面怎么呈现候选是另一条线的事，内核这一层只认可选集合。
 *
 * 候选集合默认**提交那一刻现读**，不是打开页面那一刻的快照——用户在填页面的
 * 中途去维护页补录了一个项目，回来提交不该被自己刚加的项目号绊住。
 */
export function submitSelection(task, built, payload, candidates = selectableProjects()) {
  const reasons = [];
  const allowed = new Map(candidates.map((p) => [p.number, p]));
  let emptyBook = false;
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
    const number = String(v).trim();
    // 不在簿子里的号一律不收。说清楚出路是"去维护页录入"而不是"再填一次"，
    // 否则用户只会把同一个号再打一遍。簿子整个是空的时候只说一遍：那是一句
    // 关于簿子的话，不是关于这一行的话，每行重复一遍只会淹掉真正的行内问题。
    if (!allowed.size) { emptyBook = true; continue; }
    if (!allowed.has(number)) {
      reasons.push(`明细 ${lineId} 的项目 ${number} 不在项目簿里；`
        + `可选的是：${[...allowed.keys()].join('、')}。要用别的项目，先去项目簿维护页录入`);
      continue;
    }
    projects[lineId] = number;
  }
  for (const k of Object.keys(given)) {
    if (!wanted.includes(k)) reasons.push(`提交里出现了不存在的明细 ${k}，这批明细可能已经变了`);
  }
  // 空簿要让上层区分得出来：它和"有得选但还没选"给用户的话术完全不同。
  if (emptyBook) reasons.push(`项目簿是空的，选择环节没有候选可用；${BOOK_EMPTY_HINT}`);
  if (reasons.length) {
    return { verdict: 'rejected', reasons, ...(emptyBook ? { state: PROJECT_BOOK_EMPTY } : {}) };
  }

  const record = {
    linesDigest: linesDigest(built),
    versionId: built.versionId,
    homeCity,
    purpose,
    projects,
    // 项目号是从个人项目簿里选出来的，而簿子在录入那一刻就把未核验的挡在了外面，
    // 所以这条路径上的来源等级**恒为** erp_catalog_confirmed，不再经过未核验档。
    // 写进记录之后它就是这个任务的事实：簿子后来增删改，都不追溯这一次选择。
    projectSource: 'erp_catalog_confirmed',
    projectsFrom: 'project_book',
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
/**
 * 项目号的来源等级。
 *
 * 从项目簿里选出来的（记录上写着 `erp_catalog_confirmed`）**恒为已核验**：
 * 录入闸门在写进簿子那一刻就核过了，这条路径上不存在未核验的项目号。
 * 这个结论只看那一次选择记录，不看此刻的簿子——用户后来从簿子里删掉一条，
 * 不会把一个已经做出的任务选择变成没验过的。
 *
 * 剩下的是没有簿子来源的旧记录（本票之前提交的那些）。它们仍走原路：默认
 * "用户填的、没核对过"，只有当一份**对得上当前明细指纹**的 ERP 只读核对记录
 * 明确说这个号确认存在时才升级；核对记录过期、缺项或说有问题，一律退回未核对。
 */
const projectSourceOf = (number, selection, catalog, built) => {
  if (!number) return 'user_input_unverified';
  if (selection?.projectSource === 'erp_catalog_confirmed') return 'erp_catalog_confirmed';
  if (!catalog) return 'user_input_unverified';
  if (!sameBasis(catalog, built)) return 'user_input_unverified';
  return catalog.projects?.[number]?.verdict === 'confirmed'
    ? 'erp_catalog_confirmed'
    : 'user_input_unverified';
};

export function applySelection(built, classification, selection, catalog = null,
  candidates = selectableProjects()) {
  const fresh = sameBasis(selection, built);
  const notes = [];

  // 「没得选」和「该选了」是两个状态，给用户的话术完全不同：前者要他去维护页录入，
  // 后者要他去做选择。合成一条 task_selection_required 的话，用户会被叫去一个
  // 一条候选都没有的选择页。
  const bookEmpty = candidates.length === 0;
  const emptyNote = () => ({
    kind: PROJECT_BOOK_EMPTY, blocking: true, actor: 'user',
    note: `个人项目簿里一条可选项目都没有，选择环节没有候选可用；${BOOK_EMPTY_HINT}`,
  });

  if (!selection) {
    notes.push(bookEmpty ? emptyNote() : {
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
    // 要重选，但簿子空了——不说出来的话，用户会打开一个选不出东西的页面。
    if (bookEmpty) notes.push(emptyNote());
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
    } else if (cat.source !== 'erp_save_readback') {
      // 编码有来源但还没在 ERP 上落过明细：不拦，但必须说出来，
      // 而且要说清楚第一次保存之后该核对什么。
      notes.push({
        kind: 'expense_item_unconfirmed', blocking: false, lineId: l.lineId, eventId: l.eventId,
        fileName: event.voucherFileName, category: d.category, categoryLabel: cat.label,
        expenseItemCode: cat.expenseItemCode, source: cat.source,
        note: cat.unconfirmedNote,
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
      expenseItemSource: cat?.source ?? null,
      project: selection.projects[l.lineId] ?? null,
      projectSource: projectSourceOf(selection.projects[l.lineId] ?? null, selection, catalog, built),
      purpose: selection.purpose,
    };
  });

  return { lines, notes, homeCity: fresh ? selection.homeCity : null, applied: fresh };
}
