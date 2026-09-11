import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import type { ActionOutcome, AdapterEvent, AppAdapter, Unsubscribe } from '../contract/adapter';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';
import { EMPLOYEE, T1_ID, emptySnapshot, t1Snapshot, t2Snapshot, t3Snapshot, toListItem } from './fixtures/tasks';
import type { MockOptions } from './options';

export { FAULTS, readMockOptions, type Fault, type MockOptions } from './options';

// 浏览器内 mock 适配器：实现与 HTTP 适配器相同的接口，用内存里的快照回答一切。
// 每份交出去的快照都过 schema 校验（失败即抛出），保证夹具与契约不脱节。
// 本票只实现任务列表与快照外壳；动作大多原样返回当前快照，由后续票逐个实现。

const EMIT_DELAY_MS = 20;

export function createMockAdapter(options: MockOptions): AppAdapter {
  const snapshots = new Map<string, TaskSnapshot>();
  const listeners = new Map<string, Set<(event: AdapterEvent) => void>>();
  let nextTaskNo = 4;

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
      const now = '2026-09-11T15:00:00';
      return commit(emptySnapshot({ taskId, name: input.name.trim(), period, createdAt: now, updatedAt: now }, 'upload'));
    },
    uploadBatch: unchanged,
    startInventory: async (taskId, stepToken) => withStep(taskId, stepToken, (snapshot) => snapshot),
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
