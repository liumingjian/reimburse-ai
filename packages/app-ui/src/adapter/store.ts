import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import type { ActionOutcome, AppAdapter, ConnectionState, Unsubscribe } from '../contract/adapter';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';

// 快照仓库：唯一的前端状态容器，只保存服务端给的快照与加载/连接状态，供 useSyncExternalStore 订阅。
// 不派生业务事实；页面需要的每个数字与判断都来自快照本身。

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type TaskListState = {
  readonly status: LoadStatus;
  readonly data: TaskList | null;
  readonly error: string | null;
};

export type TaskEntry = {
  readonly status: LoadStatus;
  readonly snapshot: TaskSnapshot | null;
  readonly error: string | null;
  // 一次性提示（如「任务已在别处推进」），页面显示后可清除。
  readonly notice: string | null;
};

export type AppState = {
  readonly taskList: TaskListState;
  readonly tasks: Readonly<Record<string, TaskEntry>>;
  readonly connection: ConnectionState;
};

const EMPTY_ENTRY: TaskEntry = { status: 'idle', snapshot: null, error: null, notice: null };

const INITIAL_STATE: AppState = {
  taskList: { status: 'idle', data: null, error: null },
  tasks: {},
  connection: 'connected',
};

export type StoreOptions = {
  // 开发与 mock 模式下每份快照都过 schema 校验，失败即抛出。
  validate: boolean;
};

export class AppStore {
  private state: AppState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, { count: number; unsubscribe: Unsubscribe }>();

  constructor(
    readonly adapter: AppAdapter,
    private readonly options: StoreOptions,
  ) {}

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): AppState => this.state;

  entry(taskId: string): TaskEntry {
    return this.state.tasks[taskId] ?? EMPTY_ENTRY;
  }

  async loadTaskList(): Promise<void> {
    if (this.state.taskList.status === 'loading') return;
    this.setState({ taskList: { status: 'loading', data: this.state.taskList.data, error: null } });
    try {
      const raw = await this.adapter.listTasks();
      const data = this.options.validate ? TaskListSchema.parse(raw) : raw;
      this.setState({ taskList: { status: 'ready', data, error: null } });
    } catch (error) {
      this.setState({ taskList: { status: 'error', data: this.state.taskList.data, error: describe(error) } });
    }
  }

  // 打开任务：拉取快照并订阅事件流；同一任务被多个组件打开时只订阅一次。返回关闭函数。
  openTask(taskId: string): Unsubscribe {
    const existing = this.subscriptions.get(taskId);
    if (existing) {
      existing.count += 1;
    } else {
      const unsubscribe = this.adapter.subscribe(taskId, (event) => {
        if (event.type === 'snapshot') this.acceptSnapshot(event.snapshot);
        else this.setState({ connection: event.state });
      });
      this.subscriptions.set(taskId, { count: 1, unsubscribe });
      void this.refreshTask(taskId);
    }
    return () => {
      const current = this.subscriptions.get(taskId);
      if (!current) return;
      current.count -= 1;
      if (current.count <= 0) {
        current.unsubscribe();
        this.subscriptions.delete(taskId);
      }
    };
  }

  async refreshTask(taskId: string): Promise<void> {
    const previous = this.entry(taskId);
    this.patchEntry(taskId, { status: 'loading', error: null, snapshot: previous.snapshot });
    try {
      const snapshot = await this.adapter.getSnapshot(taskId);
      this.acceptSnapshot(snapshot);
    } catch (error) {
      this.patchEntry(taskId, { status: 'error', error: describe(error) });
    }
  }

  acceptSnapshot(raw: TaskSnapshot): void {
    const snapshot = this.options.validate ? TaskSnapshotSchema.parse(raw) : raw;
    this.patchEntry(snapshot.task.taskId, { status: 'ready', snapshot, error: null });
  }

  // 执行一个动作：成功则采用返回的快照；stepToken 过期时采用附带的最新快照并留下提示。
  async act(taskId: string, run: (adapter: AppAdapter) => Promise<ActionOutcome>): Promise<ActionOutcome> {
    const outcome = await run(this.adapter);
    if (outcome.ok) {
      this.acceptSnapshot(outcome.snapshot);
    } else if (outcome.snapshot) {
      this.acceptSnapshot(outcome.snapshot);
      if (outcome.error.code === STALE_STEP_CODE) this.patchEntry(taskId, { notice: STALE_STEP_NOTICE });
    }
    return outcome;
  }

  clearNotice(taskId: string): void {
    if (this.entry(taskId).notice) this.patchEntry(taskId, { notice: null });
  }

  private patchEntry(taskId: string, patch: Partial<TaskEntry>): void {
    const next: TaskEntry = { ...this.entry(taskId), ...patch };
    this.setState({ tasks: { ...this.state.tasks, [taskId]: next } });
  }

  private setState(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
