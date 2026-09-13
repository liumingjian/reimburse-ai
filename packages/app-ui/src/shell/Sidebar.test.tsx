import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string, seed: Parameters<typeof createMockAdapter>[0]['seed'] = null) {
  window.location.hash = hash;
  return render(<App adapter={createMockAdapter({ seed, fault: null })} />);
}

describe('任务侧栏', () => {
  test('只有任务名与步骤列表：不重复 10 阶段名、个人项目簿入口与规则说明', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    const sidebar = stages.closest('aside');
    if (!sidebar) throw new Error('步骤列表不在侧栏里');
    expect(within(sidebar).getByTitle('2026-08 上海出差（产品评审）')).toBeTruthy();
    expect(sidebar.textContent).not.toContain('/10');
    expect(sidebar.textContent).not.toContain('个人项目簿');
    expect(sidebar.textContent).not.toContain('规则');
  });

  test('收起按钮：aria-expanded 与名称随状态切换，收起后每步仍有可访问名称', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const collapse = await screen.findByRole('button', { name: '收起侧栏' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    const expand = screen.getByRole('button', { name: '展开侧栏' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).getByRole('link', { name: '材料盘点' }).getAttribute('aria-current')).toBe('step');
    expect(within(stages).getByRole('link', { name: '上传材料' }).getAttribute('href')).toBe('#/task/T1/upload');
    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: '收起侧栏' }).getAttribute('aria-expanded')).toBe('true');
  });

  test('被守卫拦下的页面不把对应步骤显示成当前；点未到的步骤给出一次说明', async () => {
    renderApp('#/task/T1/review', 'inventory');
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).queryByRole('link', { current: 'step' })).toBeNull();
    const locked = within(stages).getByText('整单明细确认').closest('button');
    if (!locked) throw new Error('未到的步骤应是按钮');
    expect(locked.className).not.toContain('current');
    expect(screen.queryByText('阶段不可跳过，请按顺序完成。')).toBeNull();
    fireEvent.click(locked);
    expect(screen.getByText('阶段不可跳过，请按顺序完成。').getAttribute('role')).toBe('status');
  });
});
