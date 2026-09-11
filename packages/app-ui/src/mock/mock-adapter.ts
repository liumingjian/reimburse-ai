import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import type { ActionOutcome, AdapterEvent, AppAdapter, Unsubscribe } from '../contract/adapter';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';
import { EMPLOYEE, T1_ID, emptySnapshot, t1Snapshot, t2Snapshot, t3Snapshot, toListItem, uploadedMaterial } from './fixtures/tasks';
import type { MockOptions } from './options';
import { duplicateReason, judgeFile } from './upload';

export { FAULTS, readMockOptions, type Fault, type MockOptions } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。
// 每份交出去的快照都过 schema 校验（失败即抛出），保证夹具与契约不脱节。
// 已实现：任务列表、快照外壳、新建任务、上传批次（逐文件接收/拒绝）；其余动作原样返回当前快照，由后续票逐个实现。

const EMIT_DELAY_MS = 20;

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

export function createMockAdapter(options: MockOptions): AppAdapter {
  const snapshots = new Map<string, TaskSnapshot>();
  const listeners = new Map<string, Set<(event: AdapterEvent) => void>>();
  let nextTaskNo = 4;
  let nextFileNo = 1;
  const now = clock();

  const put = (snapshot: TaskSnapshot) => {
    snapshots.set(snapshot.task.taskId, TaskSnapshotSchema.parse(snapshot));
  };

  put(t1Snapshot(options.seed ?? 'upload'));
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

  const snapshotOf = (taskId: string): TaskSnapshot => {
    const snapshot = snapshots.get(taskId);
    if (!snapshot) throw new Error(`任务 ${taskId} 不存在`);
    return snapshot;
  };

  // 回复类动作先核对 stepToken：过期即返回 409 语义（错误码 stale_step + 最新快照），状态不动。
  const withStep = (taskId: string, stepToken: string, next: (snapshot: TaskSnapshot) => TaskSnapshot): ActionOutcome => {
    const current = snapshotOf(taskId);
    if (current.step.stepToken !== stepToken) {
      return { ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: clone(current) };
    }
    return commit(next(clone(current)));
  };

  const unchanged = async (taskId: string): Promise<ActionOutcome> => ({ ok: true, snapshot: clone(snapshotOf(taskId)) });

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
      // 有材料后，当前待答 step 变成「开始材料盘点」；状态变了，凭据也换。
      if (snapshot.materials.length > 0) snapshot.step = { kind: 'start_inventory', stepToken: `tok-${taskId}-upload-${batchId}` };
      return commit(snapshot);
    },
    // 本票只做入口：把阶段推到 inventory 并给批次一个盘点版本；盘点进度与结果由 #102 实现。
    startInventory: async (taskId, stepToken) =>
      withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.materials.length === 0) return snapshot;
        const versionId = `v${snapshot.batches.length}`;
        for (const batch of snapshot.batches) batch.versionId = versionId;
        snapshot.stage = 'inventory';
        snapshot.task.updatedAt = now();
        snapshot.step = { kind: 'start_inventory', stepToken: `tok-${taskId}-inventory` };
        return snapshot;
      }),
    answerPendingItem: async (taskId, _itemId, _answer, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
    confirmReview: async (taskId, _digest, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
    addPaymentScreenshot: unchanged,
    removePaymentScreenshot: unchanged,
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

export const MOCK_MAIN_TASK_ID = T1_ID;
