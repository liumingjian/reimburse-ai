/**
 * 逐段分摊问到终端上：`ask_user` 这种 step 的第一次真实使用。
 *
 * 这一层只在**一件事**上开口问用户：一张合并交通发票要拆成几段、每段多少钱，
 * 而且只在逐段金额之和与票面价税合计对不上的时候问。对得上时内核自己就定了
 * （events.mjs 的 `conservingSegments`），一个字都不问 —— 那不是分摊，是核对。
 *
 * 三条规矩，缺一条这套问答就变成"内核替用户编数字"：
 *
 *  1. **一次只问一张票，一轮至多四题。** 契约给的上限是四题，不是排版建议：
 *     一屏摆七八个金额选择，用户是照着点，不是照着核对。
 *  2. **答案先落草稿，齐了才提交。** 段数多于四段时要问好几轮，中途每一轮的答案
 *     都得留住 —— 不留住的话，用户答到第五段时前四段又要重来一遍。
 *  3. **收下的门槛和分摊页完全一样**：格式合法、段数对得上、各段之和与票面
 *     价税合计按分精确相等。差一分就整轮退回重问，内核不把差额抹到任何一段上。
 *
 * 用户也可以说"这张票我认不出"。那是一个**正当的结局**，不是失败：
 * 这张票落回待办，等他补一份逐段行程单或者把它挪出这次报销 ——
 * 比让他随口报一个凑得平的数字要好得多。
 */
import fs from 'node:fs';
import path from 'node:path';
import { taskDir } from './workspace.mjs';
import { submitAllocation, moneyCents } from './events.mjs';

/** 一轮至多问几题。契约里的硬上限。 */
export const MAX_QUESTIONS = 4;

const draftDir = (task) => path.join(taskDir(task), 'allocations');
const draftFile = (task, materialId) => path.join(draftDir(task), `${materialId}.draft.json`);
const giveUpFile = (task, materialId) => path.join(draftDir(task), `${materialId}.giveup.json`);

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
};

/**
 * 这张票答到一半的那几段。发票字节一变，草稿当场作废 ——
 * 半份答案套在另一张发票上，是这一层唯一有可能悄悄出错的地方。
 */
export function loadDraft(task, materialId, contentHash) {
  const d = readJson(draftFile(task, materialId));
  return d && d.contentHash === contentHash ? d : null;
}

/** 用户说过"这张票我认不出"没有。同样钉在字节上。 */
export function loadGiveUp(task, materialId, contentHash) {
  const g = readJson(giveUpFile(task, materialId));
  return g && g.contentHash === contentHash ? g : null;
}

export function clearDraft(task, materialId) {
  fs.rmSync(draftFile(task, materialId), { force: true });
}

/** 问题 id：材料 + 段序。收答案时靠它对回到具体哪一段，不靠答案的顺序。 */
const questionId = (materialId, index) => `${materialId}#${index + 1}`;
const parseId = (id) => {
  const [materialId, n] = String(id ?? '').split('#');
  const index = Number(n) - 1;
  return Number.isInteger(index) && index >= 0 ? { materialId, index } : null;
};

const yuan = (c) => (c / 100).toFixed(2);

/**
 * 一轮问出去的那几题的指纹。**一处定义，两处使用**：发问的时候钉进凭据，
 * 收答案的时候拿它比对。两边各写一份的话，加一个字段就会出现「发得出、收不下」，
 * 而在这一层，那种错的样子是上一轮的答案落到这一轮的段上。
 */
export const roundFingerprint = (questions) => (questions ?? []).map((q) => q.id);

/** 一段行程念给用户听的样子。取不到的就不说，不用"未知"占位。 */
const segmentLabel = (seg, index) => {
  const parts = [seg?.date, seg?.city, seg?.route].filter(Boolean);
  return parts.length ? `第 ${index + 1} 段（${parts.join(' ')}）` : `第 ${index + 1} 段`;
};

/**
 * 这一轮该问哪张票、哪几段。
 *
 * `pending` 是事件层报上来的 `allocation_required` / `allocation_stale`。
 * 一次只取**第一张**（按材料标识排序，稳定），它答完了下一轮才轮到下一张。
 *
 * 返回 null 表示没什么可问的 —— 该张票已经放弃了，或者根本没有待分摊的票。
 */
