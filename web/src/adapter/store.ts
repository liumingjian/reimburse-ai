import {
  AccountListSchema,
  type AccountList,
  type AccountListOutcome,
  PASSWORD_CHANGE_REQUIRED_CODE,
  STALE_STEP_CODE,
  STALE_STEP_NOTICE,
  UNAUTHENTICATED_CODE,
  isServiceUnavailable,
  isUnauthenticated,
  type ActionError,
  type ActionOutcome,
  type AppAdapter,
  type AuthOutcome,
  type ConnectionState,
  type ProjectBookOutcome,
  SessionSchema,
  type Session,
  type TaskListOutcome,
  type Unsubscribe,
  PairingViewSchema,
  type PairingView,
  type PairingChangeOutcome,
  LegacyImportSchema,
  type LegacyImport,
  type LegacyImportOutcome,
  ProjectBookSchema,
  type ProjectBook,
  TaskSnapshotSchema,
  type TaskSnapshot,
  TaskListSchema,
  type TaskList,
} from '@baox/contract';
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

// 个人项目簿：服务端给的整份项目簿，只在打开项目簿页面（或项目归属页的维护入口）时读取。
export type ProjectBookState = {
  readonly status: LoadStatus;
  readonly data: ProjectBook | null;
  readonly error: string | null;
};

// 项目簿的两本：个人项目簿（按账号）与公共项目簿（所有账号共用，管理员维护，#194）。
export type BookScope = 'personal' | 'public';

// 旧数据导入（ADR-0018）：只在打开设置页时读取；之后由重试 / 跳过的结果替换。
export type LegacyImportState = {
  readonly status: LoadStatus;
  readonly data: LegacyImport | null;
  readonly error: string | null;
};

// 配对 (pairing with the 本地执行器, ADR-0019, ADR-0037): read when the settings page opens; afterwards replaced by the result of
// issuing a 配对码 (pairing code) or revoking the pairing.
export type PairingState = {
  readonly status: LoadStatus;
  readonly data: PairingView | null;
  readonly error: string | null;
};

// 管理员页的账号列表：只在打开管理页时读取；之后由账号更新的结果替换。
export type AccountsState = {
  readonly status: LoadStatus;
  readonly data: AccountList | null;
  readonly error: string | null;
};

// 应用账号的会话：页面先看它决定显示创建管理员 / 登录，还是任务列表与任务页。
export type SessionState = {
  readonly status: LoadStatus;
  readonly data: Session | null;
  readonly error: string | null;
};

export type AppState = {
  readonly session: SessionState;
  readonly taskList: TaskListState;
  readonly projectBook: ProjectBookState;
  readonly publicBook: ProjectBookState;
  readonly accounts: AccountsState;
  readonly legacyImport: LegacyImportState;
  readonly pairing: PairingState;
  readonly tasks: Readonly<Record<string, TaskEntry>>;
  readonly connection: ConnectionState;
};

const EMPTY_ENTRY: TaskEntry = { status: 'idle', snapshot: null, error: null, notice: null };

