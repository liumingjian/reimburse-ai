/**
 * 纠正与争议：用户改的值不直接落库。
 *
 * 用户在终端上把一个金额从 10 改成 18。系统**不照改** —— 因为两边都可能错：
 * 可能是模型看模糊了证据认成 10，也可能是用户看错了。直接采纳等于承认
 * "人说的不用查"，那这一整条读数链上就多了一个没有来源的值；直接驳回则等于
 * 承认"机器读的不会错"，而这一整套设计的前提恰恰是它会。
 *
 * 所以内核在这里既不选边也不折中，只做三件它做得到的事：
 *
 *  1. **摆证据。** 这个数是从哪份材料读的（给**路径**，用户自己打开原件 ——
 *     内核不代替用户看，也不把一份图塞进对话冒充成"我替你确认过了"）、
 *     机器读到的原文是什么、模型当时说清不清楚。
 *  2. **派一次独立重读。** 干净上下文的子 Agent，只重读争议的那一个字段。
 *     要的就是那份干净：带着刚才那段对话去重读，第二次读数只是第一次的回声，
 *     它证明不了任何事。
 *  3. **请用户拍板。** 用户对着原件确认的那一下才是最终判定。
 *
 * 三种收敛各有确定的说法，写死在这里，不交给模型组织：
 *
 *   `agrees_with_user`     重读和用户一致 —— 接受，并说明第二次也读出这个。
 *   `agrees_with_machine`  重读和原读数一致 —— 两次机器读数和用户的值一并摆出，用户对着原件拍板。
 *   `third_value`          重读给出第三个值（或干脆读不出）—— 直说这个字段读不可靠，以原件为准。
 *
 * 守恒式不让路：用户的改动把式子打破时，内核算出差额、说清还差什么。
 * 补不上就**整条读数退回待办**。内核绝不反算另外两个值 —— 反算出来的那个数
 * 看起来最像对的，实际上是这条链子上唯一一个没有人读过的值。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { shapeOfBuffer, shapeMatches } from './imageshape.mjs';
import {
  FIELD_RULES, FIELD_LABELS, CLARITY, CLARITY_UNSTATED, cents,
  loadRejection, writeRejection, clearRejection, writeReading, writeUnreadable,
} from './vision.mjs';

/** 重读提交的格式版本。和读数提交分开编号：它们是两份不同的东西。 */
export const REREAD_VERSION = 1;

/** 三种收敛。闭集 —— 没有第四种收场，"再吵一轮"不是收场。 */
export const CONVERGENCE = {
  agrees_with_user: 'agrees_with_user',
  agrees_with_machine: 'agrees_with_machine',
  third_value: 'third_value',
};

/** 守恒式认得的那三个金额。改动落在它们身上才谈得上"式子平不平"。 */
const CONSERVED = ['netAmount', 'taxAmount', 'totalAmount'];

const yuan = (c) => (c / 100).toFixed(2);

/**
 * 这份材料上有没有一场还没收场的争议。
 *
 * 争议记在驳回记录里（那里已经存着被推翻的那次机器读数），靠 `disputed` 非空
 * 和普通驳回区分开：普通驳回的处置是重读整张票，争议的处置是只重读一个字段。
 * 两者跟着**同一份字节**走 —— 图换过了，争的那件事本身就不存在了。
 */
export function activeDispute(task, materialId, contentHash) {
  const rec = loadRejection(task, materialId);
  if (!rec || rec.contentHash !== contentHash) return null;
  if (!(rec.disputed?.length > 0)) return null;
  return rec;
}

/**
 * 争议此刻走到哪一步。这是**从落盘的事实推出来的**，不是记在某个字段里的进度条：
 * 记进度条就会有"进度条说重读完了、但重读记录不在"的那种状态。
 *
 *   `reread`             还没有重读结果 —— 该派子 Agent 了。
 *   `ruling`             重读回来了，收敛结果要用户拍板。
 *   `conservation_gap`   用户拍了板，但式子不平，缺口要人补。
 */
export function disputePhase(rec) {
  if (rec.gap) return 'conservation_gap';
  if (!rec.reread) return 'reread';
  return 'ruling';
}

/** 内核替一个没说清晰度的读数说话时，说的是"没人说过"，不是替它猜一个。 */
const clarityOf = (d) => (d.machineClarity
  ? { verdict: d.machineClarity, label: CLARITY[d.machineClarity], statedBy: 'model' }
  : { verdict: null, label: CLARITY_UNSTATED, statedBy: null });