export function allocationRound(task, pending) {
  const sorted = [...(pending ?? [])].sort((a, b) => (a.materialId < b.materialId ? -1 : 1));
  for (const note of sorted) {
    if (loadGiveUp(task, note.materialId, note.contentHash)) continue;
    const draft = loadDraft(task, note.materialId, note.contentHash);
    const answered = draft?.amounts ?? {};
    const missing = [];
    for (let i = 0; i < note.segmentCount; i += 1) {
      if (answered[String(i)] === undefined) missing.push(i);
    }
    // 草稿齐了却还停在这个状态，说明上一次提交被驳回了（多半是总额对不上）。
    // 那就整张重问，而不是拿着一份已知不平的草稿接着往下走。
    if (!missing.length) {
      clearDraft(task, note.materialId);
      return questionRound(note, [...Array(note.segmentCount).keys()], {},
        draft?.rejection ?? { reasons: ['上一次这几段金额加起来和票面价税合计对不上'] });
    }
    return questionRound(note, missing, answered, draft?.rejection ?? null);
  }
  return null;
}

function questionRound(note, missing, answered, rejection) {
  const asking = missing.slice(0, MAX_QUESTIONS);
  const segs = note.candidateSegments ?? [];
  const questions = asking.map((i) => {
    const seg = segs[i] ?? null;
    const candidate = moneyCents(seg?.amount) === null ? null : String(seg.amount).trim();
    const options = [];
    if (candidate) {
      options.push({ label: candidate,
        description: `行程单第 ${i + 1} 行写的就是这个数` });
    }
    // 「这张票我认不出」永远在。它是一个正当的结局：整张退回待办，
    // 好过让用户随口报一个凑得平的数。也正好让每题都有不少于两个选项。
    options.push({ label: '这张票我认不出',
      description: '这张发票的逐段金额我说不上来 —— 整张退回待办，我去补一份逐段行程单或者把它挪出这次报销' });
    options.push({ label: '其他',
      description: '这一段的价税合计我直接告诉你（两位小数，例如 26.69）' });
    return {
      id: questionId(note.materialId, i),
      header: `第 ${i + 1} 段`,
      question: `${note.fileName}：${segmentLabel(seg, i)}的价税合计是多少？`,
      options,
      multiSelect: false,
    };
  });

  return {
    materialId: note.materialId,
    fileName: note.fileName,
    contentHash: note.contentHash,
    segmentCount: note.segmentCount,
    totalAmount: note.totalAmount,
    netAmount: note.netAmount ?? null,
    taxAmount: note.taxAmount ?? null,
    stale: note.kind === 'allocation_stale',
    // 已经答过的那几段一并摆出来：用户看得见自己上一轮说了什么，
    // 而且最后一轮问完时，加起来对不对他自己就能看出来。
    answered: Object.entries(answered)
      .map(([k, v]) => ({ index: Number(k) + 1, amount: v }))
      .sort((a, b) => a.index - b.index),
    remaining: missing.length,
    questions,
    rejection,
  };
}

/**
 * 收下一轮答案。返回 `{ verdict, ... }`；什么都没收下就是 null。
 *
 * `verdict`：
 *  - `drafted`   这一轮记下了，还有段没问完
 *  - `allocated` 齐了，且与票面分毫不差 —— 分摊落盘
 *  - `rejected`  齐了但对不上（或者格式不合法）；草稿留着理由，下一轮整张重问
 *  - `gave_up`   用户说这张票他认不出，整张退回待办
 */
