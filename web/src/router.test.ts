import { describe, expect, test } from 'vitest';
import { parseHash, settingsHash, taskHash } from './router';

describe('hash 路由', () => {
  test('the public onboarding page has its own route', () => {
    expect(parseHash('#/onboarding')).toEqual({ kind: 'onboarding' });
    expect(parseHash('#/onboarding/extra')).toEqual({ kind: 'redirect', to: '#/tasks' });
  });
  test('the 设置页 opened from a task keeps only a valid local task destination', () => {
    expect(parseHash(settingsHash({ taskId: 'task with spaces', page: 'review' }))).toEqual({ kind: 'settings', returnTo: '#/task/task%20with%20spaces/review' });
    expect(parseHash(settingsHash())).toEqual({ kind: 'settings' });
    expect(parseHash('#/task/T1/review?extensionSetup=1')).toEqual({ kind: 'task', taskId: 'T1', page: 'review' });
    for (const returnTo of ['https://example.com', '//example.com', '#/admin', '#/task/T1/unknown', '#/task/%/review', '#/task/T1/review?next=elsewhere']) {
      expect(parseHash(`#/settings?${new URLSearchParams({ returnTo })}`)).toEqual({ kind: 'settings' });
    }
    expect(parseHash('#/task/%/review')).toEqual({ kind: 'redirect', to: '#/tasks' });
  });
  test('#/tasks 是任务列表，#/tasks/new 是任务列表上打开的新建任务弹层', () => {
    expect(parseHash('#/tasks')).toEqual({ kind: 'tasks' });
    expect(parseHash('#/tasks/new')).toEqual({ kind: 'new' });
  });

  test('设置页的密码修改使用独立路由；浏览器扩展的安装教程已经没有了', () => {
    expect(parseHash('#/settings')).toEqual({ kind: 'settings' });
    expect(parseHash('#/settings/password')).toEqual({ kind: 'password' });
    expect(parseHash('#/settings/tutorial')).toEqual({ kind: 'redirect', to: '#/tasks' });
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
