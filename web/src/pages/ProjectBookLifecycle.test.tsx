import { MOCK_ACCOUNT, MOCK_PASSWORD } from '../mock/auth';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

function lifecycleItem(number: string, label: string): HTMLElement {
  return within(screen.getByTestId(`book-row-${number}`)).getByRole('button', { name: label });
}

describe('project book lifecycle controls', () => {
  test('deactivates and restores a personal entry from the maintenance page', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');

    const row = screen.getByTestId('book-row-P-2307');
    expect(within(row).getAllByRole('button')).toHaveLength(3);
    expect(within(row).getByRole('button', { name: '编辑 P-2307' })).toBeTruthy();
    fireEvent.click(lifecycleItem('P-2307', '停用项目 P-2307'));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('已停用');
    const restore = lifecycleItem('P-2307', '恢复项目 P-2307');
    expect(restore).toBeTruthy();

    fireEvent.click(restore);
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('可选');
    expect(lifecycleItem('P-2307', '停用项目 P-2307')).toBeTruthy();
  });

  test('updates mock assignment availability without discarding a draft permanently', async () => {
    const adapter = createMockAdapter({ seed: 'project', fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    const before = await adapter.getSnapshot('T1');
    expect(before.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);

    expect(await adapter.deactivateProject({ number: 'P-2307' })).toMatchObject({ ok: true, result: { status: 'deactivated' } });
    const inactive = await adapter.getSnapshot('T1');
    expect(inactive.projectAssignment.projects.some((entry) => entry.number === 'P-2307')).toBe(false);
    expect(inactive.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(false);
    expect(inactive.projectAssignment.reselect.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);

    expect(await adapter.restoreProject({ number: 'P-2307' })).toMatchObject({ ok: true, result: { status: 'restored' } });
    const restored = await adapter.getSnapshot('T1');
    expect(restored.projectAssignment.projects.some((entry) => entry.number === 'P-2307')).toBe(true);
    expect(restored.projectAssignment.working.some((entry) => entry.projectNumber === 'P-2307')).toBe(true);
  });

  test('keeps the member public view read-only while the administrator can deactivate and restore a public entry', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
    await adapter.intakePublicProject({ number: 'PUBLIC-LIFE', name: '公共生命周期项目' });
    await adapter.register({ username: 'book-member', password: 'member-password' });
    await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD });
    const memberAccount = (await adapter.listAccounts()).accounts.find((account) => account.username === 'book-member')!;
    await adapter.updateAccount(memberAccount.accountId, { approved: true });
    await adapter.login({ username: 'book-member', password: 'member-password' });
    window.location.hash = '#/projects';
    render(<App adapter={adapter} />);

    fireEvent.click(await screen.findByRole('button', { name: '公共项目簿' }));
    const publicTable = await screen.findByRole('table', { name: '公共项目簿' });
    expect(within(publicTable).getByTestId('book-row-PUBLIC-LIFE')).toBeTruthy();
    expect(within(publicTable).queryByRole('button')).toBeNull();

    window.location.hash = '#/projects';
    cleanup();
    await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD });
    render(<App adapter={adapter} />);
    await screen.findByRole('heading', { name: '个人项目簿', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: '公共项目簿' }));
    expect(await screen.findByTestId('book-row-PUBLIC-LIFE')).toBeTruthy();

    expect(within(screen.getByTestId('book-row-PUBLIC-LIFE')).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(lifecycleItem('PUBLIC-LIFE', '停用项目 PUBLIC-LIFE'));
    expect((await screen.findByTestId('book-message')).textContent).toContain('已停用');
    const restore = lifecycleItem('PUBLIC-LIFE', '恢复项目 PUBLIC-LIFE');
    expect(restore).toBeTruthy();

    fireEvent.click(restore);
    expect((await screen.findByTestId('book-message')).textContent).toContain('已恢复');
    expect(lifecycleItem('PUBLIC-LIFE', '停用项目 PUBLIC-LIFE')).toBeTruthy();
  });
});


test.each([true, false])('personal deletion confirms or cancels for active=%s', async (active) => {
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  if (!active) await adapter.deactivateProject({ number: 'P-2307' });
  window.location.hash = '#/projects';
  render(<App adapter={adapter} />);
  await screen.findByTestId('book-row-P-2307');
  fireEvent.click(lifecycleItem('P-2307', '删除项目 P-2307'));
  let dialog = screen.getByRole('dialog', { name: '删除个人项目' });
  expect(dialog.textContent).toContain('已有报销记录保持不变');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.getByTestId('book-row-P-2307')).toBeTruthy();
  fireEvent.click(lifecycleItem('P-2307', '删除项目 P-2307'));
  dialog = screen.getByRole('dialog', { name: '删除个人项目' });
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(screen.queryByTestId('book-row-P-2307')).toBeNull());
  expect(screen.queryByRole('dialog', { name: '删除个人项目' })).toBeNull();
  expect(screen.getByTestId('book-message').textContent).toContain('已从个人项目簿删除');
});


test('failed deletion keeps the project and dialog available for retry', async () => {
  const adapter = renderApp('#/projects');
  await screen.findByTestId('book-row-P-2307');
  vi.spyOn(adapter, 'deleteProject').mockResolvedValueOnce({ ok: false, error: { code: 'network_error', message: '连接失败，请重试。' }, book: null });
  fireEvent.click(lifecycleItem('P-2307', '删除项目 P-2307'));
  const dialog = screen.getByRole('dialog', { name: '删除个人项目' });
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  expect((await within(dialog).findByRole('alert')).textContent).toContain('连接失败');
  expect(screen.getByTestId('book-row-P-2307')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(screen.queryByTestId('book-row-P-2307')).toBeNull());
});

test.each([true, false])('public deletion confirms or cancels for active=%s', async (active) => {
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  await adapter.intakePublicProject({ number: 'PUBLIC-DELETE', name: '待删除公共项目' });
  if (!active) await adapter.deactivatePublicProject({ number: 'PUBLIC-DELETE' });
  window.location.hash = '#/projects';
  render(<App adapter={adapter} />);
  fireEvent.click(await screen.findByRole('button', { name: '公共项目簿' }));
  const row = await screen.findByTestId('book-row-PUBLIC-DELETE');
  expect(within(row).getAllByRole('button')).toHaveLength(3);
  fireEvent.click(lifecycleItem('PUBLIC-DELETE', '删除项目 PUBLIC-DELETE'));
  let dialog = screen.getByRole('dialog', { name: '删除公共项目' });
  expect(dialog.textContent).toContain('所有成员将无法再选择该公共项目');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.getByTestId('book-row-PUBLIC-DELETE')).toBeTruthy();
  fireEvent.click(lifecycleItem('PUBLIC-DELETE', '删除项目 PUBLIC-DELETE'));
  dialog = screen.getByRole('dialog', { name: '删除公共项目' });
  fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(screen.queryByTestId('book-row-PUBLIC-DELETE')).toBeNull());
  expect(await adapter.getPublicProjectBook()).toEqual({ projects: [] });
  expect(await adapter.intakeProject({ number: 'PUBLIC-DELETE', name: '释放后的个人项目' })).toMatchObject({ ok: true, result: { status: 'admitted' } });
});