export function receiveAllocationAnswers(task, roundSpec, voucher, doc) {
  if (!roundSpec) return null;
  const asked = new Map(roundSpec.questions.map((q) => [q.id, parseId(q.id).index]));
  const answers = Array.isArray(doc?.answers) ? doc.answers : [];

  // 用户在任何一题上说"认不出"，整张票就到此为止 —— 这张发票拆不出来，
  // 不是某一段拆不出来。写在哪一层都算数：写成一条答案，或者整份文件顶上一个
  // giveUp。只认一种写法的话，另一种会被判成"这几段没答"，而用户的表态
  // 被**悄悄丢掉**。
  if (doc?.giveUp === true || answers.some((a) => a?.giveUp === true)) {
    writeJson(giveUpFile(task, roundSpec.materialId), {
      materialId: roundSpec.materialId,
      contentHash: roundSpec.contentHash,
      at: new Date().toISOString(),
    });
    clearDraft(task, roundSpec.materialId);
    return { verdict: 'gave_up', materialId: roundSpec.materialId, fileName: roundSpec.fileName };
  }

  const taken = {};
  const reasons = [];
  // 哪几题已经报过错。按题记，不按文字找 —— 在一串自由文字里搜题号来判断
  // "这题说过没有"，是那种在改一句措辞时就会坏掉、且坏了看不出来的写法。
  const faulted = new Set();
  for (const a of answers) {
    if (!asked.has(a?.questionId)) {
      // 问的不是这几题。忽略，并说出来 —— 悄悄丢掉一个答案，
      // 用户会以为自己已经答过了。
      reasons.push(`答案里的 ${JSON.stringify(a?.questionId ?? null)} 不是这一轮问的题`);
      continue;
    }
    if (moneyCents(a.amount) === null) {
      reasons.push(`${a.questionId} 给的金额「${String(a.amount ?? '').trim()}」不合规矩（要两位小数、且大于 0）`);
      faulted.add(a.questionId);
      continue;
    }
    taken[String(asked.get(a.questionId))] = String(a.amount).trim();
  }
  for (const q of roundSpec.questions) {
    if (taken[String(asked.get(q.id))] === undefined && !faulted.has(q.id)) {
      reasons.push(`${q.header}没有答案`);
    }
  }

  const amounts = { ...Object.fromEntries(roundSpec.answered.map((a) => [String(a.index - 1), a.amount])),
    ...taken };
  if (reasons.length) {
    writeJson(draftFile(task, roundSpec.materialId), {
      materialId: roundSpec.materialId, contentHash: roundSpec.contentHash,
      amounts, rejection: { reasons }, updatedAt: new Date().toISOString(),
    });
    return { verdict: 'rejected', materialId: roundSpec.materialId, reasons };
  }

  const complete = Object.keys(amounts).length === roundSpec.segmentCount;
  if (!complete) {
    writeJson(draftFile(task, roundSpec.materialId), {
      materialId: roundSpec.materialId, contentHash: roundSpec.contentHash,
      amounts, rejection: null, updatedAt: new Date().toISOString(),
    });
    return { verdict: 'drafted', materialId: roundSpec.materialId,
      answered: Object.keys(amounts).length, of: roundSpec.segmentCount };
  }

  const ordered = [...Array(roundSpec.segmentCount).keys()].map((i) => amounts[String(i)]);
  const r = submitAllocation(task, voucher, ordered, roundSpec.segmentCount, { via: 'terminal' });
  if (r.verdict === 'rejected') {
    // 加起来不对。草稿整份作废，理由留着 —— 下一轮从第一段重问，
    // 并且把差多少原样念给用户。这里不去猜是哪一段错了。
    writeJson(draftFile(task, roundSpec.materialId), {
      materialId: roundSpec.materialId, contentHash: roundSpec.contentHash,
      amounts: {}, rejection: { reasons: r.reasons }, updatedAt: new Date().toISOString(),
    });
    return { verdict: 'rejected', materialId: roundSpec.materialId, reasons: r.reasons };
  }
  clearDraft(task, roundSpec.materialId);
  return { verdict: 'allocated', materialId: roundSpec.materialId,
    segmentTotalCents: r.record.segmentTotalCents,
    amounts: r.record.segmentTotalCents.map(yuan) };
}

/**
 * 用户放弃了的那几张票，报成开放项。
 *
 * 它 blocking：一张拆不出来的合并发票不能带着往 ERP 走。解法在用户那一侧
 * —— 补一份逐段行程单，或者把这张票挪出这次报销。
 */
export function givenUpOpenItems(task, pending) {
  return (pending ?? [])
    .filter((n) => loadGiveUp(task, n.materialId, n.contentHash))
    .map((n) => ({
      kind: 'allocation_given_up', blocking: true,
      materialId: n.materialId, fileName: n.fileName,
      note: `这张合并交通发票要拆成 ${n.segmentCount} 段，你说过逐段金额认不出来。`
        + '它不能带着往下走。两条出路都在材料这一侧：补一份列了逐段金额的行程单，'
        + '或者把这张票从本次材料里挪出去 —— 两种做法都会改动材料，'
        + '这条"认不出"跟着当场作废，我会重新问一遍。'
        + '（只是想改主意重答的话，删掉任务工作区 allocations 下这张票的 giveup 记录即可）',
    }));
}
