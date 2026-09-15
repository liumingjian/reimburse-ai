import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, AppStore, ProjectBookState, SessionState, TaskEntry, TaskListState } from './store';

// 适配器经 React Context 注入：页面只认 useAppStore()，换适配器不改页面。

const StoreContext = createContext<AppStore | null>(null);

export function AppProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
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

// 个人项目簿：第一次用到时读取；之后由维护动作的结果替换。
export function useProjectBook(): ProjectBookState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.projectBook.status === 'idle') void store.loadProjectBook();
  }, [store, state.projectBook.status]);
  return state.projectBook;
}

export function useTask(taskId: string): TaskEntry {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => store.openTask(taskId), [store, taskId]);
  return state.tasks[taskId] ?? { status: 'idle', snapshot: null, error: null, notice: null };
}