/**
 * 此刻所有待收场的争议，按材料一份份摆出来。
 *
 * `materialPath` 是**绝对路径**，而且只给路径：用户自己打开原件，
 * 内核不替他打开、不替他看、也不把图塞进对话里冒充成"我们一起看过了"。
 */
export function openDisputes(task, inventory, sourceDir) {
  const root = path.resolve(sourceDir);
  const out = [];
  for (const m of inventory.materials) {
    const rec = activeDispute(task, m.materialId, m.contentHash);
    if (!rec) continue;
    const machine = rec.machineReading ?? {};
    out.push({
      materialId: m.materialId,
      fileName: m.fileName,
      materialPath: path.join(root, m.relPath),
      contentHash: m.contentHash,
      phase: disputePhase(rec),
      docType: machine.docType ?? null,
      readAt: machine.readAt ?? null,
      notes: machine.notes ?? null,
      // 争的是哪几个字段，每个字段三方各说了什么。
      fields: rec.disputed.map((d) => ({
        field: d.field,
        label: d.label,
        machineValue: d.machineValue,
        userValue: d.userValue,
        clarity: clarityOf(d),
        reread: rec.reread?.fields?.[d.field] ?? null,
        convergence: rec.reread?.convergence?.[d.field] ?? null,
      })),
      // 同一张读数上没被争的那些字段，供用户对照 —— 一个数对不对，
      // 常常要看它旁边那几个数才判得出来。
      otherFields: Object.entries(machine.fields ?? {})
        .filter(([k]) => !rec.disputed.some((d) => d.field === k))
        .map(([key, value]) => ({ key, label: FIELD_LABELS[key] ?? key, value,
          source: machine.fieldSources?.[key] ?? 'vision' })),
      gap: rec.gap ?? null,
      rulingRejection: rec.rulingRejection ?? null,
    });
  }
  return out;
}

/**
 * 收下一次独立重读。
 *
 * 它走**和看图读数同一道凭据闸**：内容哈希内核自己重算，形状档必须对得上。
 * 一次证明不了自己打开过图的重读，和没重读是一回事 —— 而这一次的分量比平时更重，
 * 它是用来给另一次读数做对照的。
 *
 * 只收争议里的那几个字段。多交的一律拒收：这一趟的意义就是**只看那一个地方**，
 * 顺手把整张票重抄一遍的话，第二份读数就不再是独立的对照，而是又一份要人确认的候选。
 */
export function ingestReread(sourceDir, inventory, task, submission) {
  if (!submission || submission.version !== REREAD_VERSION) {
    const e = new Error(`重读格式版本不对，期望 ${REREAD_VERSION}`);
    e.code = 'BAD_SUBMISSION';
    throw e;
  }
  const m = inventory.materials.find((x) => x.materialId === submission.materialId);
  if (!m) return { verdict: 'rejected', reasons: ['本次盘点版本里没有这份材料'] };

  const rec = activeDispute(task, m.materialId, m.contentHash);
  if (!rec) return { verdict: 'rejected', reasons: ['这份材料上没有待收场的争议'] };
  if (rec.reread) return { verdict: 'rejected', reasons: ['这场争议已经重读过一次了，收场靠用户拍板，不靠再读第三遍'] };

  const reasons = [];
  const bytes = fs.readFileSync(path.join(path.resolve(sourceDir), m.relPath));
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (submission.contentHash !== actual) {
    reasons.push('重读携带的内容哈希与材料当前内容不一致，这次重读已作废');
  }
  const shape = shapeOfBuffer(bytes);
  if (!shape) {
    reasons.push('内核解不开这个文件的图像头，它不是一张完整的 png / jpg');
  } else if (!shapeMatches(shape.width, shape.height, submission.sighted?.shape)) {
    reasons.push('sighted.shape 和这张图对不上 —— 重读也要先证明这张图真的被打开过。'
      + '这一次尤其如此：它是拿来给上一次读数做对照的，一次没看图的重读什么都对照不了。');
  }

  const wanted = new Set(rec.disputed.map((d) => d.field));
  const fields = {};
  for (const [k, v] of Object.entries(submission.fields ?? {})) {
    if (!wanted.has(k)) { reasons.push(`${k} 不在争议里，这一趟只重读：${[...wanted].join('、')}`); continue; }
    // 明说读不出的，记成 null。这是一个正当的重读结果，不是没交。
    if (v === null) { fields[k] = null; continue; }
    const rule = FIELD_RULES[k];
    if (!rule.test(v)) { reasons.push(`${k} 的格式不对（要求：${rule.hint}）`); continue; }
    fields[k] = v;
  }
  for (const f of wanted) {
    if (!(f in fields) && !reasons.length) reasons.push(`争议里的 ${f} 没有回报，读不出也要明写成 null`);
  }
  if (reasons.length) return { verdict: 'rejected', reasons };

  // 收敛判定。逐字段比，不合并成一个总的结论：一份读数上争两个字段时，
  // 它们完全可能一个收敛在用户那边、一个谁都对不上。
  const convergence = {};
  for (const d of rec.disputed) {
    const v = fields[d.field];
    convergence[d.field] = v !== null && v === d.userValue ? CONVERGENCE.agrees_with_user
      : v !== null && v === d.machineValue ? CONVERGENCE.agrees_with_machine
        : CONVERGENCE.third_value;
  }

  writeRejection(task, { ...rec,
    reread: {
      at: new Date().toISOString(),
      fields,
      convergence,
      clarity: Object.fromEntries(Object.entries(submission.clarity ?? {})
        .filter(([k, v]) => wanted.has(k) && v in CLARITY)),
      notes: typeof submission.notes === 'string' ? submission.notes.slice(0, 400) : null,
      sighted: { shape: submission.sighted.shape, width: shape.width, height: shape.height },
    } });

  return { verdict: 'accepted', materialId: m.materialId, fields, convergence };
}

