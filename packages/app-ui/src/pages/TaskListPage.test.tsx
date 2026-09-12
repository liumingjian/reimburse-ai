import { render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
import { SERVICE_DOWN_NOTICE } from '../shell/AppShell';

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

    expect(screen.getByRole('button', { name: '新建报销任务' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('林颂宜 · 产品研发部')).toBeTruthy();
  });

  test('?seed=done 时 T1 显示已完成、价税合计与草稿号', async () => {
    renderApp('#/tasks', 'done');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('已完成')).toBeTruthy();
    expect(within(t1).getByText('3972.59')).toBeTruthy();
    expect(within(t1).getByText('BX20260911-0173')).toBeTruthy();
  });

  test('转人工的任务：徽标显示已转人工（服务端给出的列表字段），而不是对账中', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const t2 = await adapter.getSnapshot('T2');
    expect((await adapter.handOff('T2', t2.step.stepToken)).ok).toBe(true);
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const row = await rowOf('2026-07 深圳客户拜访');
    expect(within(row).getByText('已转人工').className).toContain('badge-warn');
    expect(within(row).queryByText('对账中')).toBeNull();
  });

  test('严格回读不一致停在完成页的任务：徽标显示回读不一致，并给出查看结果入口', async () => {
    const adapter = createMockAdapter({ seed: 'actions', fault: 'readback-mismatch', erpStepMs: 1, erpLoginAutoMs: 1 });
    const t1 = await adapter.getSnapshot('T1');
    // 去报销：整单确认之后开始写入，服务端自己探测到登录后自动写完。
    expect((await adapter.startErpWrite('T1', t1.step.stepToken)).ok).toBe(true);
    await vi.waitFor(async () => expect((await adapter.getSnapshot('T1')).stage).toBe('done'));
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const row = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(row).getByText('回读不一致').className).toContain('badge-err');
    expect(within(row).queryByText('已完成')).toBeNull();
    expect(within(row).getByRole('link', { name: '查看结果 →' }).getAttribute('href')).toBe('#/task/T1/done');
  });

  test('service-disconnected：任务列表读不到时显示全页横幅并自动重试，恢复后横幅消失、列表出现', async () => {
    window.location.hash = '#/tasks';
    render(<App adapter={createMockAdapter({ seed: null, fault: 'service-disconnected', reconnectAfterMs: 300 })} />);
    expect((await screen.findByRole('alert')).textContent).toBe(SERVICE_DOWN_NOTICE);
    expect(screen.queryByText('2026-08 上海出差（产品评审）')).toBeNull();
    expect(await screen.findByText('2026-08 上海出差（产品评审）', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
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
    expect(within(stages).getAllByRole('listitem').map((item) => item.textContent?.replace(/^\d/, ''))).toEqual([
      '上传材料',
      '材料盘点',
      '待确认项',
      '项目归属',
      '整单明细确认',
      '去打印 / 去报销',
      '完成',
    ]);
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