const INITIAL_STATE: AppState = {
  session: { status: 'idle', data: null, error: null },
  taskList: { status: 'idle', data: null, error: null, offline: false },
  projectBook: { status: 'idle', data: null, error: null },
  publicBook: { status: 'idle', data: null, error: null },
  accounts: { status: 'idle', data: null, error: null },
  legacyImport: { status: 'idle', data: null, error: null },
  pairing: { status: 'idle', data: null, error: null },
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
  private readonly bookReadGeneration: Record<BookScope, number> = { personal: 0, public: 0 };
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

  async loadSession(): Promise<void> {
    const previous = this.state.session;
    this.setState({ session: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.getSession();
      const data = this.options.validate ? SessionSchema.parse(raw) : raw;
      this.acceptSession(data);
    } catch (error) {
      this.setState({ session: { status: 'error', data: this.state.session.data, error: describe(error) } });
    }
  }

  // 创建管理员、注册、登录、退出：结果里的会话直接替换当前会话。换了账号（或退出）就丢掉上一个账号的一切缓存。
  async auth(run: (adapter: AppAdapter) => Promise<AuthOutcome>): Promise<AuthOutcome> {
    let outcome: AuthOutcome;
    try {
      outcome = await run(this.adapter);
      if (outcome.ok && this.options.validate) SessionSchema.parse(outcome.session);
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) } };
    }
    if (outcome.ok) this.acceptSession(outcome.session);
    return outcome;
  }

  private acceptSession(data: Session): void {
    const before = this.state.session.data?.account?.accountId ?? null;
    const after = data.account?.accountId ?? null;
    if (before !== after) this.forgetAccountData();
    this.setState({ session: { status: 'ready', data, error: null } });
  }

  // 会话失效（401）：重读会话，门随之回到登录。
  private sessionLost(): void {
    if (this.state.session.status !== 'loading') void this.loadSession();
  }

  // 动作失败时的会话判读：读路径靠 UnauthenticatedError，动作路径拿到的是服务端的错误码。
  // 会话没了（401）或必须先改密码（403）都不是页内错误，照读路径同样重读会话，门随之回到登录 / 改密码。
  private checkSession(error: ActionError): void {
    if (error.code === UNAUTHENTICATED_CODE || error.code === PASSWORD_CHANGE_REQUIRED_CODE) this.sessionLost();
  }

  private forgetAccountData(): void {
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.invalidateBookRead('personal');
    this.invalidateBookRead('public');
    this.setState({ taskList: INITIAL_STATE.taskList, projectBook: INITIAL_STATE.projectBook, publicBook: INITIAL_STATE.publicBook, accounts: INITIAL_STATE.accounts, legacyImport: INITIAL_STATE.legacyImport, pairing: INITIAL_STATE.pairing, tasks: {} });
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
      if (isUnauthenticated(error)) {
        this.setState({ taskList: { status: 'error', data, error: describe(error), offline: false } });
        this.sessionLost();
        return;
      }
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

  // 返回整份任务列表的动作（作废、完全重置）：结果里带的任务列表直接替换当前列表。
  // 适配器抛错也按失败返回，原因交给页面就地显示。
  async taskListAction(run: (adapter: AppAdapter) => Promise<TaskListOutcome>): Promise<TaskListOutcome> {
    let outcome: TaskListOutcome;
    let data: TaskList | null;
    // 校验也放在 try 里：列表形状不对时按失败返回，调用方的 busy 照常复位，不会卡在「处理中」。
    try {
      outcome = await run(this.adapter);
      const raw = outcome.taskList;
      data = raw && this.options.validate ? TaskListSchema.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, taskList: null };
    }
    if (data) this.setState({ taskList: { status: 'ready', data, error: null, offline: false } });
    if (!outcome.ok) this.checkSession(outcome.error);
    return outcome;
  }

  // 作废一个任务：成功后除了换上新列表，还丢掉这个任务缓存的快照（深链接再打开会重新向服务端要，而不是显示旧数据）。
  async abandonTask(taskId: string): Promise<TaskListOutcome> {
    const outcome = await this.taskListAction((adapter) => adapter.abandonTask(taskId));
    if (outcome.ok) {
      const { [taskId]: _dropped, ...rest } = this.state.tasks;
      this.setState({ tasks: rest });
    }
    return outcome;
  }

  // 完全重置：成功后清掉所有缓存的任务快照与项目簿（项目簿回到未加载，下次打开时重读）。
  async resetAll(): Promise<TaskListOutcome> {
    const outcome = await this.taskListAction((adapter) => adapter.resetAll());
    if (outcome.ok) {
      this.invalidateBookRead('personal');
      this.setState({ tasks: {}, projectBook: { status: 'idle', data: null, error: null } });
    }
    return outcome;
  }

  async loadProjectBook(): Promise<void> {
    const generation = this.startBookRead('personal');
    const previous = this.state.projectBook;
    this.setState({ projectBook: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.getProjectBook();
      const data = this.options.validate ? ProjectBookSchema.parse(raw) : raw;
      if (!this.isCurrentBookRead('personal', generation)) return;
      this.setState({ projectBook: { status: 'ready', data, error: null } });
    } catch (error) {
      if (!this.isCurrentBookRead('personal', generation)) return;
      this.setState({ projectBook: { status: 'error', data: this.state.projectBook.data, error: describe(error) } });
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  async loadPublicBook(): Promise<void> {
    const generation = this.startBookRead('public');
    const previous = this.state.publicBook;
    this.setState({ publicBook: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.getPublicProjectBook();
      const data = this.options.validate ? ProjectBookSchema.parse(raw) : raw;
      if (!this.isCurrentBookRead('public', generation)) return;
      this.setState({ publicBook: { status: 'ready', data, error: null } });
    } catch (error) {
      if (!this.isCurrentBookRead('public', generation)) return;
      this.setState({ publicBook: { status: 'error', data: this.state.publicBook.data, error: describe(error) } });
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  async loadAccounts(): Promise<void> {
    const previous = this.state.accounts;
    this.setState({ accounts: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.listAccounts();
      const data = this.options.validate ? AccountListSchema.parse(raw) : raw;
      this.setState({ accounts: { status: 'ready', data, error: null } });
    } catch (error) {
      this.setState({ accounts: { status: 'error', data: this.state.accounts.data, error: describe(error) } });
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  // Only the settings page uses the pairing, so it is read the first time that page needs it.
  async loadPairing(): Promise<void> {
    const previous = this.state.pairing;
    this.setState({ pairing: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.getExtensionPairing();
      const data = this.options.validate ? PairingViewSchema.parse(raw) : raw;
      this.setState({ pairing: { status: 'ready', data, error: null } });
    } catch (error) {
      this.setState({ pairing: { status: 'error', data: this.state.pairing.data, error: describe(error) } });
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  // After the 本地执行器 redeemed a 配对码 (pairing code) on its own: reads the pairing again until the server sees it
  // connected, at most `polls` reads `intervalMs` apart. Redeeming returns before its channel is up, and the page has
  // no push for it.
  async awaitPairingConnected(polls = 10, intervalMs = 500): Promise<void> {
    for (let poll = 0; poll < polls; poll += 1) {
      if (poll > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      await this.loadPairing();
      if (this.state.pairing.data?.connected) return;
    }
  }

  // Issuing a 配对码 or revoking: the pairing in the result replaces the current one. A freshly issued code appears
  // in this result only; no later read carries it again.
  async pairingAction(run: (adapter: AppAdapter) => Promise<PairingChangeOutcome>): Promise<PairingChangeOutcome> {
    let outcome: PairingChangeOutcome;
    let data: PairingView | null;
    try {
      outcome = await run(this.adapter);
      const raw = outcome.pairing;
      data = raw && this.options.validate ? PairingViewSchema.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, pairing: null };
    }
    if (data) this.setState({ pairing: { status: 'ready', data, error: null } });
    if (!outcome.ok) this.checkSession(outcome.error);
    return outcome;
  }

  // 旧数据导入：只在设置页用到，第一次用到时读取。
  async loadLegacyImport(): Promise<void> {
    const previous = this.state.legacyImport;
    this.setState({ legacyImport: { status: 'loading', data: previous.data, error: null } });
    try {
      const raw = await this.adapter.getLegacyImport();
      const data = this.options.validate ? LegacyImportSchema.parse(raw) : raw;
      this.setState({ legacyImport: { status: 'ready', data, error: null } });
    } catch (error) {
      this.setState({ legacyImport: { status: 'error', data: this.state.legacyImport.data, error: describe(error) } });
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  // 重试 / 跳过旧数据导入：结果里的导入视图直接替换当前的。
  // 重试成功会导进任务、项目簿与常驻城市，所以已经加载过的任务列表与项目簿一并重读。
  async legacyImportAction(run: (adapter: AppAdapter) => Promise<LegacyImportOutcome>): Promise<LegacyImportOutcome> {
    let outcome: LegacyImportOutcome;
    let data: LegacyImport | null;
    try {
      outcome = await run(this.adapter);
      const raw = outcome.legacyImport;
      data = raw && this.options.validate ? LegacyImportSchema.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, legacyImport: null };
    }
    if (data) this.setState({ legacyImport: { status: 'ready', data, error: null } });
    if (!outcome.ok) {
      this.checkSession(outcome.error);
      return outcome;
    }
    if (this.state.taskList.status !== 'idle') void this.loadTaskList();
    if (this.state.projectBook.status !== 'idle') void this.loadProjectBook();
    return outcome;
  }

  // 账号更新（管理员）：结果里的账号列表（或失败时附带的列表）直接替换当前列表。改的是自己的角色时重读会话。
  async accountAction(run: (adapter: AppAdapter) => Promise<AccountListOutcome>): Promise<AccountListOutcome> {
    let outcome: AccountListOutcome;
    let data: AccountList | null;
    try {
      outcome = await run(this.adapter);
      const raw = outcome.accountList;
      data = raw && this.options.validate ? AccountListSchema.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, accountList: null };
    }
    if (data) this.setState({ accounts: { status: 'ready', data, error: null } });
    if (!outcome.ok) this.checkSession(outcome.error);
    const me = this.state.session.data?.account;
    const mine = me && data?.accounts.find((account) => account.accountId === me.accountId);
    if (mine && mine.role !== me.role) void this.loadSession();
    return outcome;
  }

  // 项目簿维护动作：结果里的项目簿（或失败时附带的项目簿）直接替换那一本。适配器抛错也按失败返回。
  async projectBookAction(run: (adapter: AppAdapter) => Promise<ProjectBookOutcome>, scope: BookScope = 'personal'): Promise<ProjectBookOutcome> {
    let outcome: ProjectBookOutcome;
    let data: ProjectBook | null | undefined;
    try {
      outcome = await run(this.adapter);
      const raw = outcome.ok ? outcome.result.book : outcome.book;
      data = raw && this.options.validate ? ProjectBookSchema.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: { code: 'adapter_error', message: describe(error) }, book: null };
    }
    if (data) {
      this.invalidateBookRead(scope);
      this.setState(scope === 'public' ? { publicBook: { status: 'ready', data, error: null } } : { projectBook: { status: 'ready', data, error: null } });
    }
    // A public conversion removes the matching entry from the signed-in administrator's personal project book (个人项目簿).
    // Drop known-obsolete data before reloading so a failed read exposes a retry state instead of selectable old data.
    if (scope === 'public' && outcome.ok && outcome.result.status === 'converted' && this.state.projectBook.status !== 'idle') {
      this.invalidateBookRead('personal');
      this.setState({ projectBook: { status: 'idle', data: null, error: null } });
      await this.loadProjectBook();
    }
    if (!outcome.ok) this.checkSession(outcome.error);
    return outcome;
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
      if (isUnauthenticated(error)) this.sessionLost();
    }
  }

  acceptSnapshot(raw: TaskSnapshot): void {
    const snapshot = this.options.validate ? TaskSnapshotSchema.parse(raw) : raw;
    const current = this.entry(snapshot.task.taskId).snapshot;
    if (current && snapshot.revision < current.revision) {
      // The request completed successfully, but an SSE event already delivered a newer view. Keep that view while
      // resolving any loading or error state left by the older request.
      this.patchEntry(snapshot.task.taskId, { status: 'ready', error: null });
      return;
    }
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
    this.checkSession(outcome.error);
    if (outcome.error.code === STALE_STEP_CODE) {
      this.patchEntry(taskId, { notice: STALE_STEP_NOTICE });
      if (!outcome.snapshot) void this.refreshTask(taskId);
    }
    return outcome;
  }

  private resync(): void {
    for (const taskId of this.subscriptions.keys()) void this.refreshTask(taskId);
    if (this.state.taskList.status !== 'idle') void this.loadTaskList();
    if (this.state.projectBook.status !== 'idle') void this.loadProjectBook();
    if (this.state.publicBook.status !== 'idle') void this.loadPublicBook();
  }

  clearNotice(taskId: string): void {
    if (this.entry(taskId).notice) this.patchEntry(taskId, { notice: null });
  }

  private patchEntry(taskId: string, patch: Partial<TaskEntry>): void {
    const next: TaskEntry = { ...this.entry(taskId), ...patch };
    this.setState({ tasks: { ...this.state.tasks, [taskId]: next } });
  }

  private startBookRead(scope: BookScope): number {
    this.bookReadGeneration[scope] += 1;
    return this.bookReadGeneration[scope];
  }

  private invalidateBookRead(scope: BookScope): void {
    this.bookReadGeneration[scope] += 1;
  }

  private isCurrentBookRead(scope: BookScope, generation: number): boolean {
    return this.bookReadGeneration[scope] === generation;
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
