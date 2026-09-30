import {
  STALE_STEP_CODE,
  STALE_STEP_NOTICE,
  type ActionError,
  type ActionOutcome,
  type AdapterEvent,
  type Unsubscribe,
  TaskSnapshotSchema,
  type ProjectOption,
  type TaskSnapshot,
} from '@baox/contract';
import { withInventoryProjection, withLodgingEvidenceProjection } from './fixtures/inventory';
import { withAllowedActions } from './fixtures/allowed-actions';
import { PROJECT_BOOK, withProjectUsage } from './fixtures/projects';
import { withScreenshotGroups } from './fixtures/print';
import type { MockOptions } from './options';

// mock 服务端的公共底座：内存里的快照仓库、事件总线、服务断连模拟、stepToken 核对与 mock 时钟。
// 各业务流程（./flows/*）只经过这里读写快照：每份存进去的快照都带上服务端投影（盘点计数、「本次已归入」的条数与金额、此刻接受的动作、
// 缺支付截图待确认项的截图组），并过 schema 校验（失败即抛出）。

const EMIT_DELAY_MS = 20;
// `?fault=service-disconnected`：服务停一次。第一次读任务列表时立即断开（任务列表的头几次加载失败），
// 或第一次订阅事件流后 300 ms 断开，以先到者为准；断开 3000 ms 后恢复。断开期间事件流不送达、动作失败、任务列表读不到。
const DEFAULT_DISCONNECT_AFTER_MS = 300;
const DEFAULT_RECONNECT_AFTER_MS = 3000;
export const SERVICE_UNAVAILABLE_CODE = 'service_unavailable';
export const SERVICE_UNAVAILABLE_MESSAGE = '连不上报销服务，操作没有送达。请检查网络后重试；如果一直这样，请联系维护者。';

export type StepResult = TaskSnapshot | { error: ActionError };

export type MockBus = {
  readonly options: MockOptions;
  now(): string;
  // Seed snapshots retain their supplied revision. An unobserved accepted change can request the same increment
  // that commit and push apply before storing their snapshots.
  put(snapshot: TaskSnapshot, advanceRevision?: boolean): void;
  // 当前快照的一份可修改副本。
  draft(taskId: string): TaskSnapshot;
  all(): TaskSnapshot[];
  // An accepted action writes and returns a snapshot, then publishes the latest view. New tasks are already born at revision 1.
  commit(snapshot: TaskSnapshot, advanceRevision?: boolean): ActionOutcome;
  // 服务端自行推进（定时器）：写入并立即推送，不经过动作返回值。
  push(snapshot: TaskSnapshot): void;
  // 回复类动作先核对 stepToken：过期即返回 409 语义（stale_step + 最新快照），状态不动。
  withStep(taskId: string, stepToken: string, next: (snapshot: TaskSnapshot) => StepResult): ActionOutcome;
  fail(code: string, message: string): ActionOutcome;
  subscribe(taskId: string, onEvent: (event: AdapterEvent) => void): Unsubscribe;
  // 读任务列表前调用：service-disconnected 下触发断连；断开期间返回 false。
  listReachable(): boolean;
  isConnected(): boolean;
  // The task owner's project options are added to its assignment snapshot. The mock project-book service supplies the
  // list; until it is wired, the bus uses the default fixture list.
  projectAllowList(taskId: string): ProjectOption[];
  useProjectAllowList(source: (taskId: string) => ProjectOption[]): void;
  // 用户经 exclude-material 移出本次材料的材料（重复发票、认不出的合并发票及其行程单）：之后重新盘点也不再算它们。
  removedMaterials(taskId: string): Set<string>;
  // 支付截图组已「已传齐」的住宿发票（#331，服务端 payment_screenshot_group_complete）：重新盘点时这一项仍按已处理算。
  // 组被删空就不再算传齐。
  completeScreenshotGroups(taskId: string): Set<string>;
  // 状态变了但 step 种类没变时换发的新凭据（项目归属草稿、项目簿同步）：在原凭据后加一个全局递增的序号。
  rotateToken(stepToken: string): string;
};

const clone = (snapshot: TaskSnapshot): TaskSnapshot => structuredClone(snapshot);

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

