import { CONFIRM_REVIEW_ERRORS, PENDING_ANSWER_ERRORS, normalizePendingAnswer, validatePendingAnswer } from '../../contract/actions';
import type { AppAdapter } from '../../contract/adapter';
import type { TaskSnapshot } from '../../contract/snapshot';
import type { MockBus } from '../bus';
import { applyPendingAnswer, buildLines, openPendingItemCount } from '../fixtures/inventory';
import { projectAssignmentOpen } from '../fixtures/projects';

// 待确认项答复与整单明细确认（mock 服务端的角色），以及 e2e 用的「别处推进」钩子。

// 待确认项状态变化后的阶段与 step：还有未处理项 → pending / answer_pending；都处理完 → review / confirm_review 并形成候选明细。
export function settlePending(snapshot: TaskSnapshot): void {
  const taskId = snapshot.task.taskId;
  const open = openPendingItemCount(snapshot.pendingItems);
  if (open > 0) {
    snapshot.stage = 'pending';
    snapshot.lines = [];
    snapshot.step = { kind: 'answer_pending', stepToken: `tok-${taskId}-pending-${snapshot.pendingItems.length - open}` };
    return;
  }
  const lines = buildLines({ materials: snapshot.materials, events: snapshot.events, pendingItems: snapshot.pendingItems });
  snapshot.lines = lines;
  const invoices = new Set(lines.map((line) => line.voucherMaterialId)).size;
  const cents = lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0);
  // 旧确认因材料变更失效的，保持 invalidated 与提示，直到用户重新确认；否则是尚未确认。
  snapshot.confirmation = {
    ...snapshot.confirmation,
    status: snapshot.confirmation.status === 'invalidated' ? 'invalidated' : 'unconfirmed',
    confirmedAt: null,
    digest: `digest-${taskId}-${snapshot.inventory.versionId ?? 'v0'}`,
    lineCount: lines.length,
    invoiceCount: invoices,
    grossTotal: lines.length > 0 ? (cents / 100).toFixed(2) : null,
  };
  snapshot.stage = 'review';
  snapshot.step = { kind: 'confirm_review', stepToken: `tok-${taskId}-review-${snapshot.inventory.versionId ?? 'v0'}` };
}

// 整单明细确认生效：进入「去打印 / 去报销」阶段。确认之后服务端随快照给出个人项目簿允许列表（去报销路径要用）；已有的归属保留。
function applyConfirm(snapshot: TaskSnapshot, at: string): void {
  const taskId = snapshot.task.taskId;
  snapshot.confirmation = { ...snapshot.confirmation, status: 'confirmed', confirmedAt: at, notice: null };
  snapshot.task.updatedAt = at;
  snapshot.stage = 'actions';
  if (snapshot.projectAssignment.projects.length === 0) snapshot.projectAssignment = projectAssignmentOpen();
  snapshot.step = { kind: 'choose_action', stepToken: `tok-${taskId}-actions-${snapshot.inventory.versionId ?? 'v0'}` };
}

export type PendingFlow = Pick<AppAdapter, 'answerPendingItem' | 'confirmReview'> & {
  advanceElsewhere(taskId: string): void;
};

export function createPendingFlow(bus: MockBus): PendingFlow {
  let elsewhereCount = 0;
  return {
    // 答复待确认项：格式再校验一次；采用后材料字段来源记为 user；全部处理完进入整单明细确认。
    answerPendingItem: async (taskId, itemId, answer, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        const item = snapshot.pendingItems.find((candidate) => candidate.itemId === itemId);
        if (!item) return { error: { code: 'item_not_found', message: `待确认项 ${itemId} 不存在。` } };
        if (item.status !== 'open') return { error: { code: 'item_not_open', message: PENDING_ANSWER_ERRORS.notOpen } };
        const normalized = normalizePendingAnswer(item, answer);
        const errors = validatePendingAnswer(item, normalized);
        const firstError = Object.values(errors)[0];
        if (firstError) return { error: { code: 'invalid_answer', message: firstError } };
        applyPendingAnswer({ materials: snapshot.materials, events: snapshot.events, pendingItems: snapshot.pendingItems }, item, normalized);
        snapshot.task.updatedAt = bus.now();
        settlePending(snapshot);
        return snapshot;
      }),
    // 确认整单明细：摘要必须是快照里的那一份；确认后进入「去打印 / 去报销」阶段。
    confirmReview: async (taskId, digest, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.lines.length === 0) return { error: { code: 'no_lines', message: CONFIRM_REVIEW_ERRORS.noLines } };
        if (snapshot.confirmation.digest !== digest) return { error: { code: 'digest_mismatch', message: CONFIRM_REVIEW_ERRORS.digestMismatch } };
        applyConfirm(snapshot, bus.now());
        return snapshot;
      }),
    // 测试钩子：另一个窗口推进了任务，但这边还没收到事件流。待整单确认的任务被确认；其余任务只是换了 stepToken。
    // 只写内存、不推送，于是这边下一次带旧凭据的动作会得到 409 语义（stale_step + 最新快照）。
    advanceElsewhere(taskId) {
      const snapshot = bus.draft(taskId);
      elsewhereCount += 1;
      if (snapshot.step.kind === 'confirm_review' && snapshot.lines.length > 0) applyConfirm(snapshot, bus.now());
      else snapshot.step = { ...snapshot.step, stepToken: `${snapshot.step.stepToken}-elsewhere-${elsewhereCount}` };
      snapshot.task.updatedAt = bus.now();
      bus.put(snapshot);
    },
  };
}
