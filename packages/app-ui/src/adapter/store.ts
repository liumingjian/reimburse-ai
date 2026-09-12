import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import { isServiceUnavailable, type ActionOutcome, type AppAdapter, type ConnectionState, type Unsubscribe } from '../contract/adapter';
import { TaskSnapshotSchema, type TaskSnapshot } from '../contract/snapshot';
import { TaskListSchema, type TaskList } from '../contract/task-list';
import { reconnectDelay } from './http-adapter';

// 快照仓库：唯一的前端状态容器，只保存服务端给的快照与加载/连接状态，供 useSyncExternalStore 订阅。
// 不派生业务事实；页面需要的每个数字与判断都来自快照本身。

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

export type TaskListState = {
  readonly status: LoadStatus;
  readonly data: TaskList | null;
  readonly error: string | null;
  // 最近一次加载遇到连接类失败（本地服务没有响应）：显示全页横幅，并按退避自动重试直到加载成功。
  readonly offline: boolean;
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
  taskList: { status: 'idle', data: null, error: null, offline: false },
  tasks: {},
  connection: 'connected',
};

export type StoreOptions = {
  // 开发与 mock 模式下每份快照都过 schema 校验，失败即抛出。
  validate: boolean;
  // 任务列表连接类失败后第 n 次重试前的等待（毫秒）；默认与事件流重连同一退避（0.5 s 起翻倍，封顶 10 s）。
  listRetryDelay?: (attempt: number) => number;
};

export class AppStore {
  private state: AppState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, { count: number; unsubscribe: Unsubscribe }>();
  private listRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private listRetryAttempt = 0;

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

  // 任务列表是请求/响应（没有事件流）。连接类失败时保留 offline 标记（全页横幅）并按退避自动重试；恢复后横幅消失、列表出现。
  async loadTaskList(): Promise<void> {
    const previous = this.state.taskList;
    if (previous.status === 'loading') return;
    if (this.listRetryTimer !== null) {
      clearTimeout(this.listRetryTimer);
      this.listRetryTimer = null;
    }
    this.setState({ taskList: { status: 'loading', data: previous.data, error: null, offline: previous.offline } });
    try {
      const raw = await this.adapter.listTasks();
      const data = this.options.validate ? TaskListSchema.parse(raw) : raw;
      this.listRetryAttempt = 0;
      this.setState({ taskList: { status: 'ready', data, error: null, offline: false } });
    } catch (error) {
      const data = this.state.taskList.data;
      if (!isServiceUnavailable(error)) {
        this.setState({ taskList: { status: 'error', data, error: describe(error), offline: false } });
        return;
      }
      // 状态记为 offline 而不是 loading：重试定时器到点前，loadTaskList 不会被 loading 挡住。
      this.setState({ taskList: { status: 'offline', data, error: null, offline: true } });
      const delay = (this.options.listRetryDelay ?? reconnectDelay)(this.listRetryAttempt);
      this.listRetryAttempt += 1;
      this.listRetryTimer = setTimeout(() => {
        this.listRetryTimer = null;
        void this.loadTaskList();
      }, delay);
    }
  }

  // 打开任务：拉取快照并订阅事件流；同一任务被多个组件打开时只订阅一次。返回关闭函数。
  openTask(taskId: string): Unsubscribe {
    const existing = this.subscriptions.get(taskId);
    if (existing) {
      existing.count += 1;
    } else {
      const unsubscribe = this.adapter.subscribe(taskId, (event) => {
        if (event.type === 'snapshot') {
          this.acceptSnapshot(event.snapshot);
          return;
        }
        const recovered = this.state.connection === 'disconnected' && event.state === 'connected';
        this.setState({ connection: event.state });
        // 断开期间可能错过了推送：恢复后重新拉取所有打开中的任务与已加载的任务列表。
        if (recovered) this.resync();
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

  // 执行一个动作：成功则采用返回的快照；stepToken 过期（409）时采用附带的最新快照（没带就重新拉取）并留下提示。
  // 适配器抛错也按失败返回，原因交给页面就地显示。
  async act(taskId: string, run: (adapter: AppAdapter) => Promise<ActionOutcome>): Promise<ActionOutcome> {
    let outcome: ActionOutcome;
    try {
      outcome = await run(this.adapter);
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, snapshot: null };
    }
    if (outcome.ok) {
      this.acceptSnapshot(outcome.snapshot);
      return outcome;
    }
    if (outcome.snapshot) this.acceptSnapshot(outcome.snapshot);
    if (outcome.error.code === STALE_STEP_CODE) {
      this.patchEntry(taskId, { notice: STALE_STEP_NOTICE });
      if (!outcome.snapshot) void this.refreshTask(taskId);
    }
    return outcome;
  }

  private resync(): void {
    for (const taskId of this.subscriptions.keys()) void this.refreshTask(taskId);
    if (this.state.taskList.status !== 'idle') void this.loadTaskList();
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
