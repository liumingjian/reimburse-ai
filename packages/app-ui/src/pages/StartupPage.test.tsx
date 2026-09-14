import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type MockOptions, type MockStorage } from '../mock/mock-adapter';
import { STARTUP_COPY } from './StartupPage';

function memoryStorage(): MockStorage {
  const map = new Map<string, string>();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
}

function renderAt(hash: string, options: Partial<MockOptions> = {}) {
  window.location.hash = hash;
  return render(<App adapter={createMockAdapter({ seed: null, fault: null, ...options })} />);
}

const heading = (name: string) => screen.findByRole('heading', { name, level: 1 });

describe('启动页：登录与身份绑定', () => {
  test('?erp=logged-out：先提示登录；「我已登录」后进入身份确认表；确认后进入任务列表', async () => {
    renderAt('#/tasks', { erpLoggedOut: true });
    await heading(STARTUP_COPY.loginTitle);
    expect(screen.getByText(STARTUP_COPY.loginLead)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建报销任务' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: STARTUP_COPY.loggedIn }));
    await heading(STARTUP_COPY.identityTitle);
    // 身份是带标签的只读字段，不是表格，也没有输入框；说明用白话「用于确认是本人」，界面上不出现「判据」。
    expect(screen.queryByRole('table')).toBeNull();
    const fields = screen.getByLabelText('报销人身份');
    expect(screen.getByLabelText('姓名').textContent).toContain('林颂宜');
    expect(screen.getByLabelText('登录账号').textContent).toContain('linsongyi');
    expect(screen.getByLabelText('登录账号').textContent).toContain('用于确认是本人');
    expect(screen.getByLabelText('账套').textContent).toContain('示例科技集团本部');
    expect(fields.textContent).not.toContain('判据');
    expect(document.body.textContent).not.toContain('判据');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: STARTUP_COPY.confirm }));
    await heading('报销任务');
    expect(screen.getByRole('button', { name: '新建报销任务' })).toBeTruthy();
    expect(screen.getByText('林颂宜')).toBeTruthy();
  });

  test('?identity=unbound：确认后进入任务列表；同一存储再打开（刷新）不再询问', async () => {
    const storage = memoryStorage();
    const first = renderAt('#/tasks', { identity: 'unbound', storage });
    await heading(STARTUP_COPY.identityTitle);
    expect(screen.queryByText('林颂宜', { selector: '.topbar *' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: STARTUP_COPY.confirm }));
    await heading('报销任务');
    first.unmount();

    renderAt('#/tasks', { identity: 'unbound', storage });
    await heading('报销任务');
    expect(screen.queryByRole('heading', { name: STARTUP_COPY.identityTitle })).toBeNull();
  });

  test('?identity=mismatched：点「重新检测」向服务端重新读登录与身份，仍不一致就留在阻塞页', async () => {
    window.location.hash = '#/tasks';
    const adapter = createMockAdapter({ seed: null, fault: null, identity: 'mismatched' });
    const listTasks = vi.spyOn(adapter, 'listTasks');
    render(<App adapter={adapter} />);
    await heading(STARTUP_COPY.mismatchTitle);
    expect(document.body.textContent).not.toContain('判据');
    const before = listTasks.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: STARTUP_COPY.recheck }));
    await waitFor(() => expect(listTasks.mock.calls.length).toBe(before + 1));
    await heading(STARTUP_COPY.mismatchTitle);
    expect(screen.getByRole('button', { name: STARTUP_COPY.recheck })).toBeTruthy();
  });

  test('?identity=mismatched：整页阻塞，只有「重新检测」一个按钮；任务页与新建弹层的深链也进不去', async () => {
    for (const hash of ['#/tasks', '#/tasks/new', '#/task/T1/upload']) {
      const view = renderAt(hash, { identity: 'mismatched' });
      await heading(STARTUP_COPY.mismatchTitle);
      expect(screen.getByRole('alert').textContent).toContain(STARTUP_COPY.mismatchLead);
      expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual([STARTUP_COPY.recheck]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('heading', { name: '上传材料' })).toBeNull();
      expect(window.location.hash).toBe(hash);
      view.unmount();
    }
  });

  test('未登录时深链到任务页先显示登录提示；完成启动后原地进入该任务页', async () => {
    renderAt('#/task/T1/upload', { erpLoggedOut: true, identity: 'unbound' });
    await heading(STARTUP_COPY.loginTitle);
    expect(screen.queryByRole('heading', { name: '上传材料' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: STARTUP_COPY.loggedIn }));
    fireEvent.click(await screen.findByRole('button', { name: STARTUP_COPY.confirm }));
    await heading('上传材料');
    await waitFor(() => expect(window.location.hash).toBe('#/task/T1/upload'));
  });
});

describe('常驻城市按身份记住', () => {
  test('创建任务确认的城市写进持久存储；同一身份再打开（刷新）预填为上次确认', async () => {
    const storage = memoryStorage();
    const adapter = createMockAdapter({ seed: null, fault: null, storage });
    expect((await adapter.listTasks()).homeCity).toEqual({ value: '杭州', source: 'network' });
    expect((await adapter.createTask({ homeCity: '苏州' })).ok).toBe(true);

    const reopened = createMockAdapter({ seed: null, fault: null, storage });
    expect((await reopened.listTasks()).homeCity).toEqual({ value: '苏州', source: 'remembered' });
    expect((await createMockAdapter({ seed: null, fault: null, storage: memoryStorage() }).listTasks()).homeCity?.source).toBe('network');
  });

  test('启动没完成时服务端拒绝新建任务；登记时账号或账套对不上被拒绝', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, identity: 'unbound', storage: memoryStorage() });
    const list = await adapter.listTasks();
    expect(list.erpSession).toBe('logged_in');
    expect(list.employee?.binding).toBe('unbound');
    expect((await adapter.createTask({ homeCity: '杭州' })).ok).toBe(false);
    expect((await adapter.confirmIdentity({ account: 'someone-else', tenant: '示例科技集团本部' })).ok).toBe(false);
    const confirmed = await adapter.confirmIdentity({ account: 'linsongyi', tenant: '示例科技集团本部' });
    expect(confirmed.ok && confirmed.taskList.employee?.binding).toBe('bound');
    expect((await adapter.createTask({ homeCity: '杭州' })).ok).toBe(true);

    const loggedOut = await createMockAdapter({ seed: null, fault: null, erpLoggedOut: true, storage: memoryStorage() }).listTasks();
    expect(loggedOut.erpSession).toBe('not_logged_in');
    expect(loggedOut.employee).toBeNull();
  });
});
