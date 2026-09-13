import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string, seed: Parameters<typeof createMockAdapter>[0]['seed'] = null) {
  window.location.hash = hash;
  return render(<App adapter={createMockAdapter({ seed, fault: null })} />);
}

const stepButton = (stages: HTMLElement, label: string) => within(stages).getByRole('button', { name: new RegExp(`^${label}`) });

describe('任务步骤条', () => {
  test('在工作区顶部：任务名与步骤列表，不重复 10 阶段名、个人项目簿入口与规则说明；没有侧栏和收起按钮', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const bar = await screen.findByRole('region', { name: '任务进度' });
    expect(bar.parentElement?.tagName).toBe('MAIN');
    expect(within(bar).getByRole('list', { name: '流程阶段' })).toBeTruthy();
    expect(within(bar).getByTitle('2026-08 上海出差（产品评审）')).toBeTruthy();
    expect(bar.textContent).not.toContain('/10');
    expect(bar.textContent).not.toContain('个人项目簿');
    expect(bar.textContent).not.toContain('规则');
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('button', { name: /侧栏/ })).toBeNull();
  });

  test('已完成的步骤可点、读屏状态是「已完成」；当前步骤 aria-current=step；未到的步骤 aria-disabled、状态「未开放」；状态文字是中文', async () => {
    renderApp('#/task/T1/review', 'review');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    const current = stepButton(stages, '整单明细确认');
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.textContent).toContain('当前');
    const locked = stepButton(stages, '去打印 / 去报销');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(locked.textContent).toContain('未开放');
    expect(stepButton(stages, '完成').getAttribute('aria-disabled')).toBe('true');
    expect(stages.textContent).not.toMatch(/Complete|Current|Incomplete|Invalid/);

    const done = stepButton(stages, '上传材料');
    expect(done.textContent).toContain('已完成');
    expect(done.getAttribute('aria-current')).toBeNull();
    expect(done.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(done);
    expect(window.location.hash).toBe('#/task/T1/upload');
  });

  test('盘点后待确认项旁边是待处理数量', async () => {
    renderApp('#/task/T1/inventory', 'inventory');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    expect(within(stages).getByText('3 项待处理')).toBeTruthy();
  });

  test('点未到的步骤在步骤条里给出一次说明，不跳页', async () => {
    renderApp('#/task/T1/review', 'review');
    const stages = await screen.findByRole('list', { name: '流程阶段' });
    const locked = stepButton(stages, '去打印 / 去报销');
    expect(screen.queryByText('阶段不可跳过，请按顺序完成。')).toBeNull();
    fireEvent.click(locked);
    const hint = screen.getByText('阶段不可跳过，请按顺序完成。');
    expect(hint.getAttribute('role')).toBe('status');
    expect(screen.getByRole('region', { name: '任务进度' }).contains(hint)).toBe(true);
    expect(window.location.hash).toBe('#/task/T1/review');
  });

  test('被守卫拦下的页面不把对应步骤显示成当前；守卫页已说明不可跳过，点未到的步骤不再出提示', async () => {
    renderApp('#/task/T1/review', 'inventory');
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'step')).toHaveLength(0);
    const locked = stepButton(stages, '整单明细确认');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(locked);
    expect(screen.queryByText('阶段不可跳过，请按顺序完成。')).toBeNull();
    expect(window.location.hash).toBe('#/task/T1/review');
  });

  test('非任务页面没有步骤条', async () => {
    renderApp('#/tasks');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '流程阶段' })).toBeNull();
    expect(screen.queryByRole('region', { name: '任务进度' })).toBeNull();
  });
});