/**
 * 把一组字段值合进被推翻的那份机器读数，并校验守恒式。
 *
 * **只做加法，不做减法**：给什么值就写什么值，一个没给的字段绝不由内核推出来。
 * 三个金额齐了就必须分毫不差；不齐就是 `partial`，不平也不假装平。
 */
function settleFields(machine, values) {
  const merged = { ...(machine.fields ?? {}), ...values };
  for (const k of Object.keys(values)) if (values[k] === null) delete merged[k];
  const have = CONSERVED.filter((k) => merged[k]);
  if (have.length < CONSERVED.length) return { merged, amountCheck: merged.totalAmount ? 'partial' : null, gap: null };
  const diff = cents(merged.netAmount) + cents(merged.taxAmount) - cents(merged.totalAmount);
  if (diff === 0) return { merged, amountCheck: 'balanced', gap: null };
  return {
    merged,
    amountCheck: 'mismatch',
    gap: {
      netAmount: merged.netAmount,
      taxAmount: merged.taxAmount,
      totalAmount: merged.totalAmount,
      // 差额是内核算出来的**一个事实**，不是一个待填的空 ——
      // 它说明还差多少，不说明该往哪个字段上加。往哪个字段上加只有原件说了算。
      deltaCents: diff,
      delta: yuan(Math.abs(diff)),
      // 两边各是多少，算好了摆着 —— 说"式子不平"而不说不平在哪里，
      // 等于把差额这件事又推回给用户自己去算。
      sum: yuan(cents(merged.netAmount) + cents(merged.taxAmount)),
      direction: diff > 0 ? 'sum_exceeds_total' : 'total_exceeds_sum',
      at: new Date().toISOString(),
    },
  };
}

/**
 * 用户拍板。这一下才是最终判定 —— 前面所有的读数、重读、证据都只是给它做铺垫。
 *
 * `values`：用户对着原件给的字段值。`giveUp`：用户对着原件也认不出。
 *
 * 三种收场，每一种都落成一个确定的事实：
 *  - 值齐了、式子平 -> 读数写回去（**未确认**），整张表再摆一次请用户过目。
 *  - 值给了、式子不平 -> 记下缺口，不落库，回去问还差什么。**绝不反算**。
 *  - 认不出 / 补不上 -> 整条读数退回待办，等人换一份看得清的原件。
 */
