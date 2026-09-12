import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type Fault } from '../mock/mock-adapter';

const STEP_TITLES = ['启动浏览器', '登录', '打开空白报销单', '选择不生成费用明细', '导入发票', '收票回读', '填写明细', '保存草稿', '严格回读'];

// ?seed=erp：已在整单确认页点了「去报销」，浏览器已启动，登录步在等待。没有「开始填报」。
function renderErp(fault: Fault | null = null, erpLoginAutoMs = 60_000) {
  window.location.hash = '#/task/T1/erp';
  const adapter = createMockAdapter({ seed: 'erp', fault, erpStepMs: 5, erpLoginAutoMs });
  render(<App adapter={adapter} />);
  return adapter;
}

const progress = () => screen.getByRole('region', { name: '填报进度' });
const stepItem = (title: string) => within(progress()).getByRole('listitem', { name: title });
const loginButton = () => screen.findByRole('button', { name: '我已登录，继续' });

async function waitingLogin() {
  await screen.findByRole('heading', { name: '保存报销草稿' });
  return loginButton();
}

describe('ERP 填报', () => {
  test('九个步骤（含选择不生成费用明细、收票回读）按顺序可见、没有「开始填报」；登录步有「我已登录，继续」并回传 stepToken；登录后自动写完，完成页显示固定句与逐条回读 9/9 一致', async () => {
    const adapter = renderErp();
    const confirmLogin = vi.spyOn(adapter, 'confirmLogin');
    const button = await waitingLogin();
    expect(within(progress()).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(STEP_TITLES);
    expect(screen.queryByRole('button', { name: '开始填报' })).toBeNull();
    expect(stepItem('启动浏览器').textContent).toContain('完成');
    expect(stepItem('登录').textContent).toContain('等待你操作');
    expect(stepItem('导入发票').textContent).not.toContain('完成');

    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(button);
    expect(confirmLogin).toHaveBeenCalledWith('T1', stepToken);

    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
    for (const title of STEP_TITLES) expect(stepItem(title).textContent).toContain('完成');

    window.location.hash = '#/task/T1/done';
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(screen.getByTestId('draft-no').textContent).toBe('BX20260911-0173');
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    expect(screen.getByTestId('save-completed').textContent).toBe('报销草稿已保存。请打开报销系统检查，是否提交由你决定。');
    expect(screen.queryByTestId('human-review')).toBeNull();
    const table = screen.getByRole('table', { name: '逐条回读' });
    const bodyRows = within(table).getAllByRole('row').filter((row) => row.closest('tbody'));
    expect(bodyRows).toHaveLength(9);
    for (const row of bodyRows) {
      expect(row.className).not.toContain('row-err');
      expect(within(row).getByText('一致')).toBeTruthy();
    }
    // 回读行用同一个统一业务序号：No.1 是外地市内交通的首条，住宿排最后。
    expect(screen.getByTestId('readback-1').textContent).toContain('高德 · 虹桥枢纽 → 漕河泾');
    expect(screen.getByTestId('readback-9').textContent).toContain('全季酒店 13 晚');
    expect(screen.getByTestId('readback-local-total').textContent).toBe('3972.59');
    expect(screen.getByTestId('readback-erp-total').textContent).toBe('3972.59');
  });

  test('从整单确认页点「去报销」：启动浏览器后等待登录，服务端自己探测到登录也会自动写完', async () => {
    window.location.hash = '#/task/T1/review';
    const adapter = createMockAdapter({ seed: 'actions', fault: null, erpStepMs: 5, erpLoginAutoMs: 20 });
    const start = vi.spyOn(adapter, 'startErpWrite');
    render(<App adapter={adapter} />);
    fireEvent.click(await screen.findByRole('button', { name: '去报销' }));
    expect(await screen.findByRole('heading', { name: '保存报销草稿' })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '开始填报' })).toBeNull();
    expect(await screen.findByRole('link', { name: '查看完成结果' })).toBeTruthy();
  });

  test('erp-login-missing：点了继续仍未检测到登录，提示留在原地并说明，按钮可以再按；第三次检测到后继续', async () => {
    renderErp('erp-login-missing');
    fireEvent.click(await waitingLogin());
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
    fireEvent.click(await waitingLogin());
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/reconcile');
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/保存草稿时报销系统没有在限定时间内返回结果/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新对账' })).toBeTruthy();
  });

  test('直接打开已中止任务的 ERP 填报页不跳转，保留「进入对账」入口', async () => {
    window.location.hash = '#/task/T1/erp';
    render(<App adapter={createMockAdapter({ seed: 'reconcile', fault: null })} />);
    expect(await screen.findByRole('heading', { name: '保存报销草稿' })).toBeTruthy();
    expect(stepItem('保存草稿').textContent).toContain('已中止');
    expect(screen.getByRole('alert').textContent).toContain('写入报销系统已停止');
    expect(screen.getByRole('link', { name: '进入对账' }).getAttribute('href')).toBe('#/task/T1/reconcile');
  });

  test('readback-mismatch：写入停下后进入完成页，差异行高亮（danger）、没有完成态；转人工（带 stepToken）后显示已转人工，任务列表也是', async () => {
    const adapter = renderErp('readback-mismatch');
    const handOff = vi.spyOn(adapter, 'handOff');
    fireEvent.click(await waitingLogin());
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/done');
    expect(screen.getByTestId('draft-no').textContent).toBe('BX20260911-0173');
    const bad = screen.getByTestId('readback-6');
    expect(bad.className).toContain('row-err');
    expect(within(bad).getByText('不一致')).toBeTruthy();
    expect(within(bad).getByText('74.00')).toBeTruthy();
    expect(screen.getByTestId('readback-5').className).not.toContain('row-err');
    expect(screen.queryByText('明细 9/9 一致')).toBeNull();
    expect(screen.getByText('明细 8/9 一致，1 行不一致')).toBeTruthy();
    expect(screen.queryByText(/^已完成：草稿/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('这份草稿不算完成');
    expect(screen.getByText('报销系统中存在草稿 BX20260911-0173，9 行明细中 8 行一致，1 行不一致。')).toBeTruthy();
    expect(screen.queryByTestId('save-completed')).toBeNull();
    // 已保存但逐行不一致 ⇒ 转人工（human_review）：固定句。
    expect(screen.getByTestId('human-review').textContent).toBe('当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。');
    // 不一致的行展开后逐项列出对不上的字段与原因。
    expect(screen.queryByTestId('readback-detail-6')).toBeNull();
    fireEvent.click(within(bad).getByRole('button', { name: '展开 No.6' }));
    const detail = screen.getByTestId('readback-detail-6');
    expect(within(detail).getByRole('list', { name: 'No.6 对不上的字段' }).textContent).toBe('申请报销金额 本地 47.00 / 报销系统 74.00');
    expect(within(detail).getByRole('list', { name: 'No.6 原因' }).textContent).toContain('任务第 6 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的报销系统明细');
    fireEvent.click(within(bad).getByRole('button', { name: '收起 No.6' }));
    expect(screen.queryByTestId('readback-detail-6')).toBeNull();

    const { stepToken } = (await adapter.getSnapshot('T1')).step;
    fireEvent.click(screen.getByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入报销系统/)).toBeTruthy();
    expect(handOff).toHaveBeenCalledWith('T1', stepToken);
    expect(screen.queryByRole('button', { name: '转人工' })).toBeNull();
    expect(screen.getByText('已转人工')).toBeTruthy();

    window.location.hash = '#/tasks';
    const row = await screen.findByRole('row', { name: /2026-08 上海出差（产品评审）/ });
    expect(await within(row).findByText('已转人工')).toBeTruthy();
  });
});