export function createBus(options: MockOptions): MockBus {
  const snapshots = new Map<string, TaskSnapshot>();
  const listeners = new Map<string, Set<(event: AdapterEvent) => void>>();
  let connected = true;
  let outageScheduled = false;
  let allowListSource = (_taskId: string): ProjectOption[] => PROJECT_BOOK.map((project) => ({ ...project }));
  const removed = new Map<string, Set<string>>();
  const completeGroups = new Map<string, Set<string>>();
  let rotation = 0;

  const snapshotOf = (taskId: string): TaskSnapshot => {
    const snapshot = snapshots.get(taskId);
    if (!snapshot) throw new Error(`任务 ${taskId} 不存在`);
    return snapshot;
  };

  const put = (snapshot: TaskSnapshot, advanceRevision = false) => {
    const next = advanceRevision ? { ...snapshot, revision: snapshot.revision + 1 } : snapshot;
    snapshots.set(next.task.taskId, TaskSnapshotSchema.parse(withAllowedActions(withLodgingEvidenceProjection(withScreenshotGroups(withProjectUsage(withInventoryProjection(next)))))));
  };

  // 断开期间事件流不送达（恢复后页面会重新拉取快照）。
  const emit = (taskId: string, event: AdapterEvent) => {
    if (!connected) return;
    for (const listener of listeners.get(taskId) ?? []) listener(event);
  };

  const broadcast = (event: AdapterEvent) => {
    for (const set of listeners.values()) for (const listener of set) listener(event);
  };

  const goDown = () => {
    connected = false;
    broadcast({ type: 'connection', state: 'disconnected' });
    setTimeout(() => {
      connected = true;
      broadcast({ type: 'connection', state: 'connected' });
    }, options.reconnectAfterMs ?? DEFAULT_RECONNECT_AFTER_MS);
  };

  const scheduleOutage = (delayMs: number) => {
    if (options.fault !== 'service-disconnected' || outageScheduled) return;
    outageScheduled = true;
    if (delayMs <= 0) goDown();
    else setTimeout(goDown, delayMs);
  };

  const commit = (snapshot: TaskSnapshot, advanceRevision = true): ActionOutcome => {
    put(snapshot, advanceRevision);
    const taskId = snapshot.task.taskId;
    setTimeout(() => emit(taskId, { type: 'snapshot', snapshot: clone(snapshotOf(taskId)) }), EMIT_DELAY_MS);
    return { ok: true, snapshot: clone(snapshotOf(taskId)) };
  };

  return {
    options,
    now: clock(),
    put,
    draft: (taskId) => clone(snapshotOf(taskId)),
    all: () => [...snapshots.values()],
    commit,
    push(snapshot) {
      put(snapshot, true);
      const taskId = snapshot.task.taskId;
      emit(taskId, { type: 'snapshot', snapshot: clone(snapshotOf(taskId)) });
    },
    withStep(taskId, stepToken, next) {
      const current = snapshotOf(taskId);
      if (current.step.stepToken !== stepToken) {
        return { ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: clone(current) };
      }
      const result = next(clone(current));
      if ('error' in result) return { ok: false, error: result.error, snapshot: null };
      return commit(result);
    },
    fail: (code, message) => ({ ok: false, error: { code, message }, snapshot: null }),
    subscribe(taskId, onEvent) {
      const set = listeners.get(taskId) ?? new Set();
      set.add(onEvent);
      listeners.set(taskId, set);
      scheduleOutage(options.disconnectAfterMs ?? DEFAULT_DISCONNECT_AFTER_MS);
      // 断开期间新打开的页面也要看到横幅。
      if (!connected) setTimeout(() => onEvent({ type: 'connection', state: connected ? 'connected' : 'disconnected' }), 0);
      return () => {
        set.delete(onEvent);
      };
    },
    listReachable() {
      scheduleOutage(0);
      return connected;
    },
    isConnected: () => connected,
    projectAllowList: (taskId) => allowListSource(taskId),
    useProjectAllowList(source) {
      allowListSource = source;
    },
    removedMaterials(taskId) {
      const set = removed.get(taskId) ?? new Set<string>();
      removed.set(taskId, set);
      return set;
    },
    completeScreenshotGroups(taskId) {
      const set = completeGroups.get(taskId) ?? new Set<string>();
      completeGroups.set(taskId, set);
      return set;
    },
    rotateToken(stepToken) {
      rotation += 1;
      return `${stepToken.replace(/~\d+$/, '')}~${rotation}`;
    },
  };
}
