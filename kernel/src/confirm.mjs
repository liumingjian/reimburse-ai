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
import path from 'node:path';
import { currentStep } from './steptoken.mjs';
import { takeInventoryForTask } from './inventory.mjs';
import { correctionInboxIn, findLiveTaskForSource, homeCityAnswerIn,
  recordTaskHomeCity, hasErpWriteState, taskDir } from './workspace.mjs';
import { pendingConfirmations, confirmReadings, disputeReading, loadReading,
  fieldComplaint } from './vision.mjs';
import { settleDispute, RULING_STEP_KEYS } from './dispute.mjs';
import { erpSnapshot, observeTask } from './observe.mjs';
import { receiveAllocationAnswers, roundFingerprint } from './allocate.mjs';
import { ALLOCATION_KINDS } from './events.mjs';
import { readBinding, writeBinding, bindingVerdict } from './binding.mjs';
import { probeIdentity } from './probe.mjs';
import { validHomeCity, writeHomeCity } from './home-city.mjs';
import { classifiedDetailDigest, confirmClassifiedDetail, classifiedCorrectionOptions } from './classified-detail.mjs';
import { hasRecoveryMarker, validateLocalPreparationRecovery } from './recovery-flow.mjs';
import { inspectPreparation } from './preparation.mjs';

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

