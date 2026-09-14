import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { ABANDON_TASK_COPY } from '../contract/actions';
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

// 打开一行的「更多」菜单（Carbon 把菜单挂在 body 下，按菜单的可访问名称找）。
// Carbon 量出菜单位置之前给菜单写 visibility: hidden，jsdom 不排版、量不出位置，菜单一直是隐藏的；
// 隐藏元素算不出可访问名称（aria-label 也不算），所以这里连隐藏的一起按角色找，再核对 aria-label 与文字。
// 菜单在真实浏览器里可见、按可访问名称找得到，由 e2e（tasks.spec.ts、carbon-zh.spec.ts）检查。
async function openMore(row: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.click(within(row).getByRole('button', { name: '更多' }));
  const label = `${name}的更多操作`;
  return waitFor(() => {
    const menu = screen.queryAllByRole('menu', { hidden: true }).find((element) => element.getAttribute('aria-label') === label);
    if (!menu) throw new Error(`没有打开「${label}」`);
    return menu;
  });
}

// 菜单里只有「作废」一项；可作废时文字就是「作废」，置灰时 aria-label 是「作废」，文字后面跟着原因。
function abandonItem(menu: HTMLElement): HTMLButtonElement {
  const items = within(menu).getAllByRole('menuitem', { hidden: true });
  expect(items).toHaveLength(1);
  const item = items[0] as HTMLButtonElement;
  expect(item.getAttribute('aria-label') ?? item.textContent).toBe('作废');
  return item;
}

describe('任务列表', () => {
  test('显示三个任务及其阶段徽标（内核 10 阶段名）：材料盘点、对账中、草稿交接', async () => {
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
    expect(within(t3).getByText('10/10 草稿交接')).toBeTruthy();
    expect(within(t3).getByText('BX20260702-0088')).toBeTruthy();

    expect(screen.getByRole('button', { name: '新建报销任务' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('林颂宜')).toBeTruthy();
    expect(screen.queryByText(/产品研发部/)).toBeNull();
  });

  test('?seed=done 时 T1 显示草稿交接、价税合计与草稿号', async () => {
    renderApp('#/tasks', 'done');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    expect(within(t1).getByText('10/10 草稿交接')).toBeTruthy();
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
    expect(within(row).getByText('已转人工').closest('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
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
    expect(within(row).getByText('回读不一致').closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger');
    expect(within(row).queryByText('10/10 草稿交接')).toBeNull();
    expect(within(row).getByRole('link', { name: '查看结果' }).getAttribute('href')).toBe('#/task/T1/done');
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

  test('操作列：每行只有一个可见的操作按钮和一个「更多」菜单，作废不再占一个按钮', async () => {
    renderApp('#/tasks');
    for (const [name, primary] of [
      ['2026-08 上海出差（产品评审）', '继续'],
      ['2026-07 深圳客户拜访', '查看对账'],
    ] as const) {
      const row = await rowOf(name);
      const actions = row.querySelector('td:last-child') as HTMLElement;
      expect(within(actions).getAllByRole('link').map((link) => link.textContent)).toEqual([primary]);
      expect(within(actions).getAllByRole('button')).toHaveLength(1);
      expect(within(actions).getByRole('button', { name: '更多' })).toBeTruthy();
      expect(within(row).queryByRole('button', { name: /作废/ })).toBeNull();
    }
    // 已交接、写入结局为 none 的任务没有主操作，只剩「更多」。
    const t3 = await rowOf('2026-06 北京培训');
    expect(within(t3).queryAllByRole('link')).toHaveLength(0);
    expect(within(t3).getAllByRole('button')).toHaveLength(1);
    expect(within(t3).getByRole('button', { name: '更多' })).toBeTruthy();
  });

  test('作废：可作废的任务从「更多」菜单作废，弹出危险确认，确认后从列表消失', async () => {
    renderApp('#/tasks');
    const t1 = await rowOf('2026-08 上海出差（产品评审）');
    const menu = await openMore(t1, '2026-08 上海出差（产品评审）');
    const item = abandonItem(menu);
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

  test('不可作废的任务：「更多」里的作废置灰，下面照抄服务端给出的原因', async () => {
    renderApp('#/tasks');
    for (const name of ['2026-07 深圳客户拜访', '2026-06 北京培训']) {
      const menu = await openMore(await rowOf(name), name);
      const item = abandonItem(menu);
      expect(item.disabled).toBe(true);
      expect(within(menu).getByText(ABANDON_TASK_COPY.blockedReason)).toBeTruthy();
      // 读屏把原因作为这一项的说明读出。
      expect(document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent).toBe(ABANDON_TASK_COPY.blockedReason);
      fireEvent.click(item);
      expect(screen.queryByRole('dialog')).toBeNull();
    }
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
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索任务名或草稿号' }), { target: { value: 'BX20260702' } });
    expect(screen.getByText('2026-06 北京培训')).toBeTruthy();
    expect(screen.queryByText('2026-07 深圳客户拜访')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索任务名或草稿号' }), { target: { value: '不存在' } });
    expect(screen.getByText('没有符合条件的任务。')).toBeTruthy();
  });

  test('?seed=erp（已开始写入报销系统）：T1 的「作废」不可用；服务端也拒绝', async () => {
    const adapter = createMockAdapter({ seed: 'erp', fault: null });
    window.location.hash = '#/tasks';
    render(<App adapter={adapter} />);
    const menu = await openMore(await rowOf('2026-08 上海出差（产品评审）'), '2026-08 上海出差（产品评审）');
    expect(abandonItem(menu).disabled).toBe(true);
    const refused = await adapter.abandonTask('T1');
    expect(!refused.ok && refused.error.message).toBe(ABANDON_TASK_COPY.blockedReason);
  });

  test('设置页「完全重置」：二次确认后清空本机数据，回到启动页；重新登录并确认身份后任务列表为空', async () => {
    renderApp('#/settings');
    fireEvent.click(await screen.findByRole('button', { name: '完全重置' }));
    const resetConfirm = within(screen.getByRole('dialog', { name: '清空本机全部数据？' })).getByRole('button', { name: '清空并重置' });
    fireEvent.click(resetConfirm);
    expect(await screen.findByRole('heading', { name: '登录报销系统' })).toBeTruthy();
    expect(window.location.hash).toBe('#/tasks');
    fireEvent.click(screen.getByRole('button', { name: '我已登录' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认' }));
    expect(await screen.findByRole('heading', { name: '还没有报销任务' })).toBeTruthy();
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
    expect(within(bar).queryByText('9/10 保存报销草稿')).toBeNull();
  });
});
