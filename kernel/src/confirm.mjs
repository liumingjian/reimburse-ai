/**
 * 用户在终端上的表态，落成事实。
 *
 * 这是整条链子上唯一一件**不以「跑一条命令」收尾**的事：`confirm_table` 的回传
 * 本身就是那个动作，没有 stdout 可交。所以它需要一个自己的落盘时机 ——
 * 在采观测之前。顺序反过来，内核会拿着确认前的那份观测再问一次同一张表，
 * 用户会以为自己点了个没用的头。
 *
 * 三道闸缺一不可：
 *
 *  1. 凭据必须是内核**此刻挂着的那一个**（一次性，不匹配就当没回传）。
 *  2. 它对应的状态必须正是「等你过目」—— 别的步骤上的点头不构成对读数的确认。
 *  3. 只动**那一张表上列出的**材料。用户点的是他看见的那几行，不是这个任务里
 *     碰巧还有的别的东西。
 *
 * 任何一条不满足就什么都不做，交给 `next` 按当前状态重发。不报错，不惩罚 ——
 * 「不可跳步」是物理实现，不是给模型的告诫。
 *
 * 关于「确认只来自用户」这件事的老实话：内核看不见终端，它验不了敲回传的那一刻
 * 用户是不是真的点了头。它能做到的是把确认收窄成**一次带一次性凭据、
 * 只对这一张表有效、内核自己渲染过内容的往返** —— 聊天里飘过的一句"对的"
 * 不带凭据，也就永远变不成事实。剩下那一段由 Skill 那一侧的规矩顶着。
 */
import fs from 'node:fs';
import { currentStep } from './steptoken.mjs';
import { takeInventory } from './inventory.mjs';
import { findLiveTaskForSource } from './workspace.mjs';
import { pendingConfirmations, confirmReadings, disputeReading } from './vision.mjs';
import { settleDispute, RULING_STEP_KEYS } from './dispute.mjs';
import { erpSnapshot } from './observe.mjs';
import { receiveAllocationAnswers, roundFingerprint } from './allocate.mjs';
import { ALLOCATION_KINDS } from './events.mjs';
import { recordWriteApproval, writePreviewDigest } from './erpwrite.mjs';

/** 内核此刻挂着的那一步，且回传的凭据正是它。对不上就是 null。 */
const outstandingStep = (sourceKey, after) => {
  const outstanding = after ? currentStep(sourceKey) : null;
  return outstanding && outstanding.token === after ? outstanding : null;
};

/**
 * 用户在终端上表态的两种步骤，各自认自己的凭据。
 *
 * 分得这么细，是因为它们收下的东西完全不同：一张表上的指错**开一场争议**，
 * 争议里的拍板**收一场争议**。凭据串了台，用户在证据都还没摆出来的时候
 * 就"拍了板"，而那正是这一整票要挡住的事。
 */
const awaitingConfirmation = (sourceKey, after) =>
  outstandingStep(sourceKey, after)?.state === 'reading_awaiting_confirmation';

// 争议那一步的凭据带着 phase（reading_disputed:ruling），因为摆证据、请拍板、
// 补缺口是三步不同的事。收终值的只有后两步 —— 证据还没摆出来的时候不存在拍板。
// 凭据名从 dispute.mjs 取，不在这里再写一份：两边各写一份字符串的话，
// 加一个 phase 就会出现「发得出、收不下」的那种错，而它在代码里看不出来。
const awaitingRuling = (sourceKey, after) =>
  RULING_STEP_KEYS.has(outstandingStep(sourceKey, after)?.state);

// 对话提问那两个状态（问的是同一件事：这张合并发票逐段多少钱）。状态名和
// 事件层那两种开放项同名，取的就是 events.mjs 里那一份，不在这里再抄一遍。

/**
 * 收下用户的表态。什么都没收下就是 `null`。
 *
 * 收下了什么，四种步骤各答各的（`verdict` 认得出是哪一种）：
 *  - 读数那张表：`confirmed`（认可，带 materialIds）/ `corrected`（指错，开一场争议）
 *  - 争议里的拍板：`ruled`
 *  - 对话提问：`drafted` / `allocated` / `rejected` / `gave_up`
 *  - 写入前那次点头：`write_approved`（带条数和合计）
 *
 * 形状不统一是故意的：这四件事收下的东西本来就不是一种，硬拉成一个形状，
 * 读它的人就得再去猜哪几个字段这次有效。
 */
