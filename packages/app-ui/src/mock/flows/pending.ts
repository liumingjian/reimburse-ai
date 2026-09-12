import { CONFIRM_REVIEW_ERRORS, PENDING_ANSWER_ERRORS, normalizePendingAnswer, validatePendingAnswer } from '../../contract/actions';
import type { AppAdapter } from '../../contract/adapter';
import type { TaskSnapshot } from '../../contract/snapshot';
import type { MockBus } from '../bus';
import { applyPendingAnswer, buildLines, openPendingItemCount } from '../fixtures/inventory';
import { projectAssignmentOpen } from '../fixtures/projects';

// 待确认项答复与整单明细确认（mock 服务端的角色），以及 e2e 用的「别处推进」钩子。

// 待确认项状态变化后的阶段与 step：还有未处理项 → pending / answer_pending；
// 都处理完 → 形成候选明细，进入项目归属（project / assign_projects）。整单确认在项目归属之后（摘要绑定项目）。
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
  // 摘要要等项目归属提交、报销信息核对与材料准备都完成后才有（见 flows/project.ts）。
  snapshot.confirmation = {
    ...snapshot.confirmation,
    status: snapshot.confirmation.status === 'invalidated' ? 'invalidated' : 'unconfirmed',
    confirmedAt: null,
    digest: null,
    lineCount: lines.length,
    invoiceCount: invoices,
    grossTotal: lines.length > 0 ? (cents / 100).toFixed(2) : null,
  };
  // 进入项目归属：服务端随快照给出个人项目簿允许列表。重新盘点后回到这里时，保留仍存在的明细的归属，但要重新提交。
  const assignment = snapshot.projectAssignment;
  if (assignment.projects.length === 0) {
    snapshot.projectAssignment = projectAssignmentOpen(snapshot.task.homeCity);
  } else if (assignment.status === 'submitted') {
    const lineIds = new Set(lines.map((line) => line.lineId));
    snapshot.projectAssignment = { ...assignment, status: 'pending', assignments: assignment.assignments.filter((item) => lineIds.has(item.lineId)), submittedAt: null };
  }
  snapshot.stage = 'project';
  snapshot.step = { kind: 'assign_projects', stepToken: `tok-${taskId}-project-${snapshot.inventory.versionId ?? 'v0'}` };
}

// 整单明细确认生效：进入「去打印 / 去报销」阶段。
function applyConfirm(snapshot: TaskSnapshot, at: string): void {
  const taskId = snapshot.task.taskId;
  snapshot.confirmation = { ...snapshot.confirmation, status: 'confirmed', confirmedAt: at, notice: null };
  snapshot.task.updatedAt = at;
  snapshot.stage = 'actions';
  snapshot.step = { kind: 'choose_action', stepToken: `tok-${taskId}-actions-${(snapshot.confirmation.digest ?? 'none').slice(-8)}` };
}

export type PendingFlow = Pick<AppAdapter, 'answerPendingItem' | 'confirmReview'> & {
  advanceElsewhere(taskId: string): void;
};

export function createPendingFlow(bus: MockBus): PendingFlow {
  let elsewhereCount = 0;
  return {
    // 答复待确认项：格式再校验一次；采用后材料字段来源记为 user；全部处理完进入项目归属。
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
        if (snapshot.step.kind !== 'confirm_review' || snapshot.confirmation.digest === null) {
          return { error: { code: 'digest_mismatch', message: CONFIRM_REVIEW_ERRORS.digestMismatch } };
        }
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
