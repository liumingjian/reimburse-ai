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

/** 这一步正等着用户对读数表态吗。 */
const awaitingConfirmation = (sourceKey, after) => {
  const outstanding = after ? currentStep(sourceKey) : null;
  return !!outstanding && outstanding.token === after
    && outstanding.state === 'reading_awaiting_confirmation';
};

/**
 * 收下用户的表态。返回收下了什么（`{ verdict, materialIds }`），什么都没收下就是 `null`。
 *
 * `correctionFile` 在的时候是**指错**：用户给的值不直接落库，这几份读数整份作废，
 * 带着分歧回去重看那张图。不在的时候是**认可**：这张表上的读数全部确认。
 */
export async function applyTerminalVerdict({ sourceDir, sourceKey, after, correctionFile = null }) {
  if (!sourceDir || !awaitingConfirmation(sourceKey, after)) return null;

  const inventory = await takeInventory(sourceDir);
  // 认凭据用的是哪个 sourceKey，找任务就用哪一个 —— 从 sourceDir 再算一遍，
  // 就多了一处两边可能对不上的地方，而对不上时的样子是「点了头却没生效」。
  const task = findLiveTaskForSource(sourceKey);
  if (!task) return null;
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
