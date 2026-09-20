import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { ABANDON_TASK_COPY } from '@baox/contract';
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

function abandonItem(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: '作废' }) as HTMLButtonElement;
}

describe('任务列表', () => {
  test('显示三个任务及其阶段徽标（内核 10 阶段名）：材料盘点、对账中、单据交接', async () => {
    renderApp('#/tasks');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();

    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('3/10 材料盘点')).toBeTruthy();
    expect(within(t1).getByText('未确认')).toBeTruthy();
    expect(within(t1).getByRole('link', { name: '继续' }).getAttribute('href')).toBe('#/task/T1/upload');

    const t2 = await rowOf('2026-07 深圳客户拜访');
    expect(within(t2).getByText('对账中')).toBeTruthy();
    expect(within(t2).getByText('1264.00')).toBeTruthy();
    expect(within(t2).getByRole('link', { name: '查看对账' }).getAttribute('href')).toBe('#/task/T2/reconcile');

    const t3 = await rowOf('2026-06 北京培训');
    expect(within(t3).getByText('10/10 单据交接')).toBeTruthy();
    expect(within(t3).getByText('BX20260702-0088')).toBeTruthy();

    expect(screen.getByRole('button', { name: '新建报销任务' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('林颂宜')).toBeTruthy();
    expect(screen.queryByText(/产品研发部/)).toBeNull();
  });

  // ADR-0028：交接把填好、未保存的单据交给员工，报销系统还没有生成单据编号，所以这一列是空的。
  // 有编号的是 T3：那张单据是员工自己保存过的。
  test('?seed=done 时 T1 显示单据交接与价税合计，单据编号一列为空（交接时还没有保存）', async () => {
    renderApp('#/tasks', 'done');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('10/10 单据交接')).toBeTruthy();
    expect(within(t1).getByText('3972.59')).toBeTruthy();
    expect(within(t1).queryByText('BX20260911-0173')).toBeNull();
  });

  test('转人工的任务：徽标显示已转人工（服务端给出的列表字段），而不是对账中', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const t2 = await adapter.getSnapshot('T2');
    expect((await adapter.handOff('T2', t2.step.stepToken)).ok).toBe(true);
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const row = await rowOf('2026-07 深圳客户拜访');
    expect(within(row).getByText('已转人工').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
    expect(within(row).queryByText('对账中')).toBeNull();
  });

  test('严格回读不一致的任务：停在对账而不是单据交接，列表给出查看对账入口', async () => {
    const adapter = createMockAdapter({ seed: 'actions', fault: 'readback-mismatch', erpStepMs: 1, erpLoginAutoMs: 1 });
    const t1 = await adapter.getSnapshot('T1');
    // 去报销：整单确认之后开始写入，服务端自己探测到登录后自动写完。
    expect((await adapter.startErpWrite('T1', t1.step.stepToken)).ok).toBe(true);
    // 已保存但逐行不一致的草稿没有被证明与确认过的明细一致，不算交接完成。
    await vi.waitFor(async () => expect((await adapter.getSnapshot('T1')).stage).toBe('reconcile'));
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const row = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(row).getByText('对账中').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
    expect(within(row).queryByText('10/10 单据交接')).toBeNull();
    expect(within(row).getByRole('link', { name: '查看对账' }).getAttribute('href')).toBe('#/task/T1/reconcile');
  });

  test('service-disconnected：任务列表读不到时显示全页横幅并自动重试，恢复后横幅消失、列表出现', async () => {
    window.location.hash = '#/tasks';
    render(<App adapter={createMockAdapter({ seed: null, fault: 'service-disconnected', reconnectAfterMs: 300 })} />);
    expect((await screen.findByRole('alert')).textContent).toContain(SERVICE_DOWN_NOTICE);
    expect(screen.queryByText('2026-08 上海出差（产品评审）')).toBeNull();
    // 断开期间不能新建；等待恢复以加载指示呈现。
    expect((screen.getByRole('button', { name: '新建报销任务' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('正在等待本地服务恢复，恢复后自动加载…')).toBeTruthy();
    expect(await screen.findByText('2026-08 上海出差（产品评审）', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: '新建报销任务' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('task actions show the primary action and abandonment directly', async () => {
    renderApp('#/tasks');
    for (const [name, primary] of [
      ['2026-08 上海出差（产品评审）', '继续'],
      ['2026-07 深圳客户拜访', '查看对账'],
    ] as const) {
      const row = await rowOf(name);
      const actions = row.querySelector('td:last-child') as HTMLElement;
      expect(within(actions).getAllByRole('link').map((link) => link.textContent)).toEqual([primary]);
      expect(within(actions).getAllByRole('button')).toHaveLength(1);
      expect(within(actions).getByRole('button', { name: '作废' })).toBeTruthy();
      expect(within(row).queryByRole('button', { name: '更多' })).toBeNull();
    }
    // A completed task with no ERP outcome has only the abandonment action.
    const t3 = await rowOf('2026-06 北京培训');
    expect(within(t3).queryAllByRole('link')).toHaveLength(0);
    expect(within(t3).getAllByRole('button')).toHaveLength(1);
    expect(within(t3).getByRole('button', { name: '作废' })).toBeTruthy();
  });

  test('visible abandonment requires confirmation and removes the task after confirmation', async () => {
    renderApp('#/tasks');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    const row = t1;
    const item = abandonItem(row);
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    // 点作废不进入任务页，先弹出二次确认。
    expect(window.location.hash).toBe('#/tasks');
    const dialog = screen.getByRole('dialog', { name: ABANDON_TASK_COPY.dialogTitle });
    // 作废不可撤销：确认按钮文案不变；它是红色 danger 按钮由 e2e/tasks.spec.ts 量计算样式。
    fireEvent.click(within(dialog).getByRole('button', { name: '作废' }));
    await waitFor(() => expect(screen.queryByText('2026-08 上海出差（产品评审）')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('2026-07 深圳客户拜访')).toBeTruthy();
  });

  // ADR-0030：动过报销系统的任务照样能作废，确认框换一段说明：作废只改本机状态，撤不掉那边的单据。
  test('an ERP-touched task can be voided, and its confirmation says the ERP bill is not undone', async () => {
    renderApp('#/tasks');
    for (const name of ['2026-07 深圳客户拜访', '2026-06 北京培训']) {
      const row = await rowOf(name);
      const item = abandonItem(row);
      expect(item.disabled).toBe(false);
      fireEvent.click(item);
      const dialog = screen.getByRole('dialog', { name: ABANDON_TASK_COPY.dialogTitle });
      expect(within(dialog).getByText(new RegExp(ABANDON_TASK_COPY.dialogBodyErpTouched.slice(0, 20)))).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    }
    // 没动过报销系统的任务用的还是原来那段文案。
    fireEvent.click(abandonItem(await rowOf('2026-08 上海出差（产品评审）')));
    const plain = screen.getByRole('dialog', { name: ABANDON_TASK_COPY.dialogTitle });
    expect(within(plain).getByText(new RegExp(ABANDON_TASK_COPY.dialogBody.slice(0, 20)))).toBeTruthy();
  });

  // 唯一还挡着作废的状态：这个任务的写入正在跑（?seed=erp 下 T1 停在等待登录）。
  test('abandonment waits while the ERP job of this very task is in flight, and says so', async () => {
    renderApp('#/tasks', 'erp');
    const row = await rowOf('2026-08 上海出差（产品评审）');
    const item = abandonItem(row);
    expect(item.disabled).toBe(true);
    expect(within(row).getByText(ABANDON_TASK_COPY.blockedReason)).toBeTruthy();
    // 读屏把原因作为这一项的说明读出。
    expect(document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent).toBe(ABANDON_TASK_COPY.blockedReason);
    fireEvent.click(item);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('工具栏：状态筛选的条数取自这张列表，筛选与搜索只挑行显示', async () => {
    renderApp('#/tasks');
    await rowOf('2026-07 深圳客户拜访');

    const filters = screen.getByRole('tablist', { name: '按状态筛选' });
    expect(within(filters).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['全部 3', '进行中 1', '对账中 1', '已交接 1']);
    fireEvent.click(within(filters).getByRole('tab', { name: '对账中 1' }));
    expect(within(filters).getByRole('tab', { name: '对账中 1' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('2026-08 上海出差（产品评审）')).toBeNull();
    expect(screen.getByText('2026-07 深圳客户拜访')).toBeTruthy();
    fireEvent.click(within(filters).getByRole('tab', { name: '全部 3' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索任务名或单据编号' }), { target: { value: 'BX20260702' } });
    expect(screen.getByText('2026-06 北京培训')).toBeTruthy();
    expect(screen.queryByText('2026-07 深圳客户拜访')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索任务名或单据编号' }), { target: { value: '不存在' } });
    expect(screen.getByText('没有符合条件的任务。')).toBeTruthy();
  });

  test('?seed=erp（已开始写入报销系统）：T1 的「作废」不可用；服务端也拒绝', async () => {
    const adapter = createMockAdapter({ seed: 'erp', fault: null });
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const row = await rowOf('2026-08 上海出差（产品评审）');
    expect(abandonItem(row).disabled).toBe(true);
    const refused = await adapter.abandonTask('T1');
    expect(!refused.ok && refused.error.message).toBe(ABANDON_TASK_COPY.blockedReason);
  });

  test('设置页「完全重置」：二次确认后只清空当前账号的数据，仍然登录，回到空的任务列表', async () => {
    renderApp('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: '完全重置' }));
    const resetConfirm = within(screen.getByRole('dialog', { name: '清空你的全部数据？' })).getByRole('button', { name: '清空并重置' });
    fireEvent.click(resetConfirm);
    expect(await screen.findByRole('heading', { name: '还没有报销任务' })).toBeTruthy();
    expect(window.location.hash).toBe('#/tasks');
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  });

  test('未知路径回到任务列表', async () => {
    renderApp('#/nowhere');
    expect(await screen.findByRole('heading', { name: '报销任务' })).toBeTruthy();
    expect(window.location.hash).toBe('#/tasks');
  });
});

describe('任务页面骨架', () => {
  test('打开任务页面时步骤条列出流程阶段，当前阶段高亮', async () => {
    renderApp('#/task/T1/upload');
    expect(await screen.findByRole('heading', { name: '上传材料' })).toBeTruthy();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    const labels = ['上传材料', '材料盘点', '待确认项', '项目归属', '整单明细确认', '去打印 / 去报销', '完成'];
    const items = within(stages).getAllByRole('listitem');
    expect(items).toHaveLength(labels.length);
    items.forEach((item, index) => expect(item.textContent?.startsWith(labels[index] ?? '?'), labels[index]).toBe(true));
    expect(within(stages).getByRole('button', { name: /^上传材料/ }).getAttribute('aria-current')).toBe('step');
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

  test('对账中的任务步骤条显示状态而不是阶段列表', async () => {
    renderApp('#/task/T2/reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '流程阶段' })).toBeNull();
    const bar = screen.getByRole('region', { name: '任务进度' });
    expect(within(bar).getByText('写入结果待对账。')).toBeTruthy();
    // 10 阶段名只在任务列表徽标上，步骤条不再重复。
    expect(within(bar).queryByText('9/10 填写报销单')).toBeNull();
  });
});
