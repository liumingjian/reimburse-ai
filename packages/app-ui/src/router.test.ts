import { describe, expect, test } from 'vitest';
import { parseHash, taskHash } from './router';

describe('hash 路由', () => {
  test('#/tasks 是任务列表，#/tasks/new 是新建任务', () => {
    expect(parseHash('#/tasks')).toEqual({ kind: 'tasks' });
    expect(parseHash('#/tasks/new')).toEqual({ kind: 'new' });
  });

  test('#/task/:id/<页面> 解析出任务与页面；不带页面时页面为空', () => {
    expect(parseHash('#/task/T1/upload')).toEqual({ kind: 'task', taskId: 'T1', page: 'upload' });
    expect(parseHash('#/task/T2/reconcile')).toEqual({ kind: 'task', taskId: 'T2', page: 'reconcile' });
    expect(parseHash('#/task/T1')).toEqual({ kind: 'task', taskId: 'T1', page: null });
  });

  test('未知路径回到任务列表', () => {
    for (const hash of ['', '#/', '#/nowhere', '#/task', '#/task/T1/unknown', '#/tasks/new/extra', '#/design']) {
      expect(parseHash(hash), hash).toEqual({ kind: 'redirect', to: '#/tasks' });
    }
  });

  test('taskHash 与 parseHash 互逆', () => {
    expect(parseHash(taskHash('T1', 'print'))).toEqual({ kind: 'task', taskId: 'T1', page: 'print' });
  });
});
