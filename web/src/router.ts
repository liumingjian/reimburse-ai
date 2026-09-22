import { useMemo, useSyncExternalStore } from 'react';
import { isTaskPage, type TaskPage } from '@baox/contract';

// hash 路由：`#/tasks`、`#/tasks/new`（任务列表上打开新建任务弹层）、`#/task/:id/<page>`；未知路径回到任务列表。
// 用 hash 是为了 file:// 与本地服务两种托管方式都不需要服务端改写。

export type Route =
  | { kind: 'tasks' }
  | { kind: 'new' }
  | { kind: 'projects' }
  | { kind: 'settings' }
  | { kind: 'password' }
  | { kind: 'settingsTutorial' }
  | { kind: 'admin' }
  | { kind: 'task'; taskId: string; page: TaskPage | null }
  | { kind: 'redirect'; to: string };

export const TASKS_HASH = '#/tasks';
export const NEW_TASK_HASH = '#/tasks/new';
// 个人项目簿：任务之外的全局页面，随时可进。
export const PROJECTS_HASH = '#/projects';
// 设置（完全重置）：全局页面。
export const SETTINGS_HASH = '#/settings';
export const SETTINGS_PASSWORD_HASH = '#/settings/password';
export const SETTINGS_TUTORIAL_HASH = '#/settings/tutorial';
// 管理（账号管理与公共项目簿）：只对管理员显示入口（#194）。
export const ADMIN_HASH = '#/admin';

export function taskHash(taskId: string, page: TaskPage): string {
  return `#/task/${encodeURIComponent(taskId)}/${page}`;
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const [head, second, third] = parts;
  if (head === 'tasks' && parts.length === 1) return { kind: 'tasks' };
  if (head === 'tasks' && second === 'new' && parts.length === 2) return { kind: 'new' };
  if (head === 'projects' && parts.length === 1) return { kind: 'projects' };
  if (head === 'settings' && parts.length === 1) return { kind: 'settings' };
  if (head === 'settings' && second === 'password' && parts.length === 2) return { kind: 'password' };
  if (head === 'settings' && second === 'tutorial' && parts.length === 2) return { kind: 'settingsTutorial' };
  if (head === 'admin' && parts.length === 1) return { kind: 'admin' };
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
