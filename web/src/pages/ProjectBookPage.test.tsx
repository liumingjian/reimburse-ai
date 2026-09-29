import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import type { SeedStage } from '../mock/options';
import { MOCK_ACCOUNT, MOCK_PASSWORD } from '../mock/auth';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';

type Extra = Omit<MockOptions, 'seed' | 'fault'>;

function renderApp(hash: string, extra: Extra = {}, seed: SeedStage | null = null) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, ...extra });
  render(<App adapter={adapter} />);
  return adapter;
}

const numberInput = (scope: ReturnType<typeof within> = screen) => scope.getByLabelText('项目号') as HTMLInputElement;
const nameInput = (scope: ReturnType<typeof within> = screen) => scope.getByLabelText('项目名称') as HTMLInputElement;
const intakeButton = (scope: ReturnType<typeof within> = screen) => scope.getByRole('button', { name: '加入项目' }) as HTMLButtonElement;
const intake = (number: string, name: string, scope: ReturnType<typeof within> = screen) => {
  fireEvent.change(numberInput(scope), { target: { value: number } });
  fireEvent.change(nameInput(scope), { target: { value: name } });
  fireEvent.click(intakeButton(scope));
};
const message = () => screen.findByTestId('book-message');
const panel = () => screen.getByRole('complementary', { name: '归入项目' });
const panelProject = (number: string) => within(panel()).queryByRole('button', { name: new RegExp(number) }) as HTMLButtonElement | null;
const personalTable = () => screen.getByRole('table', { name: '个人项目簿' });
const publicTable = () => screen.getByRole('table', { name: '公共项目簿' });
const bookRows = () => within(personalTable()).queryAllByTestId(/^book-row-/);

describe('项目簿 #/projects', () => {
  test('separates personal and public project work from account administration', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 5 });
    // Initialize the seeded personal book before asserting the public collision.
    await adapter.getProjectBook();
    const collision = await adapter.intakePublicProject({ number: 'P-2307', name: '不应公开' });
    expect(collision).toMatchObject({ ok: true, result: { status: 'conversion_required', note: '项目号 P-2307 已记录在个人项目簿中。确认后，所有同号个人项目将转为公共项目；已有报销记录保持不变。' } });
    await adapter.intakePublicProject({ number: 'PUB-100', name: '全员共享项目' });
    window.location.hash = '#/projects';
    render(<App adapter={adapter} />);

    expect(await screen.findByRole('heading', { name: '个人项目簿', level: 1 })).toBeTruthy();
    expect(document.title).toBe('baox · 项目簿');
    expect(screen.getByText('录入项目号和项目名称后，可在新的项目归属中选择。提交去报销前仍会核对项目。')).toBeTruthy();
    expect(within(personalTable()).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['项目号', '名称', '截止日期', '状态', '']);
    expect(screen.queryByRole('table', { name: '公共项目簿' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '公共项目簿' }));
    await screen.findByRole('table', { name: '公共项目簿' });
    expect(screen.queryByRole('table', { name: '个人项目簿' })).toBeNull();
    expect(await within(publicTable()).findByTestId('book-row-PUB-100')).toBeTruthy();
    expect(within(publicTable()).getByText('全员共享项目')).toBeTruthy();
    expect(screen.queryByLabelText('公共项目号')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '个人项目簿' }));
    expect(bookRows()).toHaveLength(6);
    expect(within(personalTable()).getByTestId('book-row-P-4420').textContent).toContain('已过期');
  });

  test('adds an arbitrary safe local number with the entered name and clears both fields', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');
    expect(intakeButton().disabled).toBe(true);
    intake('  LOCAL-999 ', '  不在目录里的本地项目 ');
    expect((await message()).textContent).toBe('项目 LOCAL-999「不在目录里的本地项目」已加入个人项目簿，可用于新的项目归属。');
    const row = await screen.findByTestId('book-row-LOCAL-999');
    expect(row.textContent).toContain('不在目录里的本地项目');
    expect(row.textContent).toContain('可选');
    expect(numberInput().value).toBe('');
    expect(nameInput().value).toBe('');
  });

  test('rejects unsafe, duplicate, and incomplete entries without clearing either field', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');

    intake('P-12;', '本地项目');
    expect((await message()).textContent).toContain('不能安全使用的字符');
    expect(numberInput().value).toBe('P-12;');
    expect(nameInput().value).toBe('本地项目');

    intake('P-2307', '另一个名称');
    expect((await message()).textContent).toContain('未重复加入');
    expect(numberInput().value).toBe('P-2307');
    expect(nameInput().value).toBe('另一个名称');
  });

  test('keeps the global project-book entry', async () => {
    renderApp('#/tasks');
    const nav = await screen.findByRole('navigation', { name: '全局' });
    expect(within(nav).getByRole('link', { name: '项目簿' }).getAttribute('href')).toBe('#/projects');
  });

  test('keeps mock personal books isolated and rejects a public collision', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    expect((await adapter.register({ username: '另一位员工', password: 'new-password' })).ok).toBe(true);
    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);
    const pending = (await adapter.listAccounts()).accounts.find((account) => account.username === '另一位员工');
    if (!pending) throw new Error('pending account was not listed');
    expect((await adapter.updateAccount(pending.accountId, { approved: true })).ok).toBe(true);
    expect((await adapter.login({ username: '另一位员工', password: 'new-password' })).ok).toBe(true);
    expect(await adapter.getProjectBook()).toEqual({ projects: [] });
    expect((await adapter.intakeProject({ number: 'PERSONAL-ONLY', name: '另一位员工的项目' })).ok).toBe(true);

    await adapter.logout();
    expect((await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD })).ok).toBe(true);
    expect((await adapter.getProjectBook()).projects.some((project) => project.number === 'PERSONAL-ONLY')).toBe(false);
    expect(await adapter.intakePublicProject({ number: 'PERSONAL-ONLY', name: '不应公开' })).toMatchObject({
      ok: true,
      result: { status: 'conversion_required', note: '项目号 PERSONAL-ONLY 已记录在个人项目簿中。确认后，所有同号个人项目将转为公共项目；已有报销记录保持不变。' },
    });
  });
});

