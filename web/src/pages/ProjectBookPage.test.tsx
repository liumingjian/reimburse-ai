import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import type { TaskStage } from '@baox/contract';
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
// 项目归属页右侧的「归入项目」面板：每个项目是一个按钮。
const panel = () => screen.getByRole('complementary', { name: '归入项目' });
const panelProject = (number: string) => within(panel()).queryByRole('button', { name: new RegExp(number) }) as HTMLButtonElement | null;
const bookRows = () => within(screen.getByRole('table', { name: '个人项目簿' })).queryAllByTestId(/^book-row-/);

describe('个人项目簿 #/projects', () => {
  test('表头、状态标签与说明来自服务端；过期时间为空显示永不过期', async () => {
    renderApp('#/projects');
    expect(await screen.findByRole('heading', { name: '个人项目簿', level: 1 })).toBeTruthy();
    expect(screen.getByText('项目号从报销系统核验后加入你这个账号的项目簿。失效项目仍会保留，直到你删除它。')).toBeTruthy();
    const table = screen.getByRole('table', { name: '个人项目簿' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['项目号', '名称', '过期时间', '状态', '']);
    await screen.findByTestId('book-row-P-2307');
    expect(bookRows()).toHaveLength(6);
    expect(screen.getByTestId('book-row-P-2307').textContent).toContain('永不过期');
    // 状态说明照内核 annotateProjects 原样显示（含「已过期（过期时间 …）」），页面不过滤服务端文字。
    expect(screen.getByTestId('book-row-P-4420').textContent).toContain('已过期（过期时间 2026-08-31）');
    expect(numberInput().placeholder).toBe('如：P-2307');
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

  test('顶栏常驻入口', async () => {
    renderApp('#/tasks');
    const nav = await screen.findByRole('navigation', { name: '全局' });
    expect(within(nav).getByRole('link', { name: '个人项目簿' }).getAttribute('href')).toBe('#/projects');
  });
});

describe('项目归属的项目簿门', () => {
  test('?book=empty：录入一个后不自动离开，可以继续录第二个；点「项目录完了，开始归属」才进入工作台，两个项目都可选', async () => {
    renderApp('#/task/T1/project', { bookEmpty: true }, 'project');
    expect(await screen.findByRole('heading', { name: '先维护个人项目簿' })).toBeTruthy();
    expect(await screen.findByText('当前项目簿为空，请录入第一个项目。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认项目归属' })).toBeNull();
    const continueButton = () => screen.getByRole('button', { name: '项目录完了，开始归属' }) as HTMLButtonElement;
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText('至少录入一个可用项目后才能开始归属')).toBeTruthy();

    intake('P-5108');
    expect(await screen.findByTestId('book-row-P-5108')).toBeTruthy();
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    // 仍在维护门：项目簿面板还在，工作台没出现。
    expect(screen.getByRole('heading', { name: '先维护个人项目簿' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: '归入项目' })).toBeNull();
    expect(screen.queryByText('至少录入一个可用项目后才能开始归属')).toBeNull();

    intake('P-6021');
    expect(await screen.findByTestId('book-row-P-6021')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '先维护个人项目簿' })).toBeTruthy();

    fireEvent.click(continueButton());
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    // 夹具预置的 No.1-2 归属（P-2307）照内核保留，项目簿门只看「没提交过、项目簿没有可选项目」；这里挑一条未归属的。
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.3' }));
    expect(panelProject('P-6021')).toBeTruthy();
    fireEvent.click(panelProject('P-5108')!);
    expect(await screen.findByText((_, node) => node?.getAttribute('data-testid') === 'project-of-3' && node.textContent === 'P-5108 / 苏州门店巡检')).toBeTruthy();
  });

  test('项目簿已有项目时直接打开工作台；面板里点「新增项目」录入，关掉后勾选保持、新项目出现在面板里可直接归入', async () => {
    renderApp('#/task/T1/project', {}, 'project');
    await screen.findByRole('heading', { name: '项目归属' });
    expect(screen.queryByRole('link', { name: '去维护项目簿' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.3' }));
    expect(panelProject('P-6021')).toBeNull();

    fireEvent.click(within(panel()).getByRole('button', { name: '新增项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新增项目' });
    fireEvent.change(within(dialog).getByLabelText('项目号'), { target: { value: 'P-6021' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '核验并加入' }));
    expect(await within(dialog).findByTestId('book-row-P-6021')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));

    // 关掉弹层：新项目出现在面板里，勾选的明细还在。
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(panelProject('P-6021')).toBeTruthy());
    expect(within(panel()).getByText('已选 1 条')).toBeTruthy();
    fireEvent.click(panelProject('P-6021')!);
    await waitFor(() => expect(screen.getByTestId('project-of-3').textContent).toBe('P-6021 / 年度预算评审'));
  });

  test('顶栏有常驻「个人项目簿」入口（步骤条不重复）', async () => {
    renderApp('#/task/T1/project', {}, 'project');
    await screen.findByRole('heading', { name: '项目归属' });
    expect(within(screen.getByRole('navigation', { name: '全局' })).getByRole('link', { name: '个人项目簿' }).getAttribute('href')).toBe('#/projects');
    expect(screen.queryByRole('link', { name: '维护个人项目簿' })).toBeNull();
  });
});
