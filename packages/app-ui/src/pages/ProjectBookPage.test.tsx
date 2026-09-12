import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';

type Extra = Omit<MockOptions, 'seed' | 'fault'>;

function renderApp(hash: string, extra: Extra = {}, seed: TaskStage | null = null) {
  window.location.hash = hash;
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs: 5, ...extra });
  render(<App adapter={adapter} />);
}

const numberInput = () => screen.getByLabelText('项目号') as HTMLInputElement;
const intakeButton = () => screen.getByRole('button', { name: '核验并加入' }) as HTMLButtonElement;
const intake = (value: string) => {
  fireEvent.change(numberInput(), { target: { value } });
  fireEvent.click(intakeButton());
};
const message = () => screen.findByTestId('book-message');
const bookRows = () => within(screen.getByRole('table', { name: '个人项目簿' })).queryAllByTestId(/^book-row-/);

describe('个人项目簿 #/projects', () => {
  test('表头、状态标签与说明来自服务端；过期时间为空显示永不过期', async () => {
    renderApp('#/projects');
    expect(await screen.findByRole('heading', { name: '个人项目簿', level: 1 })).toBeTruthy();
    expect(screen.getByText('项目号从报销系统核验后加入当前登录身份的项目簿。失效项目仍会保留，直到你删除它。')).toBeTruthy();
    const table = screen.getByRole('table', { name: '个人项目簿' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['项目号', '名称', '过期时间', '状态', '']);
    await screen.findByTestId('book-row-P-2307');
    expect(bookRows()).toHaveLength(6);
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('永不过期');
    expect(screen.getByTestId('book-row-P-4420').textContent).toContain('已过期（过期时间 2026-08-31）');
    expect(screen.getByTestId('book-row-P-0917').textContent).toContain('复检未通过');
  });

  test('录入可核验的项目号：出现在列表，名称来自核验结果；输入框清空', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');
    expect(intakeButton().disabled).toBe(true);
    intake('  P-5108 ');
    expect((await message()).textContent).toBe('项目 P-5108「苏州门店巡检」已加入个人项目簿，名称取自报销系统回读值；没有设置过期时间');
    const row = await screen.findByTestId('book-row-P-5108');
    expect(row.textContent).toContain('苏州门店巡检');
    expect(row.textContent).toContain('可选');
    expect(numberInput().value).toBe('');
  });

  test('核验不通过与非法字符：显示内核的拒绝文案，项目簿不变', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');
    intake('P-0000');
    expect((await message()).textContent).toBe('项目号 P-0000 在报销系统项目目录里查不到，没有加入个人项目簿；请核对后重新录入');
    intake('P-7700');
    expect((await screen.findByText(/对上了 2 条记录/)).textContent).toBe('项目号 P-7700 在报销系统里对上了 2 条记录，没有加入个人项目簿；请核实唯一项目号');
    intake('P-0917');
    expect((await screen.findByText(/不可引用/)).textContent).toBe('项目 P-0917「旧版对账工具」在报销系统里不可引用，没有加入个人项目簿');
    intake('P-12;');
    expect((await screen.findByText(/不能安全查询/)).textContent).toBe('项目号 "P-12;" 含有不能安全查询的字符，没有加入个人项目簿');
    expect(numberInput().value).toBe('P-12;');
    expect(bookRows()).toHaveLength(6);
  });

  test('复检全部、删除、清理全部失效：结果文案照内核', async () => {
    renderApp('#/projects');
    await screen.findByTestId('book-row-P-2307');
    fireEvent.click(screen.getByRole('button', { name: '复检全部' }));
    expect(await screen.findByText('复检了 6 条项目，其中 2 条当前不可选；复检不会自动删除项目')).toBeTruthy();
    expect(bookRows()).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: '删除 P-1180' }));
    expect(await screen.findByText('项目 P-1180「内部培训」已从个人项目簿删除；已选任务中的历史归属不受影响')).toBeTruthy();
    expect(screen.queryByTestId('book-row-P-1180')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清理全部失效' }));
    expect(await screen.findByText('已清理 2 条失效项目；合法历史任务中的项目归属不受影响')).toBeTruthy();
    expect(bookRows().map((row) => row.dataset.testid)).toEqual(['book-row-P-2307', 'book-row-P-2311', 'book-row-P-3312']);

    fireEvent.click(screen.getByRole('button', { name: '清理全部失效' }));
    expect(await screen.findByText('当前没有失效项目，一条都没删')).toBeTruthy();
  });

  test('?erp=logged-out 未完成登录：页面照常打开并说明原因；录入被拒并显示原因', async () => {
    renderApp('#/projects', { erpLoggedOut: true });
    expect(await screen.findByRole('heading', { name: '个人项目簿', level: 1 })).toBeTruthy();
    expect((await screen.findByRole('note')).textContent).toContain('还没有登录报销系统并确认报销人身份');
    expect(await screen.findByText('当前项目簿为空，请录入第一个项目。')).toBeTruthy();
    intake('P-5108');
    expect((await message()).textContent).toBe('没有已核对的报销系统身份，不能向个人项目簿录入项目');
    expect(screen.queryByTestId('book-row-P-5108')).toBeNull();
  });

  test('顶栏常驻入口', async () => {
    renderApp('#/tasks');
    const nav = await screen.findByRole('navigation', { name: '全局' });
    expect(within(nav).getByRole('link', { name: '个人项目簿' }).getAttribute('href')).toBe('#/projects');
  });
});

describe('项目归属的项目簿门', () => {
  test('?book=empty：项目归属页换成维护入口；录入一个后自动回到项目归属，并能选到这个项目', async () => {
    renderApp('#/task/T1/project', { bookEmpty: true }, 'project');
    expect(await screen.findByRole('heading', { name: '先维护个人项目簿' })).toBeTruthy();
    expect(await screen.findByText('当前项目簿为空，请录入第一个项目。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认项目归属' })).toBeNull();

    intake('P-5108');
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    const workbench = screen.getByRole('complementary', { name: '项目工作台' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.1' }));
    fireEvent.click(within(workbench).getByRole('button', { name: '归入 P-5108 苏州门店巡检' }));
    expect(await screen.findByText((_, node) => node?.getAttribute('data-testid') === 'project-of-1' && node.textContent === 'P-5108 · 苏州门店巡检')).toBeTruthy();
  });

  test('项目归属页有「去维护项目簿」链接，任务侧栏有常驻入口', async () => {
    renderApp('#/task/T1/project', {}, 'project');
    await screen.findByRole('heading', { name: '项目归属' });
    expect(screen.getByRole('link', { name: '去维护项目簿' }).getAttribute('href')).toBe('#/projects');
    expect(screen.getByRole('link', { name: '维护个人项目簿' }).getAttribute('href')).toBe('#/projects');
  });
});
