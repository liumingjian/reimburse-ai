import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AUTH_ERRORS } from '@baox/contract';
import { App } from '../App';
import { MOCK_PASSWORD } from '../mock/auth';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';
import { AUTH_COPY } from './AuthPage';

function renderAt(hash: string, options: Partial<MockOptions> = {}) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, ...options });
  render(<App adapter={adapter} />);
  return adapter;
}

const heading = (name: string) => screen.findByRole('heading', { name, level: 1 });

function fill(username: string, password: string) {
  fireEvent.change(screen.getByLabelText(AUTH_COPY.username), { target: { value: username } });
  fireEvent.change(screen.getByLabelText(AUTH_COPY.password), { target: { value: password } });
}

describe('登录门：应用账号', () => {
  test('?auth=setup：只能创建管理员；创建后直接进入任务列表，顶栏是这个账号', async () => {
    renderAt('#/tasks', { auth: 'setup' });
    await heading(AUTH_COPY.setupTitle);
    expect(screen.queryByRole('button', { name: AUTH_COPY.toRegister })).toBeNull();
    expect(screen.queryByRole('navigation', { name: '全局' })).toBeNull();
    fill('管理员', 'short');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.setupSubmit }));
    expect(await screen.findByText(AUTH_ERRORS.passwordTooShort)).toBeTruthy();

    fill('管理员', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.setupSubmit }));
    await heading('报销任务');
    expect(screen.getByRole('banner').textContent).toContain('管理员');
  });

  test('?auth=signed-out：密码不对就地报错；登录后深链原地打开', async () => {
    renderAt('#/task/T1/upload', { auth: 'signed-out' });
    await heading(AUTH_COPY.loginTitle);
    fill('林颂宜', 'wrong password');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.loginSubmit }));
    expect(await screen.findByText(AUTH_ERRORS.invalidCredentials)).toBeTruthy();

    fill('林颂宜', MOCK_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.loginSubmit }));
    await heading('上传材料');
    expect(window.location.hash).toBe('#/task/T1/upload');
  });

  test('registration stays signed out until an administrator approves it, then the user can log in to an isolated task list', async () => {
    const adapter = renderAt('#/tasks', { auth: 'signed-out' });
    await heading(AUTH_COPY.loginTitle);
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.toRegister }));
    await heading(AUTH_COPY.registerTitle);
    fill('张三', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.registerSubmit }));
    await heading(AUTH_COPY.loginTitle);
    expect(await screen.findByText(AUTH_COPY.registrationPending)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull();

    fill('张三', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.loginSubmit }));
    expect(await screen.findByText(AUTH_ERRORS.pendingApproval)).toBeTruthy();

    const adminLogin = await adapter.login({ username: '林颂宜', password: MOCK_PASSWORD });
    expect(adminLogin.ok).toBe(true);
    const pending = (await adapter.listAccounts()).accounts.find((account) => account.username === '张三');
    if (!pending) throw new Error('pending account was not listed');
    expect((await adapter.updateAccount(pending.accountId, { approved: true })).ok).toBe(true);
    await adapter.logout();

    fill('张三', 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: AUTH_COPY.loginSubmit }));
    await heading('报销任务');
    expect(await screen.findByRole('heading', { name: '还没有报销任务' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await heading(AUTH_COPY.loginTitle);
    await waitFor(() => expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull());
  });
});