export function settleDispute(task, materialId, contentHash, { values = {}, giveUp = false } = {}) {
  const rec = activeDispute(task, materialId, contentHash);
  if (!rec) return null;
  const machine = rec.machineReading ?? {};

  if (giveUp) {
    writeUnreadable(task, {
      materialId,
      fileName: rec.fileName,
      contentHash,
      at: new Date().toISOString(),
      fields: rec.disputed.map((d) => d.field),
      reason: rec.gap
        ? '用户改动打破了守恒式，缺口补不上；这条读数整条退回待办，内核不反算另外两个值'
        : '争议收不了场：用户对着原件也认不出这个字段。这条读数整条退回待办',
    });
    clearRejection(task, materialId);
    return { verdict: 'parked_unreadable', materialId, fields: rec.disputed.map((d) => d.field) };
  }

  // 用户口述的值走和模型抄写**同一道格式闸**。人也会看错、也会漏一位小数。
  const bad = [];
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    const rule = FIELD_RULES[k];
    if (!rule) { bad.push(`不认识的字段 ${k}`); continue; }
    if (v === null) { clean[k] = null; continue; }
    if (!rule.test(v)) { bad.push(`${FIELD_LABELS[k]} 的格式不对（要求：${rule.hint}）`); continue; }
    clean[k] = v;
  }
  if (bad.length) {
    writeRejection(task, { ...rec, rulingRejection: { reasons: bad, at: new Date().toISOString() } });
    return { verdict: 'rejected', materialId, reasons: bad };
  }
  if (!Object.keys(clean).length) return null;

  const { merged, amountCheck, gap } = settleFields(machine, clean);
  if (gap) {
    writeRejection(task, { ...rec, gap: { ...gap, values: clean }, rulingRejection: null });
    return { verdict: 'conservation_gap', materialId, gap };
  }

  // 式子过了。读数写回去，但**不带确认** —— 用户接下来还要在整张表上再点一次头。
  // 争议里定下的那一个数不等于整份读数都对了。
  const settledFields = Object.keys(clean).filter((k) => clean[k] !== null);
  const dropped = Object.keys(clean).filter((k) => clean[k] === null);
  writeReading(task, {
    ...machine,
    fields: merged,
    unreadable: [...new Set([...(machine.unreadable ?? []), ...dropped])],
    amountCheck,
    fieldSources: {
      ...Object.fromEntries(Object.keys(merged).map((k) =>
        [k, machine.fieldSources?.[k] ?? machine.source ?? 'vision'])),
      // 用户对着原件给的那几个，来源就是用户。它和"模型抄的"混在一份读数里，
      // 而分得清哪个是哪个，是后面每一次复核的全部依据。
      ...Object.fromEntries(settledFields.map((k) => [k, 'user'])),
    },
    // 这一场争议是怎么收的，跟着读数一起留下来 —— 用户在下一张表上会看到
    // 一个改过的值，他有权知道那个值是怎么变成现在这样的。
    disputeResolution: {
      at: new Date().toISOString(),
      fields: rec.disputed.map((d) => ({
        field: d.field,
        label: d.label,
        machineValue: d.machineValue,
        rereadValue: rec.reread?.fields?.[d.field] ?? null,
        userValue: d.userValue,
        convergence: rec.reread?.convergence?.[d.field] ?? null,
        finalValue: merged[d.field] ?? null,
      })),
    },
    readAt: machine.readAt ?? null,
    settledAt: new Date().toISOString(),
    confirmedAt: null,
    confirmedVia: null,
  });
  clearRejection(task, materialId);
  return { verdict: 'settled', materialId, fields: settledFields, amountCheck };
}

/**
 * 重读和用户一致的那几个字段，内核**自己就接受**，不再多问一轮。
 *
 * 依据不是"用户说的算"，而是：一次干净上下文的独立重读，在不知道用户说了什么的
 * 情况下，读出了和用户一样的值。这是这套设计里机器能给出的最强的一种印证。
 * 接受之后读数仍然停在未确认，用户还要在整张表上点最后那一下 ——
 * "用户确认的那一下才是最终判定"这一条没有例外。
 *
 * 三个字段争两个、只有一个收敛在用户那边时，只接受收敛的那一个，另一个照样请用户拍板。
 */
export function autoSettleAgreed(task, materialId, contentHash) {
  const rec = activeDispute(task, materialId, contentHash);
  if (!rec || !rec.reread || rec.gap) return null;
  const agreed = rec.disputed.filter((d) =>
    rec.reread.convergence?.[d.field] === CONVERGENCE.agrees_with_user);
  if (!agreed.length || agreed.length !== rec.disputed.length) return null;
  return settleDispute(task, materialId, contentHash,
    { values: Object.fromEntries(agreed.map((d) => [d.field, d.userValue])) });
}
