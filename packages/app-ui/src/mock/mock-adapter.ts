import {
  CONFIRM_REVIEW_ERRORS,
  ERP_ACTION_ERRORS,
  PENDING_ANSWER_ERRORS,
  PRINT_ACTION_ERRORS,
  PROJECT_ASSIGNMENT_ERRORS,
  ProjectAssignmentInputSchema,
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
import {
  ERP_STEP_INDEX,
  applyAbortAtSave,
  applyErpDone,
  applyReadbackMismatch,
  erpSteps,
  handedOffBanner,
  loginNotDetected,
} from './fixtures/erp';
import { applyPendingAnswer, buildLines, inventoryResult } from './fixtures/inventory';
import { buildPrintSheet, cornersValid, cropPage, refreshScreenshots, rotatePage } from './fixtures/print';
import { projectAssignmentOpen, projectAssignmentSubmitted } from './fixtures/projects';
import { EMPLOYEE, T1_DRAFT_NO, T1_ID, emptySnapshot, inventoryNotStarted, t1Snapshot, t2Snapshot, t3Snapshot, toListItem, uploadedMaterial } from './fixtures/tasks';
import type { MockOptions } from './options';
import { duplicateReason, judgeFile } from './upload';

export { FAULTS, readMockOptions, type Fault, type MockOptions } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。
// 每份交出去的快照都过 schema 校验（失败即抛出），保证夹具与契约不脱节。
// 已实现：任务列表、快照外壳、新建任务、上传批次、材料盘点（定时推进）、待确认项答复、整单明细确认、支付截图、确认后追加材料（确认失效）、项目归属提交、
// ERP 填报（定时推进、登录交接）、严格回读、对账（重新对账 / 转人工）、打印稿（生成、旋转、四角裁剪，都不碰整单明细确认）。

const EMIT_DELAY_MS = 20;
const DEFAULT_PHASE_MS = 450;
const DEFAULT_ERP_STEP_MS = 300;
const DEFAULT_ERP_LOGIN_AUTO_MS = 2500;
// `?fault=erp-login-missing`：前两次「我已登录，继续」都探测不到登录，第三次才检测到；该故障下服务端不会自己探测到。
const LOGIN_MISSING_ATTEMPTS = 2;
// `?fault=service-disconnected`：第一次订阅后断开，过一会儿恢复（只发生一次）；断开期间事件流不送达，动作失败。
const DEFAULT_DISCONNECT_AFTER_MS = 300;
const DEFAULT_RECONNECT_AFTER_MS = 3000;
export const SERVICE_UNAVAILABLE_CODE = 'service_unavailable';
export const SERVICE_UNAVAILABLE_MESSAGE = '本地服务没有响应，操作没有送达。请在终端重新执行 baox 后重试。';

// 只在 mock 构建里挂到 window 上的测试钩子（e2e 用）：模拟「另一个窗口推进了任务」，而这边的事件流还没送到。
export type MockHooks = {
  advanceElsewhere(taskId: string): void;
};

declare global {
  interface Window {
    __baoxMock?: MockHooks;
  }
}

export type MockAdapter = AppAdapter & MockHooks;

export function installMockHooks(target: Window, adapter: MockAdapter): void {
  target.__baoxMock = { advanceElsewhere: (taskId) => adapter.advanceElsewhere(taskId) };
}

// 读快照与订阅不受断连影响（快照读的是内存）；其余都是动作，断开期间一律失败，原因就地显示在按钮旁。
const READ_METHODS: ReadonlySet<keyof AppAdapter> = new Set<keyof AppAdapter>(['listTasks', 'getSnapshot', 'subscribe']);

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

export function createMockAdapter(options: MockOptions): MockAdapter {
  const snapshots = new Map<string, TaskSnapshot>();
  const listeners = new Map<string, Set<(event: AdapterEvent) => void>>();
  let connected = true;
  let outageScheduled = false;
  let elsewhereCount = 0;
  let nextTaskNo = 4;
  let nextFileNo = 1;
  let nextScreenshotNo = 1;
  let reopenCount = 0;
  const now = clock();
  const phaseMs = options.inventoryPhaseMs ?? DEFAULT_PHASE_MS;
  const erpStepMs = options.erpStepMs ?? DEFAULT_ERP_STEP_MS;
  const erpLoginAutoMs = options.erpLoginAutoMs ?? DEFAULT_ERP_LOGIN_AUTO_MS;
  // 每个任务当前这一轮 ERP 写入的编号、登录探测次数与重新对账次数；定时器只推进自己那一轮。
  const erpRuns = new Map<string, number>();
  const loginAttempts = new Map<string, number>();
  const reconcileCounts = new Map<string, number>();
  let nextErpRun = 1;

  const put = (snapshot: TaskSnapshot) => {
    snapshots.set(snapshot.task.taskId, TaskSnapshotSchema.parse(snapshot));
  };

  const seeded = t1Snapshot(options.seed ?? 'upload', options.fault === 'unsupported-material');
  if (options.printSheet) seeded.printSheet = buildPrintSheet(seeded);
  put(seeded);
  put(t2Snapshot());
  put(t3Snapshot());

  const clone = (snapshot: TaskSnapshot): TaskSnapshot => structuredClone(snapshot);

  // 断开期间事件流不送达（恢复后页面会重新拉取快照）。
  const emit = (taskId: string, event: AdapterEvent) => {
    if (!connected) return;
    for (const listener of listeners.get(taskId) ?? []) listener(event);
  };

  const broadcast = (event: AdapterEvent) => {
    for (const set of listeners.values()) for (const listener of set) listener(event);
  };

  // 服务断连与恢复：第一次订阅时排期，只发生一次。
  const scheduleOutage = () => {
    if (options.fault !== 'service-disconnected' || outageScheduled) return;
    outageScheduled = true;
    setTimeout(() => {
      connected = false;
      broadcast({ type: 'connection', state: 'disconnected' });
      setTimeout(() => {
        connected = true;
        broadcast({ type: 'connection', state: 'connected' });
      }, options.reconnectAfterMs ?? DEFAULT_RECONNECT_AFTER_MS);
    }, options.disconnectAfterMs ?? DEFAULT_DISCONNECT_AFTER_MS);
  };

  const commit = (snapshot: TaskSnapshot): ActionOutcome => {
    put(snapshot);
    const copy = clone(snapshot);
    // 事件流推送的是推送那一刻的最新快照（服务端定时推进可能已经走在这次动作前面），不是动作当时的副本。
    const taskId = snapshot.task.taskId;
    setTimeout(() => emit(taskId, { type: 'snapshot', snapshot: clone(snapshotOf(taskId)) }), EMIT_DELAY_MS);
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

  // 支付截图变了：已生成的打印稿随之更新该页截图与提醒（不作废、不碰确认）。
  const afterScreenshotChange = (snapshot: TaskSnapshot) => {
    if (snapshot.printSheet.status === 'generated') snapshot.printSheet = refreshScreenshots(snapshot.printSheet, snapshot);
  };

  // 打印稿的旋转与裁剪：只改这一页的放置（服务端立即重新渲染该页），不改原件、不碰确认状态与 step。
  const adjustPage = (
    taskId: string,
    pageId: string,
    slot: 'top' | 'bottom',
    change: (page: TaskSnapshot['printSheet']['pages'][number]) => TaskSnapshot['printSheet']['pages'][number] | { error: ActionError },
  ): ActionOutcome => {
    const snapshot = clone(snapshotOf(taskId));
    if (snapshot.printSheet.status !== 'generated') {
      return { ok: false, error: { code: 'print_not_generated', message: PRINT_ACTION_ERRORS.notGenerated }, snapshot: null };
    }
    const index = snapshot.printSheet.pages.findIndex((page) => page.pageId === pageId);
    const page = snapshot.printSheet.pages[index];
    if (!page) return { ok: false, error: { code: 'page_not_found', message: PRINT_ACTION_ERRORS.pageNotFound }, snapshot: null };
    if (!page[slot]) return { ok: false, error: { code: 'slot_empty', message: PRINT_ACTION_ERRORS.slotEmpty }, snapshot: null };
    const result = change(page);
    if ('error' in result) return { ok: false, error: result.error, snapshot: null };
    snapshot.printSheet.pages[index] = result;
    snapshot.task.updatedAt = now();
    return commit(snapshot);
  };

  const openCount = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').length;

  // 整单明细确认生效：进入「去打印 / 去报销」阶段。确认之后服务端随快照给出个人项目簿允许列表（去报销路径要用）；已有的归属保留。
  const applyConfirm = (snapshot: TaskSnapshot) => {
    const taskId = snapshot.task.taskId;
    snapshot.confirmation = { ...snapshot.confirmation, status: 'confirmed', confirmedAt: now(), notice: null };
    snapshot.task.updatedAt = snapshot.confirmation.confirmedAt ?? snapshot.task.updatedAt;
    snapshot.stage = 'actions';
    if (snapshot.projectAssignment.projects.length === 0) snapshot.projectAssignment = projectAssignmentOpen();
    snapshot.step = { kind: 'choose_action', stepToken: `tok-${taskId}-actions-${snapshot.inventory.versionId ?? 'v0'}` };
  };

  // 测试钩子：另一个窗口推进了任务，但这边还没收到事件流。待整单确认的任务被确认；其余任务只是换了 stepToken。
  // 只写内存、不推送，于是这边下一次带旧凭据的动作会得到 409 语义（stale_step + 最新快照）。
  const advanceElsewhere = (taskId: string) => {
    const snapshot = clone(snapshotOf(taskId));
    elsewhereCount += 1;
    if (snapshot.step.kind === 'confirm_review' && snapshot.lines.length > 0) applyConfirm(snapshot);
    else snapshot.step = { ...snapshot.step, stepToken: `${snapshot.step.stepToken}-elsewhere-${elsewhereCount}` };
    snapshot.task.updatedAt = now();
    put(snapshot);
  };

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

  // ---- ERP 填报（服务端角色）：定时推进各步，登录步等用户或自动探测，保存与严格回读按故障决定结局 ----

  const erpRunLive = (snapshot: TaskSnapshot, run: number, status: TaskSnapshot['erp']['status']) =>
    erpRuns.get(snapshot.task.taskId) === run && snapshot.erp.status === status;

  // 浏览器已启动：登录步进入等待，当前待答 step 变为 erp_login。正常场景下服务端过一会儿自己探测到登录。
  const reachLogin = (taskId: string, run: number) => {
    const current = clone(snapshotOf(taskId));
    if (!erpRunLive(current, run, 'running')) return;
    current.erp.status = 'waiting_login';
    current.erp.steps = erpSteps(ERP_STEP_INDEX.login, 'waiting');
    current.step = { kind: 'erp_login', stepToken: `tok-${taskId}-erp-login-${run}-1` };
    push(current);
    if (options.fault !== 'erp-login-missing') {
      setTimeout(() => {
        const latest = clone(snapshotOf(taskId));
        if (!erpRunLive(latest, run, 'waiting_login')) return;
        loginDetected(latest, run);
        push(latest);
      }, erpLoginAutoMs);
    }
  };

  // 探测到登录：从导入发票开始逐步推进。
  const loginDetected = (snapshot: TaskSnapshot, run: number) => {
    const taskId = snapshot.task.taskId;
    snapshot.erp.status = 'running';
    snapshot.erp.loginNotice = null;
    snapshot.erp.steps = erpSteps(ERP_STEP_INDEX.import, 'running');
    snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-write-${run}` };
    setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.import), erpStepMs);
  };

  // 第 index 步结束：保存步在 erp-write-aborted 下中止；严格回读按 readback-mismatch 决定一致或停在对账。
  const finishErpStep = (taskId: string, run: number, index: number) => {
    const current = clone(snapshotOf(taskId));
    if (!erpRunLive(current, run, 'running')) return;
    current.task.updatedAt = now();
    if (index === ERP_STEP_INDEX.save && options.fault === 'erp-write-aborted') {
      applyAbortAtSave(current);
      push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.save) current.erp.draftNo = T1_DRAFT_NO;
    if (index === ERP_STEP_INDEX.readback) {
      const draftNo = current.erp.draftNo ?? T1_DRAFT_NO;
      if (options.fault === 'readback-mismatch') applyReadbackMismatch(current, draftNo);
      else applyErpDone(current, draftNo);
      push(current);
      return;
    }
    current.erp.steps = erpSteps(index + 1, 'running');
    push(current);
    setTimeout(() => finishErpStep(taskId, run, index + 1), erpStepMs);
  };

  const adapter: AppAdapter = {
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
      scheduleOutage();
      // 断开期间新打开的页面也要看到横幅。
      if (!connected) setTimeout(() => onEvent({ type: 'connection', state: connected ? 'connected' : 'disconnected' }), 0);
      return () => {
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
        applyConfirm(snapshot);
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
      afterScreenshotChange(snapshot);
      snapshot.task.updatedAt = now();
      return commit(snapshot);
    },
    async removePaymentScreenshot(taskId, screenshotId) {
      const snapshot = clone(snapshotOf(taskId));
      if (!snapshot.paymentScreenshots.some((shot) => shot.screenshotId === screenshotId)) {
        return { ok: false, error: { code: 'screenshot_not_found', message: PAYMENT_SCREENSHOT_ERRORS.notFound }, snapshot: null };
      }
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.screenshotId !== screenshotId);
      afterScreenshotChange(snapshot);
      snapshot.task.updatedAt = now();
      return commit(snapshot);
    },
    // 生成打印稿：须已完成整单明细确认；已生成的直接返回（幂等），作废的按当前确认数据重新生成。
    async generatePrintSheet(taskId) {
      const snapshot = clone(snapshotOf(taskId));
      if (snapshot.confirmation.status !== 'confirmed') {
        return { ok: false, error: { code: 'not_confirmed', message: PRINT_ACTION_ERRORS.notConfirmed }, snapshot: null };
      }
      if (snapshot.printSheet.status === 'generated') return { ok: true, snapshot };
      snapshot.printSheet = buildPrintSheet(snapshot);
      snapshot.task.updatedAt = now();
      return commit(snapshot);
    },
    rotatePlacement: async (taskId, pageId, slot, rotate) => adjustPage(taskId, pageId, slot, (page) => rotatePage(page, slot, rotate)),
    cropPlacement: async (taskId, pageId, slot, corners) =>
      adjustPage(taskId, pageId, slot, (page) => {
        if (!page[slot]?.croppable) return { error: { code: 'not_croppable', message: PRINT_ACTION_ERRORS.notCroppable } };
        if (!cornersValid(corners)) return { error: { code: 'invalid_corners', message: PRINT_ACTION_ERRORS.invalidCorners } };
        return cropPage(page, slot, corners);
      }),
    // 提交项目归属（服务端角色）：事由 1-100 字；每条明细都要有项目；项目必须在允许列表里且可选；不认识的明细拒绝。
    // 通过后记下归属与事由，阶段推到 erp，ERP 填报入口开放。整单明细确认不动（摘要不含项目与事由）。
    submitProjectAssignment: async (taskId, input, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'choose_action' && snapshot.step.kind !== 'assign_projects') {
          return { error: { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady } };
        }
        const parsed = ProjectAssignmentInputSchema.safeParse(input);
        if (!parsed.success) return { error: { code: 'invalid_purpose', message: PROJECT_ASSIGNMENT_ERRORS.purpose } };
        const { purpose, projects } = parsed.data;
        const lineIds = new Set(snapshot.lines.map((line) => line.lineId));
        const unknown = Object.keys(projects).find((lineId) => !lineIds.has(lineId));
        if (unknown) return { error: { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) } };
        const allowed = new Set(snapshot.projectAssignment.projects.filter((project) => project.selectable).map((project) => project.number));
        if (allowed.size === 0) return { error: { code: 'project_book_empty', message: PROJECT_ASSIGNMENT_ERRORS.bookEmpty } };
        for (const line of snapshot.lines) {
          const number = projects[line.lineId];
          if (!number) return { error: { code: 'line_unassigned', message: PROJECT_ASSIGNMENT_ERRORS.lineUnassigned(line.no) } };
          if (!allowed.has(number)) return { error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(line.no, number) } };
        }
        const at = now();
        snapshot.projectAssignment = projectAssignmentSubmitted({ purpose, projects, submittedAt: at });
        snapshot.task.updatedAt = at;
        snapshot.stage = 'erp';
        snapshot.erp = { status: 'idle', steps: erpSteps(-1), draftNo: null, abortReason: null, loginNotice: null };
        snapshot.step = { kind: 'start_erp_write', stepToken: `tok-${taskId}-erp` };
        return snapshot;
      }),
    // 开始填报：第一步「启动浏览器」进行中，随后登录步等待。写入进行中没有待答 step（none）。
    startErpWrite: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'start_erp_write') return { error: { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady } };
        const run = nextErpRun;
        nextErpRun += 1;
        erpRuns.set(taskId, run);
        loginAttempts.set(taskId, 0);
        snapshot.erp = { status: 'running', steps: erpSteps(ERP_STEP_INDEX.browser, 'running'), draftNo: null, abortReason: null, loginNotice: null };
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = now();
        setTimeout(() => reachLogin(taskId, run), erpStepMs);
        return snapshot;
      }),
    // 「我已登录，继续」= 请服务端再探测一次。探测不到：留在登录步，给出说明并换新凭据（摆给用户看的内容变了）。
    confirmLogin: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'erp_login') return { error: { code: 'not_waiting_login', message: ERP_ACTION_ERRORS.notWaitingLogin } };
        const run = erpRuns.get(taskId) ?? 0;
        const attempt = (loginAttempts.get(taskId) ?? 0) + 1;
        loginAttempts.set(taskId, attempt);
        if (options.fault === 'erp-login-missing' && attempt <= LOGIN_MISSING_ATTEMPTS) {
          snapshot.erp.loginNotice = loginNotDetected(attempt);
          snapshot.step = { kind: 'erp_login', stepToken: `tok-${taskId}-erp-login-${run}-${attempt + 1}` };
          return snapshot;
        }
        loginDetected(snapshot, run);
        return snapshot;
      }),
    // 重新对账：只读 ERP 再判定一次。保存步中止的任务读到草稿且逐行一致 ⇒ 完成；仍有不一致的行 ⇒ 原地等待，结果写进横幅。
    reconcile: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        const count = (reconcileCounts.get(taskId) ?? 0) + 1;
        reconcileCounts.set(taskId, count);
        snapshot.task.updatedAt = now();
        if (snapshot.reconcile.rows.length === 0 && snapshot.lines.length > 0) {
          applyErpDone(snapshot, T1_DRAFT_NO);
          snapshot.reconcile = {
            ...snapshot.reconcile,
            status: 'none',
            bucket: '已保存',
            action: '原地等待',
            banner: `重新对账：ERP 中已有草稿 ${T1_DRAFT_NO}，${snapshot.readback.rows.length} 行明细逐行一致。`,
            draftNo: T1_DRAFT_NO,
            reasons: [],
          };
          return snapshot;
        }
        const bad = snapshot.reconcile.rows.filter((row) => !row.matched).length;
        snapshot.reconcile.status = 'waiting';
        snapshot.reconcile.banner = `已重新对账（第 ${count} 次）：ERP 草稿 ${snapshot.reconcile.draftNo ?? ''} 仍有 ${bad} 行与本地确认不一致。你在 ERP 中修正后可以再次对账，或者转人工。`;
        snapshot.step = { kind: 'reconcile', stepToken: `tok-${taskId}-reconcile-${count}` };
        return snapshot;
      }),
    // 转人工：终止后续 ERP 写入，任务停在对账阶段并标记为已转人工（终态），对账记录保留。
    handOff: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        erpRuns.delete(taskId);
        snapshot.reconcile = { ...snapshot.reconcile, status: 'handed_off', action: '转人工', banner: handedOffBanner(snapshot.reconcile.draftNo) };
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-handed-off` };
        snapshot.task.updatedAt = now();
        return snapshot;
      }),
  };

  // 断开期间动作不送达：统一包一层，失败原因由页面就地显示。
  const guarded: Record<string, unknown> = { ...adapter };
  for (const key of Object.keys(adapter) as (keyof AppAdapter)[]) {
    if (READ_METHODS.has(key)) continue;
    const original = adapter[key] as unknown as (...args: unknown[]) => Promise<ActionOutcome>;
    guarded[key] = async (...args: unknown[]): Promise<ActionOutcome> =>
      connected ? original(...args) : { ok: false, error: { code: SERVICE_UNAVAILABLE_CODE, message: SERVICE_UNAVAILABLE_MESSAGE }, snapshot: null };
  }
  return Object.assign(guarded as unknown as AppAdapter, { advanceElsewhere });
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
