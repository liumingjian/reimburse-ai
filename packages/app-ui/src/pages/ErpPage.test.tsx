import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type Fault } from '../mock/mock-adapter';

const STEP_TITLES = ['启动浏览器', '登录', '导入发票', '填明细', '保存', '严格回读'];

function renderErp(fault: Fault | null = null, erpLoginAutoMs = 60_000) {
  window.location.hash = '#/task/T1/erp';
  const adapter = createMockAdapter({ seed: 'erp', fault, erpStepMs: 5, erpLoginAutoMs });
  render(<App adapter={adapter} />);
  return adapter;
}

const progress = () => screen.getByRole('region', { name: '填报进度' });
const stepItem = (title: string) => within(progress()).getByRole('listitem', { name: title });
const loginButton = () => screen.findByRole('button', { name: '我已登录，继续' });

async function startAndReachLogin() {
  await screen.findByRole('heading', { name: 'ERP 填报' });
  fireEvent.click(screen.getByRole('button', { name: '开始填报' }));
  return loginButton();
}

describe('ERP 填报', () => {
  test('六个步骤按顺序可见；登录步有「我已登录，继续」并回传 stepToken；写完进入完成页，逐条回读 9/9 一致', async () => {
    const adapter = renderErp();
    const confirmLogin = vi.spyOn(adapter, 'confirmLogin');
    await screen.findByRole('heading', { name: 'ERP 填报' });
    expect(within(progress()).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(STEP_TITLES);
    expect(screen.queryByRole('button', { name: '我已登录，继续' })).toBeNull();

    const button = await startAndReachLogin();
    expect(stepItem('启动浏览器').textContent).toContain('完成');
    expect(stepItem('登录').textContent).toContain('等待你操作');
    expect(stepItem('导入发票').textContent).not.toContain('完成');
    fireEvent.click(button);
    expect(confirmLogin).toHaveBeenCalledWith('T1', expect.stringMatching(/^tok-T1-erp-login-/));

    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
    for (const title of STEP_TITLES) expect(stepItem(title).textContent).toContain('完成');

    window.location.hash = '#/task/T1/done';
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(screen.getByTestId('draft-no').textContent).toBe('BX20260911-0173');
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    const table = screen.getByRole('table', { name: '逐条回读' });
    const bodyRows = within(table).getAllByRole('row').filter((row) => row.closest('tbody'));
    expect(bodyRows).toHaveLength(9);
    for (const row of bodyRows) {
      expect(row.className).not.toContain('row-err');
      expect(within(row).getByText('一致')).toBeTruthy();
    }
    expect(screen.getByTestId('readback-local-total').textContent).toBe('3972.59');
    expect(screen.getByTestId('readback-erp-total').textContent).toBe('3972.59');
  });

  test('正常场景下服务端自己探测到登录也会往下走', async () => {
    renderErp(null, 20);
    await startAndReachLogin();
    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
  });

  test('erp-login-missing：点了继续仍未检测到登录，提示留在原地并说明，按钮可以再按；第三次检测到后继续', async () => {
    renderErp('erp-login-missing');
    fireEvent.click(await startAndReachLogin());
    expect(await screen.findByText(/还没有检测到登录（第 1 次检测）/)).toBeTruthy();
    expect(stepItem('登录').textContent).toContain('等待你操作');
    const again = (await loginButton()) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    expect(await screen.findByText(/还没有检测到登录（第 2 次检测）/)).toBeTruthy();
    fireEvent.click(await loginButton());
    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
  });

  test('erp-write-aborted：保存步中止后自动进入对账页（替换历史记录），显示中止原因与对账入口', async () => {
    renderErp('erp-write-aborted');
    fireEvent.click(await startAndReachLogin());
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/reconcile');
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/保存草稿时 ERP 没有在限定时间内返回结果/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新对账' })).toBeTruthy();
  });

  test('直接打开已中止任务的 ERP 填报页不跳转，保留「进入对账」入口', async () => {
    window.location.hash = '#/task/T1/erp';
    render(<App adapter={createMockAdapter({ seed: 'reconcile', fault: null })} />);
    expect(await screen.findByRole('heading', { name: 'ERP 填报' })).toBeTruthy();
    expect(stepItem('保存').textContent).toContain('已中止');
    expect(screen.getByRole('alert').textContent).toContain('ERP 填报已停止');
    expect(screen.getByRole('link', { name: '进入对账' }).getAttribute('href')).toBe('#/task/T1/reconcile');
  });

  test('readback-mismatch：写入停下后进入完成页，差异行高亮（danger）、没有完成态；转人工（带 stepToken）后显示已转人工，任务列表也是', async () => {
    const adapter = renderErp('readback-mismatch');
    const handOff = vi.spyOn(adapter, 'handOff');
    fireEvent.click(await startAndReachLogin());
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/done');
    expect(screen.getByTestId('draft-no').textContent).toBe('BX20260911-0173');
    const bad = screen.getByTestId('readback-8');
    expect(bad.className).toContain('row-err');
    expect(within(bad).getByText('不一致')).toBeTruthy();
    expect(within(bad).getByText('74.00')).toBeTruthy();
    expect(screen.getByTestId('readback-7').className).not.toContain('row-err');
    expect(screen.queryByText('明细 9/9 一致')).toBeNull();
    expect(screen.getByText('明细 8/9 一致，1 行不一致')).toBeTruthy();
    expect(screen.queryByText(/^已完成：草稿/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('这份草稿不算完成');
    expect(screen.getByText('ERP 中存在草稿 BX20260911-0173，9 行明细中 8 行一致，1 行金额不一致。')).toBeTruthy();

    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(screen.getByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入 ERP/)).toBeTruthy();
    expect(handOff).toHaveBeenCalledWith('T1', stepToken);
    expect(screen.queryByRole('button', { name: '转人工' })).toBeNull();
    expect(screen.getByText('已转人工')).toBeTruthy();

    window.location.hash = '#/tasks';
    const row = await screen.findByRole('row', { name: /2026-08 上海出差（产品评审）/ });
    expect(await within(row).findByText('已转人工')).toBeTruthy();
  });
});
