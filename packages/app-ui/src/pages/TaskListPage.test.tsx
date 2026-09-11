import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';

function renderApp(hash: string, seed: Parameters<typeof createMockAdapter>[0]['seed'] = null) {
  window.location.hash = hash;
  return render(<App adapter={createMockAdapter({ seed, fault: null })} />);
}

async function rowOf(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  const row = cell.closest('tr');
  if (!row) throw new Error(`${name} 不在表格行里`);
  return row;
}

describe('任务列表', () => {
  test('显示三个任务及其阶段徽标：进行中、对账中、已完成', async () => {
    renderApp('#/tasks');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();

    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('上传材料')).toBeTruthy();
    expect(within(t1).getByText('未确认')).toBeTruthy();
    expect(within(t1).getByRole('link', { name: '继续 →' }).getAttribute('href')).toBe('#/task/T1/upload');

    const t2 = await rowOf('2026-07 深圳客户拜访');
    expect(within(t2).getByText('对账中')).toBeTruthy();
    expect(within(t2).getByText('1264.00')).toBeTruthy();
    expect(within(t2).getByRole('link', { name: '查看对账 →' }).getAttribute('href')).toBe('#/task/T2/reconcile');

    const t3 = await rowOf('2026-06 北京培训');
    expect(within(t3).getByText('已完成')).toBeTruthy();
    expect(within(t3).getByText('BX20260702-0088')).toBeTruthy();

    expect(screen.getByRole('link', { name: '新建报销任务' }).getAttribute('href')).toBe('#/tasks/new');
    expect(screen.getByText('林颂宜 · 产品研发部')).toBeTruthy();
  });

  test('?seed=done 时 T1 显示已完成、价税合计与草稿号', async () => {
    renderApp('#/tasks', 'done');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('已完成')).toBeTruthy();
    expect(within(t1).getByText('3972.59')).toBeTruthy();
    expect(within(t1).getByText('BX20260911-0173')).toBeTruthy();
  });

  test('未知路径回到任务列表', async () => {
    renderApp('#/nowhere');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();
    expect(window.location.hash).toBe('#/tasks');
  });
});

describe('任务页面骨架', () => {
  test('打开任务页面时侧栏列出流程阶段，当前阶段高亮', async () => {
    renderApp('#/task/T1/upload');
    expect(await screen.findByRole('heading', { name: '上传材料' })).toBeTruthy();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).getAllByRole('listitem')).toHaveLength(6);
    expect(within(stages).getByText('上传材料').closest('a')?.getAttribute('aria-current')).toBe('step');
  });

  test('还没有上传材料时不能进入后续页面', async () => {
    renderApp('#/task/T1/review');
    expect(await screen.findByRole('heading', { name: '还没有上传材料' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '去上传' }).getAttribute('href')).toBe('#/task/T1/upload');
  });

  test('阶段不可跳过', async () => {
    renderApp('#/task/T1/print', 'inventory');
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
  });

  test('对账中的任务侧栏显示状态而不是阶段列表', async () => {
    renderApp('#/task/T2/reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '流程阶段' })).toBeNull();
    expect(screen.getByText('写入结果不确定后停在这里。处置只有原地等待或转人工。')).toBeTruthy();
  });
});
