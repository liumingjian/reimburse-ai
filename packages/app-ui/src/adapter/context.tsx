import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, AppStore, TaskEntry, TaskListState } from './store';

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

export function useTaskList(): TaskListState {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => {
    if (state.taskList.status === 'idle') void store.loadTaskList();
  }, [store, state.taskList.status]);
  return state.taskList;
}

export function useTask(taskId: string): TaskEntry {
  const store = useAppStore();
  const state = useAppState();
  useEffect(() => store.openTask(taskId), [store, taskId]);
  return state.tasks[taskId] ?? { status: 'idle', snapshot: null, error: null, notice: null };
}
