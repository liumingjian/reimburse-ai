import {
  CONFIRM_REVIEW_ERRORS,
  PENDING_ANSWER_ERRORS,
  REOPEN_UPLOAD_ERRORS,
  STALE_STEP_CODE,
  STALE_STEP_NOTICE,
  normalizePendingAnswer,
  validatePendingAnswer,
  type ActionError,
} from '../contract/actions';
import type { ActionOutcome, AdapterEvent, AppAdapter, Unsubscribe } from '../contract/adapter';
import { PAYMENT_SCREENSHOT_ERRORS, REVIEW_INVALIDATED_NOTICE, TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';
import { applyPendingAnswer, buildLines, inventoryResult } from './fixtures/inventory';
import { EMPLOYEE, T1_ID, emptySnapshot, inventoryNotStarted, t1Snapshot, t2Snapshot, t3Snapshot, toListItem, uploadedMaterial } from './fixtures/tasks';
import type { MockOptions } from './options';
import { duplicateReason, judgeFile } from './upload';

export { FAULTS, readMockOptions, type Fault, type MockOptions } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。
// 每份交出去的快照都过 schema 校验（失败即抛出），保证夹具与契约不脱节。
// 已实现：任务列表、快照外壳、新建任务、上传批次、材料盘点（定时推进）、待确认项答复、整单明细确认、支付截图、确认后追加材料（确认失效）；
// 其余动作原样返回当前快照，由后续票逐个实现。

const EMIT_DELAY_MS = 20;
const DEFAULT_PHASE_MS = 450;

// mock 的「现在」：夹具时间之后逐次递增，保证 updatedAt 单调。
function clock(): () => string {
  let minute = 0;
  return () => {
    minute += 1;
    const hh = String(15 + Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    return `2026-09-11T${hh}:${mm}:00`;
  };
}

type StepResult = TaskSnapshot | { error: ActionError };

export function createMockAdapter(options: MockOptions): AppAdapter {
  const snapshots = new Map<string, TaskSnapshot>();
  const listeners = new Map<string, Set<(event: AdapterEvent) => void>>();
  let nextTaskNo = 4;
  let nextFileNo = 1;
  let nextScreenshotNo = 1;
  let reopenCount = 0;
  const now = clock();
  const phaseMs = options.inventoryPhaseMs ?? DEFAULT_PHASE_MS;

  const put = (snapshot: TaskSnapshot) => {
    snapshots.set(snapshot.task.taskId, TaskSnapshotSchema.parse(snapshot));
  };

  put(t1Snapshot(options.seed ?? 'upload', options.fault === 'unsupported-material'));
  put(t2Snapshot());
  put(t3Snapshot());

  const clone = (snapshot: TaskSnapshot): TaskSnapshot => structuredClone(snapshot);

  const emit = (taskId: string, event: AdapterEvent) => {
    for (const listener of listeners.get(taskId) ?? []) listener(event);
  };

  const commit = (snapshot: TaskSnapshot): ActionOutcome => {
    put(snapshot);
    const copy = clone(snapshot);
    setTimeout(() => emit(snapshot.task.taskId, { type: 'snapshot', snapshot: clone(snapshot) }), EMIT_DELAY_MS);
    return { ok: true, snapshot: copy };
  };

  // 服务端自行推进（盘点阶段）：写入并立即推送，不经过动作返回值。
  const push = (snapshot: TaskSnapshot) => {
    put(snapshot);
    emit(snapshot.task.taskId, { type: 'snapshot', snapshot: clone(snapshot) });
  };

  const snapshotOf = (taskId: string): TaskSnapshot => {
    const snapshot = snapshots.get(taskId);
    if (!snapshot) throw new Error(`任务 ${taskId} 不存在`);
    return snapshot;
  };

  // 回复类动作先核对 stepToken：过期即返回 409 语义（错误码 stale_step + 最新快照），状态不动。
  const withStep = (taskId: string, stepToken: string, next: (snapshot: TaskSnapshot) => StepResult): ActionOutcome => {
    const current = snapshotOf(taskId);
    if (current.step.stepToken !== stepToken) {
      return { ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: clone(current) };
    }
    const result = next(clone(current));
    if ('error' in result) return { ok: false, error: result.error, snapshot: null };
    return commit(result);
  };

  const unchanged = async (taskId: string): Promise<ActionOutcome> => ({ ok: true, snapshot: clone(snapshotOf(taskId)) });

  const openCount = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').length;

  // 盘点结束：材料分类、费用事件与待确认项落进快照；有待确认项则进入 pending 阶段，否则直接形成候选明细进入 review。
  const finishInventory = (snapshot: TaskSnapshot) => {
    const result = inventoryResult(snapshot.materials, options.fault === 'unsupported-material');
    snapshot.materials = result.materials;
    snapshot.events = result.events;
    snapshot.pendingItems = result.pendingItems;
    snapshot.inventory.status = 'done';
    snapshot.inventory.finishedAt = now();
    snapshot.task.updatedAt = snapshot.inventory.finishedAt;
    settlePending(snapshot);
  };

  // 待确认项状态变化后的阶段与 step：还有未处理项 → pending / answer_pending；都处理完 → review / confirm_review 并形成候选明细。
  const settlePending = (snapshot: TaskSnapshot) => {
    const taskId = snapshot.task.taskId;
    const open = openCount(snapshot);
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
  };

  // 材料变更（追加批次）：整单明细确认失效、打印稿作废，任务回到上传阶段等待新批次与新一轮盘点。
  const invalidateForMaterialChange = (snapshot: TaskSnapshot) => {
    if (snapshot.confirmation.status === 'confirmed') {
      snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: REVIEW_INVALIDATED_NOTICE };
    }
    if (snapshot.printSheet.status === 'generated') snapshot.printSheet.status = 'stale';
    snapshot.stage = 'upload';
    reopenCount += 1;
    snapshot.step = { kind: 'start_inventory', stepToken: `tok-${snapshot.task.taskId}-upload-reopen-${reopenCount}` };
  };

  return {
    async listTasks(): Promise<TaskList> {
      const tasks = [...snapshots.values()].map(toListItem).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return TaskListSchema.parse({ employee: EMPLOYEE, tasks });
    },
    async getSnapshot(taskId) {
      return clone(snapshotOf(taskId));
    },
    subscribe(taskId, onEvent): Unsubscribe {
      const set = listeners.get(taskId) ?? new Set();
      set.add(onEvent);
      listeners.set(taskId, set);
      const timers: ReturnType<typeof setTimeout>[] = [];
      if (options.fault === 'service-disconnected') {
        timers.push(setTimeout(() => onEvent({ type: 'connection', state: 'disconnected' }), 300));
      }
      return () => {
        for (const timer of timers) clearTimeout(timer);
        set.delete(onEvent);
      };
    },
    async createTask(input) {
      const taskId = `T${nextTaskNo}`;
      nextTaskNo += 1;
      const period = input.periodStart && input.periodEnd ? { start: input.periodStart, end: input.periodEnd } : null;
      const at = now();
      return commit(emptySnapshot({ taskId, name: input.name.trim(), period, createdAt: at, updatedAt: at }, 'upload'));
    },
    // 上传批次：逐文件判定（类型、20MB、HEIC、内容重复），结果记进新批次；接收的文件成为待盘点材料。
    // `?fault=duplicate-upload`：第二批起，第一份本可接收的文件按内容重复拒绝。
    async uploadBatch(taskId, files) {
      const snapshot = clone(snapshotOf(taskId));
      const known = new Map<string, string>();
      for (const material of snapshot.materials) known.set(material.contentHash, material.fileName);
      const batchId = `b${snapshot.batches.length + 1}`;
      const batch: TaskSnapshot['batches'][number] = { batchId, no: snapshot.batches.length + 1, uploadedAt: now(), versionId: null, files: [] };
      let faultPending = options.fault === 'duplicate-upload' && batch.no >= 2;
      for (const file of files) {
        const fileId = `f${String(nextFileNo).padStart(3, '0')}`;
        nextFileNo += 1;
        let verdict = await judgeFile(file, known);
        if (verdict.status === 'accepted' && faultPending) {
          faultPending = false;
          const existing = snapshot.materials[0]?.fileName ?? file.name;
          verdict = { status: 'rejected', reasonCode: 'duplicate_content', reason: duplicateReason(existing) };
        }
        if (verdict.status === 'rejected') {
          batch.files.push({ fileId, fileName: file.name, size: file.size, status: 'rejected', contentHash: null, reasonCode: verdict.reasonCode, reason: verdict.reason, materialId: null });
          continue;
        }
        const materialId = `m-${fileId}`;
        known.set(verdict.contentHash, file.name);
        snapshot.materials.push(uploadedMaterial({ materialId, batchId, fileName: file.name, size: file.size, contentHash: verdict.contentHash }));
        batch.files.push({ fileId, fileName: file.name, size: file.size, status: 'accepted', contentHash: verdict.contentHash, reasonCode: null, reason: null, materialId });
      }
      snapshot.batches.push(batch);
      snapshot.task.updatedAt = batch.uploadedAt;
      // 盘点之后再追加批次：材料变了，旧确认失效，任务回到上传阶段（服务端兜底，即使页面没有先走 reopenUpload）。
      if (snapshot.stage !== 'upload') invalidateForMaterialChange(snapshot);
      // 有材料后，当前待答 step 变成「开始材料盘点」；状态变了，凭据也换。
      if (snapshot.materials.length > 0) snapshot.step = { kind: 'start_inventory', stepToken: `tok-${taskId}-upload-${batchId}` };
      return commit(snapshot);
    },
    // 开始材料盘点：阶段推到 inventory，盘点分阶段按定时器推进并推送快照；结束后形成结果。
    startInventory: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.materials.length === 0) return { error: { code: 'no_materials', message: '还没有被接收的材料。' } };
        const versionId = `v${snapshot.batches.length}`;
        for (const batch of snapshot.batches) batch.versionId = versionId;
        snapshot.stage = 'inventory';
        snapshot.task.updatedAt = now();
        snapshot.inventory = { ...inventoryNotStarted(), status: 'running', versionId };
        const first = snapshot.inventory.phases[0];
        if (first) first.status = 'running';
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-inventory-${versionId}` };

        const phaseCount = snapshot.inventory.phases.length;
        const advance = (index: number) => {
          const current = clone(snapshotOf(taskId));
          if (current.inventory.versionId !== versionId || current.inventory.status !== 'running') return;
          const phases = current.inventory.phases;
          const done = phases[index];
          if (done) done.status = 'done';
          const next = phases[index + 1];
          if (next) {
            next.status = 'running';
            push(current);
            setTimeout(() => advance(index + 1), phaseMs);
          } else {
            finishInventory(current);
            push(current);
          }
        };
        setTimeout(() => advance(0), phaseMs);
        return snapshot;
      }),
    // 答复待确认项：格式再校验一次；采用后材料字段来源记为 user；全部处理完进入整单明细确认。
    answerPendingItem: async (taskId, itemId, answer, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        const item = snapshot.pendingItems.find((candidate) => candidate.itemId === itemId);
        if (!item) return { error: { code: 'item_not_found', message: `待确认项 ${itemId} 不存在。` } };
        if (item.status !== 'open') return { error: { code: 'item_not_open', message: PENDING_ANSWER_ERRORS.notOpen } };
        const normalized = normalizePendingAnswer(item, answer);
        const errors = validatePendingAnswer(item, normalized);
        const firstError = Object.values(errors)[0];
        if (firstError) return { error: { code: 'invalid_answer', message: firstError } };
        applyPendingAnswer({ materials: snapshot.materials, events: snapshot.events, pendingItems: snapshot.pendingItems }, item, normalized);
        snapshot.task.updatedAt = now();
        settlePending(snapshot);
        return snapshot;
      }),
    // 确认整单明细：摘要必须是快照里的那一份；确认后进入「去打印 / 去报销」阶段。
    confirmReview: async (taskId, digest, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.lines.length === 0) return { error: { code: 'no_lines', message: CONFIRM_REVIEW_ERRORS.noLines } };
        if (snapshot.confirmation.digest !== digest) return { error: { code: 'digest_mismatch', message: CONFIRM_REVIEW_ERRORS.digestMismatch } };
        snapshot.confirmation = { ...snapshot.confirmation, status: 'confirmed', confirmedAt: now(), notice: null };
        snapshot.task.updatedAt = snapshot.confirmation.confirmedAt ?? snapshot.task.updatedAt;
        snapshot.stage = 'actions';
        snapshot.step = { kind: 'choose_action', stepToken: `tok-${taskId}-actions-${snapshot.inventory.versionId ?? 'v0'}` };
        return snapshot;
      }),
    // 确认后追加材料：整单明细确认失效、打印稿作废，回到上传阶段。ERP 已开始写入的任务不能再动材料。
    reopenUpload: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.erp.status !== 'idle') return { error: { code: 'erp_started', message: REOPEN_UPLOAD_ERRORS.erpStarted } };
        invalidateForMaterialChange(snapshot);
        snapshot.task.updatedAt = now();
        return snapshot;
      }),
    // 支付截图：只接受图片；每张住宿发票至多一张，再补即替换。只进 paymentScreenshots，不碰确认状态与 step。
    async addPaymentScreenshot(taskId, voucherMaterialId, file) {
      const snapshot = clone(snapshotOf(taskId));
      const line = snapshot.lines.find((candidate) => candidate.voucherMaterialId === voucherMaterialId);
      if (!line || !line.acceptsPaymentScreenshot) {
        return { ok: false, error: { code: 'screenshot_not_applicable', message: PAYMENT_SCREENSHOT_ERRORS.notApplicable }, snapshot: null };
      }
      if (!isImage(file)) return { ok: false, error: { code: 'not_image', message: PAYMENT_SCREENSHOT_ERRORS.notImage }, snapshot: null };
      const screenshotId = `s${nextScreenshotNo}`;
      nextScreenshotNo += 1;
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.voucherMaterialId !== voucherMaterialId);
      snapshot.paymentScreenshots.push({ screenshotId, voucherMaterialId, fileName: file.name, url: objectUrl(file, screenshotId) });
      snapshot.task.updatedAt = now();
      return commit(snapshot);
    },
    async removePaymentScreenshot(taskId, screenshotId) {
      const snapshot = clone(snapshotOf(taskId));
      if (!snapshot.paymentScreenshots.some((shot) => shot.screenshotId === screenshotId)) {
        return { ok: false, error: { code: 'screenshot_not_found', message: PAYMENT_SCREENSHOT_ERRORS.notFound }, snapshot: null };
      }
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.screenshotId !== screenshotId);
      snapshot.task.updatedAt = now();
      return commit(snapshot);
    },
    generatePrintSheet: unchanged,
    rotatePlacement: unchanged,
    cropPlacement: unchanged,
    submitProjectAssignment: async (taskId, _input, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
    startErpWrite: async (taskId, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
    confirmLogin: async (taskId, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
    reconcile: unchanged,
    handOff: unchanged,
  };
}

// 图片判定按扩展名，其次按 MIME（无扩展名时）。
function isImage(file: File): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (match) return /^(jpe?g|png)$/i.test(match[1] ?? '');
  return /^image\/(jpeg|png)$/.test(file.type);
}

// 浏览器里给截图一个可显示的对象 URL；jsdom 没有 createObjectURL，用占位地址。
function objectUrl(file: File, screenshotId: string): string {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(file);
  return `mock:screenshot/${screenshotId}`;
}

export const MOCK_MAIN_TASK_ID = T1_ID;
