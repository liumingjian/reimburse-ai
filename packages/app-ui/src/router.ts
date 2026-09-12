import { useMemo, useSyncExternalStore } from 'react';
import { isTaskPage, type TaskPage } from './contract/stage';

// hash 路由：`#/tasks`、`#/tasks/new`（任务列表上打开新建任务弹层）、`#/task/:id/<page>`；未知路径回到任务列表。
// 用 hash 是为了 file:// 与本地服务两种托管方式都不需要服务端改写。

export type Route =
  | { kind: 'tasks' }
  | { kind: 'new' }
  | { kind: 'task'; taskId: string; page: TaskPage | null }
  | { kind: 'redirect'; to: string };

export const TASKS_HASH = '#/tasks';
export const NEW_TASK_HASH = '#/tasks/new';

export function taskHash(taskId: string, page: TaskPage): string {
  return `#/task/${encodeURIComponent(taskId)}/${page}`;
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const [head, second, third] = parts;
  if (head === 'tasks' && parts.length === 1) return { kind: 'tasks' };
  if (head === 'tasks' && second === 'new' && parts.length === 2) return { kind: 'new' };
  if (head === 'task' && second && parts.length === 2) return { kind: 'task', taskId: second, page: null };
  if (head === 'task' && second && third && parts.length === 3 && isTaskPage(third)) {
    return { kind: 'task', taskId: second, page: third };
  }
  return { kind: 'redirect', to: TASKS_HASH };
}

export function navigate(to: string, replace = false): void {
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = to;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = to;
  }
}

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function readHash(): string {
  return window.location.hash;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => TASKS_HASH);
  return useMemo(() => parseHash(hash), [hash]);
}
