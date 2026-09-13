import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string, seed: Parameters<typeof createMockAdapter>[0]['seed'] = null) {
  window.location.hash = hash;
  return render(<App adapter={createMockAdapter({ seed, fault: null })} />);
}

describe('任务步骤条', () => {
  test('在工作面顶部：任务名与步骤列表，不重复 10 阶段名、个人项目簿入口与规则说明；没有侧栏和收起按钮', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    const bar = stages.closest('.stepbar');
    if (!(bar instanceof HTMLElement)) throw new Error('步骤列表不在步骤条里');
    expect(bar.parentElement?.tagName).toBe('MAIN');
    expect(within(bar).getByTitle('2026-08 上海出差（产品评审）')).toBeTruthy();
    expect(bar.textContent).not.toContain('/10');
    expect(bar.textContent).not.toContain('个人项目簿');
    expect(bar.textContent).not.toContain('规则');
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('button', { name: /侧栏/ })).toBeNull();
  });

  test('已完成的步骤是带勾的链接，当前步骤 aria-current=step，未到的步骤是 aria-disabled 按钮；序号不进可访问名称', async () => {
    renderApp('#/task/T1/review', 'review');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    const done = within(stages).getByRole('link', { name: '上传材料' });
    expect(done.getAttribute('href')).toBe('#/task/T1/upload');
    expect(done.querySelector('svg')).not.toBeNull();
    expect(done.getAttribute('aria-current')).toBeNull();
    const current = within(stages).getByRole('link', { name: '整单明细确认' });
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.querySelector('svg')).toBeNull();
    const locked = within(stages).getByRole('button', { name: '去打印 / 去报销' });
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(locked.querySelector('svg')).toBeNull();
    expect(within(stages).getByRole('button', { name: '完成' })).toBeTruthy();
  });

  test('盘点后待确认项旁边是待处理数量', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    expect(within(stages).getByText('3', { selector: '.count' })).toBeTruthy();
  });

  test('被守卫拦下的页面不把对应步骤显示成当前；点未到的步骤给出一次说明', async () => {
    renderApp('#/task/T1/review', 'inventory');
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).queryByRole('link', { current: 'step' })).toBeNull();
    const locked = within(stages).getByRole('button', { name: '整单明细确认' });
    expect(locked.className).not.toContain('current');
    expect(screen.queryByText('阶段不可跳过，请按顺序完成。')).toBeNull();
    fireEvent.click(locked);
    expect(screen.getByText('阶段不可跳过，请按顺序完成。').getAttribute('role')).toBe('status');
  });

  test('非任务页面没有步骤条', async () => {
    renderApp('#/tasks');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '流程阶段' })).toBeNull();
    expect(document.querySelector('.stepbar')).toBeNull();
  });
});
