import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { SILENT_LOCAL_EXECUTOR_PORT, type LocalExecutorPort } from './local-executor-port';
import type { AccountsState, AppState, AppStore, BookScope, PairingState, LegacyImportState, ProjectBookState, SessionState, TaskEntry, TaskListState } from './store';

// 适配器经 React Context 注入：页面只认 useAppStore()，换适配器不改页面。

const StoreContext = createContext<AppStore | null>(null);
// The 本地执行器 on this PC (its loopback port 47319) is injected the same way; without one, nothing ever answers.
const LocalExecutorContext = createContext<LocalExecutorPort>(SILENT_LOCAL_EXECUTOR_PORT);

export function AppProvider({ store, localExecutor = SILENT_LOCAL_EXECUTOR_PORT, children }: { store: AppStore; localExecutor?: LocalExecutorPort; children: ReactNode }) {
  return (
    <StoreContext.Provider value={store}>
      <LocalExecutorContext.Provider value={localExecutor}>{children}</LocalExecutorContext.Provider>
    </StoreContext.Provider>
  );
}

export function useLocalExecutorPort(): LocalExecutorPort {
  return useContext(LocalExecutorContext);
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStore 必须在 AppProvider 内使用');
  return store;
}

export function useAppState(): AppState {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// 应用账号的会话：第一次用到时读取；之后由账号动作的结果替换，401 时重读。
export function useSession(): SessionState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.session.status === 'idle') void store.loadSession();
  }, [store, state.session.status]);
  return state.session;
}

export function useTaskList(): TaskListState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.taskList.status === 'idle') void store.loadTaskList();
  }, [store, state.taskList.status]);
  return state.taskList;
}

// 项目簿（个人或公共）：第一次用到时读取；之后由维护动作的结果替换。
export function useBook(scope: BookScope): ProjectBookState {
  const store = useAppStore();
  const state = useAppState();
  const book = scope === 'public' ? state.publicBook : state.projectBook;
  useEffect(() => {
    if (book.status === 'idle') void (scope === 'public' ? store.loadPublicBook() : store.loadProjectBook());
  }, [store, scope, book.status]);
  return book;
}

// 管理员页的账号列表：第一次用到时读取。
export function useAccounts(): AccountsState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.accounts.status === 'idle') void store.loadAccounts();
  }, [store, state.accounts.status]);
  return state.accounts;
}

// 设置页的旧数据导入结果：第一次用到时读取；之后由重试 / 跳过的结果替换。
export function useLegacyImport(): LegacyImportState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.legacyImport.status === 'idle') void store.loadLegacyImport();
  }, [store, state.legacyImport.status]);
  return state.legacyImport;
}

export function usePairing(): PairingState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.pairing.status === 'idle') void store.loadPairing();
  }, [store, state.pairing.status]);
  return state.pairing;
}

export function useTask(taskId: string): TaskEntry {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => store.openTask(taskId), [store, taskId]);
  return state.tasks[taskId] ?? { status: 'idle', snapshot: null, error: null, notice: null };
}