export async function applyTerminalVerdict({ sourceDir, sourceKey, after, correctionFile = null,
  resultFile = null }) {
  if (!sourceDir) return null;
  const outstanding = outstandingStep(sourceKey, after);
  const ruling = awaitingRuling(sourceKey, after);
  const allocating = ALLOCATION_KINDS.has(outstanding?.state);
  const approving = outstanding?.state === 'ready_for_erp_write';
  if (!ruling && !allocating && !approving && !awaitingConfirmation(sourceKey, after)) return null;

  // 认凭据用的是哪个 sourceKey，找任务就用哪一个 —— 从 sourceDir 再算一遍，
  // 就多了一处两边可能对不上的地方，而对不上时的样子是「点了头却没生效」。
  const task = findLiveTaskForSource(sourceKey);
  if (!task) return null;

  // 后半段那两步各自重算自己要的那份观测，不用这里的盘点。
  if (allocating) return receiveAllocation({ sourceDir, task, outstanding, resultFile });
  if (approving) return receiveApproval({ sourceDir, task, outstanding, correctionFile });

  const inventory = await takeInventory(sourceDir);

  // 争议里的拍板。用户给的终值仍然**不是直接落库** —— 它要过格式闸，
  // 还要过守恒式：式子不平就只记下缺口，一个字段都不写，更不反算另外两个值。
  if (ruling) {
    if (!correctionFile) return null;
    const doc = JSON.parse(fs.readFileSync(correctionFile, 'utf8'));
    const byId = new Map(inventory.materials.map((m) => [m.materialId, m]));
    const settled = (doc.corrections ?? [])
      .filter((c) => byId.has(c.materialId))
      .map((c) => settleDispute(task, c.materialId, byId.get(c.materialId).contentHash,
        { values: c.fields ?? {}, giveUp: c.unreadable === true }))
      .filter(Boolean);
    return settled.length ? { verdict: 'ruled', rulings: settled } : null;
  }

  const shown = pendingConfirmations(task, inventory);
  if (!shown.length) return null;

  if (correctionFile) {
    const doc = JSON.parse(fs.readFileSync(correctionFile, 'utf8'));
    const onTable = new Set(shown.map((p) => p.materialId));
    const touched = (doc.corrections ?? [])
      .filter((c) => onTable.has(c.materialId))
      .map((c) => disputeReading(task, c.materialId, c.fields ?? {}))
      .filter(Boolean);
    // 一份纠正却没指到表上任何一行，是「用户表达了不认可」——
    // 那也不能算确认。什么都不做，这张表再问一次。
    return touched.length
      ? { verdict: 'corrected', materialIds: touched.map((x) => x.materialId) }
      : null;
  }

  return { verdict: 'confirmed', ...confirmReadings(task, shown.map((p) => p.materialId)) };
}

/**
 * 对话提问的答案：一轮逐段金额。收下的门槛一分不让 ——
 * 各段之和与票面价税合计按分精确相等，差一分整轮退回重问。
 *
 * 除了凭据，这里还要核一遍**问出去的那几题**：状态没变、题却换过一批
 * （上一轮答完了，或者草稿作废重来），旧凭据当场失效。不核的话，
 * 上一轮的答案会落到这一轮的段上 —— 这是这一层唯一一种会算错钱的方式。
 */
async function receiveAllocation({ sourceDir, task, outstanding, resultFile }) {
  if (!resultFile) return null;
  const snap = await erpSnapshot(sourceDir, task);
  const round = snap.allocationRound;
  const asked = outstanding.meta?.questions ?? null;
  if (!round || !asked
    || JSON.stringify(asked) !== JSON.stringify(roundFingerprint(round.questions))) return null;
  const voucher = snap.classification.results.find((r) => r.materialId === round.materialId);
  if (!voucher) return null;
  const r = receiveAllocationAnswers(task, round, voucher, JSON.parse(fs.readFileSync(resultFile, 'utf8')));
  return r ? { verdict: r.verdict, materialId: r.materialId, fileName: round.fileName,
    reasons: r.reasons ?? [], amounts: r.amounts ?? null } : null;
}

/**
 * 写入前的那一次点头。这是唯一不可撤销的一步，所以它比别处多一道闸：
 * 用户点头的那份内容，必须**逐字**还是现在这份。指纹对不上就当没点过 ——
 * 那不是苛刻，那是"他点的头只对他看过的那一份有效"这句话的实现。
 */
async function receiveApproval({ sourceDir, task, outstanding, correctionFile }) {
  // 指错不在这一步收：这张表上不改值。有一处不对，回去改那一层。
  if (correctionFile) return null;
  const snap = await erpSnapshot(sourceDir, task);
  if (!snap.writePreview || outstanding.meta?.previewDigest !== writePreviewDigest(snap.writePreview)) {
    return null;
  }
  const record = recordWriteApproval(task, snap.writePreview);
  return { verdict: 'write_approved', lineCount: record.lineCount,
    totalAmount: (record.totalCents / 100).toFixed(2), digest: record.digest };
}