describe('项目归属的项目簿门', () => {
  test('a local entry opens the assignment workbench and remains selectable without an ERP catalog lookup', async () => {
    renderApp('#/task/T1/project', { bookEmpty: true }, 'project');
    expect(await screen.findByRole('heading', { name: '先维护个人项目簿' })).toBeTruthy();
    const continueButton = () => screen.getByRole('button', { name: '项目录完了，开始归属' }) as HTMLButtonElement;
    expect(continueButton().disabled).toBe(true);

    intake('LOCAL-5108', '现场巡检');
    expect(await screen.findByTestId('book-row-LOCAL-5108')).toBeTruthy();
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    intake('LOCAL-6021', '年度预算');
    expect(await screen.findByTestId('book-row-LOCAL-6021')).toBeTruthy();

    fireEvent.click(continueButton());
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.3' }));
    expect(panelProject('LOCAL-6021')).toBeTruthy();
    fireEvent.click(panelProject('LOCAL-5108')!);
    await waitFor(() => expect(screen.getByTestId('project-of-3').textContent).toBe('LOCAL-5108 / 现场巡检'));
  });

  test('the in-place add dialog keeps the selected line and offers the local entry immediately', async () => {
    renderApp('#/task/T1/project', {}, 'project');
    await screen.findByRole('heading', { name: '项目归属' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.3' }));

    fireEvent.click(within(panel()).getByRole('button', { name: '新增项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新增项目' });
    const scope = within(dialog);
    intake('LOCAL-6021', '年度预算', scope);
    expect(await scope.findByTestId('book-row-LOCAL-6021')).toBeTruthy();
    fireEvent.click(scope.getByRole('button', { name: '完成' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(panelProject('LOCAL-6021')).toBeTruthy());
    expect(within(panel()).getByText('已选 1 条')).toBeTruthy();
    fireEvent.click(panelProject('LOCAL-6021')!);
    await waitFor(() => expect(screen.getByTestId('project-of-3').textContent).toBe('LOCAL-6021 / 年度预算'));
  });
});

describe('公共项目簿管理员录入', () => {
  test('an administrator can add a public entry from the public book', async () => {
    renderApp('#/projects');
    expect(await screen.findByRole('heading', { name: '个人项目簿', level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '公共项目簿' }));
    intake('PUBLIC-ADMIN', '管理员录入的共享项目');
    expect(await screen.findByTestId('book-row-PUBLIC-ADMIN')).toBeTruthy();
    expect((await message()).textContent).toContain('已加入公共项目簿');
  });
});