const awaitingPreparationConfirmation = (sourceKey, after) =>
  outstandingStep(sourceKey, after)?.state === 'preparation_confirmation';

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
  resultFile = null, mode = 'markdown' }) {
  // 认身份排在最前，而且**不要求有材料目录、不要求有任务**：它发生在这条链子的
  // 最开头，那会儿两样都还不存在。放在下面那道 `!sourceDir` 后面的话，
  // 用户在终端上认了人，内核什么都不会记下 —— 表现是同一张表一遍遍地问。
  if (outstandingStep(sourceKey, after)?.state === 'env_identity_unbound') {
    return receiveIdentity(outstandingStep(sourceKey, after));
  }
  const pendingStep = outstandingStep(sourceKey, after);
  // The old write-approval state is retained only for reading historical
  // records.  Its outstanding token must not be able to create a new approval
  // after the first-stage handoff replaced that state in the normal flow.
  if (pendingStep?.state === 'ready_for_erp_write') {
    return { verdict: 'ignored', status: 'legacy_write_approval_expired',
      note: '旧 ERP 写入确认凭据已过期；本轮只接受独立 preparation confirmation' };
  }
  if (pendingStep?.state === 'home_city_required') {
    return receiveHomeCity({ sourceDir, sourceKey, outstanding: pendingStep, resultFile, correctionFile });
  }
  if (pendingStep?.state === 'profile_confirmation') {
    return receiveProfileConfirmation({ sourceKey, outstanding: pendingStep, resultFile, correctionFile });
  }
  if (!sourceDir) return null;
  const outstanding = outstandingStep(sourceKey, after);
  if (outstanding?.state === 'classified_detail_confirmation') {
    return receiveClassifiedDetail({ sourceDir, sourceKey, outstanding, correctionFile, resultFile });
  }
  const ruling = awaitingRuling(sourceKey, after);
  const allocating = ALLOCATION_KINDS.has(outstanding?.state);
  const preparing = awaitingPreparationConfirmation(sourceKey, after);
  if (!ruling && !allocating && !preparing && !awaitingConfirmation(sourceKey, after)) return null;

  // 认凭据用的是哪个 sourceKey，找任务就用哪一个 —— 从 sourceDir 再算一遍，
  // 就多了一处两边可能对不上的地方，而对不上时的样子是「点了头却没生效」。
  const task = findLiveTaskForSource(sourceKey);
  if (!task) return null;

  // A marker never becomes writable just because a terminal confirmation is due.
  // Every confirmation path gets a fresh identity/material/ERP readback first.
  let recovery = null;
  if (hasRecoveryMarker(task)) {
    recovery = await validateLocalPreparationRecovery(sourceDir);
    if (!recovery.ok) {
      return { verdict: 'recovery_rejected', status: recovery.status,
        reasons: recovery.reasons ?? ['本地恢复 fresh 只读核对没有通过'],
        credentialPath: recovery.credentialPath ?? null };
    }
  }

  // 后半段那两步各自重算自己要的那份观测，不用这里的盘点。
  if (allocating) return receiveAllocation({ sourceDir, task, outstanding, resultFile });
  if (preparing) return receivePreparationConfirmation({ sourceDir, task, outstanding, mode });

  const inventory = await takeInventoryForTask(sourceDir, task);

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

const sameIdentity = (left, right) => !!left && !!right
  && left.account === right.account && left.tenant === right.tenant;

const jsonFile = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

async function receiveHomeCity({ sourceDir, sourceKey, outstanding, resultFile, correctionFile }) {
  if (!resultFile || correctionFile
    || path.resolve(resultFile) !== path.resolve(homeCityAnswerIn())) return null;

  const probe = await probeIdentity();
  const binding = readBinding();
  const meta = outstanding.meta ?? {};
  if (probe.status !== 'matched' || bindingVerdict(binding, probe.identity) !== 'matched'
    || !sameIdentity(binding, { account: meta.account, tenant: meta.tenant })) return null;

  const task = findLiveTaskForSource(sourceKey);
  let recovery = null;
  if (task && hasRecoveryMarker(task)) {
    if (!sourceDir) return { verdict: 'recovery_rejected', status: 'materials_missing',
      reasons: ['恢复本地准备前必须能找到原材料目录'] };
    recovery = await validateLocalPreparationRecovery(sourceDir);
    if (!recovery.ok) return { verdict: 'recovery_rejected', status: recovery.status,
      reasons: recovery.reasons ?? ['本地恢复 fresh 只读核对没有通过'] };
  }
  if ((task?.taskId ?? null) !== (meta.taskId ?? null)
    || (task && (!recovery?.ok && hasErpWriteState(task)
      || !sameIdentity(task.identity, probe.identity)))) return null;

  const answer = jsonFile(resultFile);
  const homeCity = answer?.homeCity === '确认' ? meta.suggestedHomeCity : answer?.homeCity;
  if (!validHomeCity(homeCity)) {
    return { verdict: 'rejected', reasons: ['常驻城市必须填写，且不超过 20 个字'] };
  }
  const record = writeHomeCity(probe.identity, homeCity);
  if (!record) return { verdict: 'rejected', reasons: ['常驻城市记忆文件不可安全更新，已停止写入'] };
  const updated = task ? recordTaskHomeCity(task, probe.identity, record.homeCity,
    { allowRecovery: recovery?.ok === true }) : null;
  if (task && !updated) return null;
  return { verdict: 'home_city_confirmed', ...record,
    task: updated ? { taskId: updated.taskId, homeCity: updated.homeCity } : null };
}

async function receiveProfileConfirmation({ sourceKey, outstanding, resultFile, correctionFile }) {
  if (!resultFile || correctionFile
    || path.resolve(resultFile) !== path.resolve(homeCityAnswerIn())) return null;

  const probe = await probeIdentity();
  const binding = readBinding();
  const meta = outstanding.meta ?? {};
  if (probe.status !== 'matched' || bindingVerdict(binding, probe.identity) !== 'matched'
    || !sameIdentity(binding, { account: meta.account, tenant: meta.tenant })) return null;

  const answer = jsonFile(resultFile);
  if (answer?.homeCity !== '确认' && !validHomeCity(answer?.homeCity)) {
    return { verdict: 'rejected', reasons: ['请回复「确认」，或直接填写新的常驻城市'] };
  }
  if (answer.homeCity === '确认') {
    return { verdict: 'profile_confirmed', homeCity: meta.homeCity ?? null };
  }
  const record = writeHomeCity(probe.identity, answer.homeCity);
  if (!record) return { verdict: 'rejected', reasons: ['常驻城市记忆文件不可安全更新，已停止写入'] };
  return { verdict: 'profile_confirmed', homeCity: record.homeCity, replaced: true };
}

async function receiveClassifiedDetail({ sourceDir, sourceKey, outstanding, correctionFile, resultFile }) {
  if (resultFile) return null;
  const task = findLiveTaskForSource(sourceKey);
  const meta = outstanding.meta ?? {};
  if (!task || task.taskId !== meta.taskId) return null;

  let recovery = null;
  if (hasRecoveryMarker(task)) {
    recovery = await validateLocalPreparationRecovery(sourceDir);
    if (!recovery.ok) return { verdict: 'recovery_rejected', status: recovery.status,
      reasons: recovery.reasons ?? ['本地恢复 fresh 只读核对没有通过'] };
  }

  const probe = await probeIdentity();
  const binding = readBinding();
  if (probe.status !== 'matched' || bindingVerdict(binding, probe.identity) !== 'matched'
    || !sameIdentity(task.identity, probe.identity)
    || !sameIdentity(binding, { account: meta.account, tenant: meta.tenant })) return null;

  const snap = await observeTask(sourceDir);
  if (!snap.eventsRecorded || !snap.classifiedDetailComplete
    || snap.openItems.some((item) => item.blocking)
    || meta.digest !== classifiedDetailDigest(snap.classifiedPreview)) return null;

  if (correctionFile) {
    if (path.resolve(correctionFile) !== path.resolve(correctionInboxIn(task.workspace))) {
      return { verdict: 'rejected', status: 'classified_detail_correction_path_invalid',
        reasons: ['分类明细纠正文件不是当前任务登记的文件，未采纳'] };
    }
    const doc = jsonFile(correctionFile);
    if (!Array.isArray(doc?.corrections) || !doc.corrections.length) {
      return { verdict: 'rejected', status: 'classified_detail_correction_invalid',
        reasons: ['分类明细纠正必须包含至少一条材料字段'] };
    }
    const materials = new Map((snap.classifiedPreview.evidence ?? [])
      .map((item) => [item.materialId, item]));
    const options = new Map(classifiedCorrectionOptions(task, snap.classifiedPreview)
      .map((item) => [item.materialId, item]));
    const seen = new Set();
    const validated = [];
    const reextracts = [];
    for (const correction of doc.corrections) {
      const material = materials.get(correction?.materialId);
      const available = options.get(correction?.materialId);
      if (correction?.reextract === true) {
        const extraKeys = Object.keys(correction).filter((key) => !['materialId', 'reextract'].includes(key));
        const reextractPath = available?.reextractPath ? path.resolve(available.reextractPath) : null;
        const workspace = path.resolve(taskDir(task));
        if (!material || seen.has(correction?.materialId) || extraKeys.length
          || available?.action !== 'reextract_same_hash' || !reextractPath
          || (reextractPath !== workspace && !reextractPath.startsWith(`${workspace}${path.sep}`))) {
          return { verdict: 'rejected', status: 'classified_detail_reextract_invalid',
            materialId: correction?.materialId ?? null,
            reasons: ['同 hash PDF 重新抽取必须只指向当前候选材料，且只能填写 reextract: true'] };
        }
        const request = {
          schemaVersion: 1,
          taskId: task.taskId,
          versionId: snap.classifiedPreview.versionId ?? null,
          materialId: material.materialId,
          contentHash: material.contentHash,
          markdownHash: available.markdownHash,
          requestedAt: new Date().toISOString(),
        };
        seen.add(correction.materialId);
        reextracts.push({ materialId: material.materialId, path: reextractPath, request });
        continue;
      }
      const fields = correction?.fields;
      if (!material || seen.has(correction?.materialId) || !fields
        || typeof fields !== 'object' || Array.isArray(fields)
        || !Object.keys(fields).length) {
        return { verdict: 'rejected', status: 'classified_detail_correction_invalid',
          reasons: ['分类明细纠正必须指向当前表格中的唯一材料，并至少填写一个字段'] };
      }
      if (!available?.fields?.length) {
        return { verdict: 'rejected', status: 'classified_detail_correction_unavailable',
          materialId: correction.materialId,
          reasons: [available?.reason
            ?? `材料 ${correction.materialId} 当前没有可纠正的看图读数；请替换原材料后重新解析`] };
      }
      const invalid = Object.keys(fields).filter((key) => !available.fields.includes(key));
      if (invalid.length) {
        return { verdict: 'rejected', status: 'classified_detail_correction_field_invalid',
          materialId: correction.materialId,
          reasons: [`材料 ${correction.materialId} 只能纠正当前看图读数中的字段：${available.labels.join('、')}`,
            `收到未声明字段：${invalid.join('、')}`] };
      }
      const reading = loadReading(task, correction.materialId);
      const fieldReasons = Object.entries(fields).map(([key, value]) => fieldComplaint(key, value))
        .filter(Boolean);
      if (!reading || reading.contentHash !== material.contentHash) {
        return { verdict: 'rejected', status: 'classified_detail_correction_stale',
          materialId: correction.materialId,
          reasons: [`材料 ${correction.materialId} 的看图读数已经不是当前 hash；请重新读取并确认`] };
      }
      if (fieldReasons.length) {
        return { verdict: 'rejected', status: 'classified_detail_correction_field_invalid',
          materialId: correction.materialId, reasons: fieldReasons };
      }
      if (!Object.entries(fields).some(([key, value]) => value !== reading.fields?.[key])) {
        return { verdict: 'rejected', status: 'classified_detail_correction_no_change',
          materialId: correction.materialId, reasons: ['纠正值与当前看图读数没有形成可核对的字段差异'] };
      }
      seen.add(correction.materialId);
      validated.push({ materialId: correction.materialId, fields });
    }
    if (reextracts.length && validated.length) {
      return { verdict: 'rejected', status: 'classified_detail_reextract_mixed',
        reasons: ['同一轮只能请求 PDF 重新抽取，不能同时提交视觉读数纠正'] };
    }
    if (reextracts.length) {
      for (const request of reextracts) {
        fs.mkdirSync(path.dirname(request.path), { recursive: true, mode: 0o700 });
        const temporary = `${request.path}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, `${JSON.stringify(request.request, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, request.path);
      }
      return { verdict: 'markdown_reextract_requested', materials: reextracts.map(({ materialId, path: requestPath }) =>
        ({ materialId, path: requestPath })),
        note: '当前候选已失效；重新提交同 hash PDF 候选后，分类确认会重新生成' };
    }
    const corrected = validated.map(({ materialId, fields }) =>
      disputeReading(task, materialId, fields)).filter((result) => result?.disputed?.length);
    return corrected.length === validated.length
      ? { verdict: 'corrected', materials: corrected }
      : { verdict: 'rejected', status: 'classified_detail_correction_failed',
        reasons: ['分类明细纠正没有成功建立可重读的材料争议，请重新提交'] };
  }

  const record = confirmClassifiedDetail(task, snap.classifiedPreview, probe.identity);
  return record ? { verdict: 'classified_detail_confirmed', ...record } : null;
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
 * 用户在终端上认下了「我在替谁报销」。
 *
 * 落盘的身份**不来自回传，也不来自登记簿**：内核在这一刻重新读一次 ERP，
 * 拿读到的那一个去落盘，并且要求它和用户刚才看过的那一份（凭据里记着的
 * account + tenant）一模一样。两次之间人换了、会话掉了，这次点头就当场作废 ——
 * 用户认下的永远只是他看过的那一个身份，而不是"现在恰好登录着的那个"。
 *
 * 这样一来，从 ERP 页面到 identity.json，全程没有一个字符串经过模型的手 ——
 * 这正是原来那张本地确认页在守的东西，换成终端表格之后它一点没少。
 */
export async function receiveIdentity(outstanding, { probe: readIdentity = probeIdentity } = {}) {
  const probe = await readIdentity();
  if (probe.status !== 'matched') return null;
  const want = outstanding.meta ?? {};
  if (!want.account || !want.tenant) return null;
  if (probe.identity.account !== want.account || probe.identity.tenant !== want.tenant) return null;
  // 已经绑在同一个身份上就不重写：确认时间是「哪一次点头」的记录，不该被一次
  // 重发的凭据刷新。
  const previous = readBinding();
  if (bindingVerdict(previous, probe.identity) === 'matched') {
    return { verdict: 'identity_bound', binding: previous, replaced: null };
  }
  return { verdict: 'identity_bound', binding: writeBinding(probe.identity), replaced: previous };
}

/**
 * Record the preparation confirmation. This is deliberately a separate
 * record from write-approval: it is only allowed after a fresh observation
 * has re-built the same digest and byte-verified its immutable package. The
 * later ERP writer consumes this exact record and creates the final approval
 * only after importing and re-reading the ERP receipt rows.
 */
async function receivePreparationConfirmation({ sourceDir, task, outstanding, mode = 'markdown' }) {
  const meta = outstanding.meta ?? {};
  if (!meta.preparationDigest) return null;
  const probe = await probeIdentity();
  const binding = readBinding();
  if (probe.status !== 'matched'
    || bindingVerdict(binding, probe.identity) !== 'matched'
    || !sameIdentity(task?.identity, probe.identity)
    || meta.account !== probe.identity.account
    || meta.tenant !== probe.identity.tenant) return null;
  const snap = await observeTask(sourceDir, { mode });
  const currentTask = snap.taskRecord ?? task;
  const packageInspection = snap.preparationInspection
    ?? inspectPreparation({ task: currentTask, preparation: snap.preparation });
  if (!snap.preparation || snap.preparation.ready !== true
    || snap.preparation.digest !== meta.preparationDigest
    || snap.preparationPackageCurrent !== true
    || !packageInspection.ok
    || packageInspection.digest !== meta.preparationDigest
    || packageInspection.manifest?.manifestHash !== meta.packageManifestHash
    || packageInspection.manifest?.bundleHash !== meta.packageBundleHash) return null;
  if (!currentTask?.taskId || currentTask.taskId !== meta.taskId
    || currentTask.currentVersionId !== snap.preparation.document?.task?.versionId) return null;

  const record = {
    schemaVersion: 1,
    kind: 'preparation_confirmation',
    taskId: currentTask.taskId,
    sourceKey: currentTask.sourceKey ?? null,
    versionId: currentTask.currentVersionId ?? null,
    digest: snap.preparation.digest,
    identity: currentTask.identity ? {
      account: currentTask.identity.account ?? null,
      tenant: currentTask.identity.tenant ?? null,
    } : null,
    manifestHash: packageInspection.manifest.manifestHash,
    bundleHash: packageInspection.manifest.bundleHash,
    packageDirectory: packageInspection.directory,
    confirmedAt: new Date().toISOString(),
    confirmedVia: 'terminal',
  };
  const destination = path.join(taskDir(currentTask), 'preparation-confirmation.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return { verdict: 'preparation_confirmed', digest: record.digest,
    manifestHash: record.manifestHash, bundleHash: record.bundleHash,
    packageDirectory: record.packageDirectory };
}
