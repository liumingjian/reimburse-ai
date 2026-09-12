import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderAt(hash: string, seed: TaskStage | null = null) {
  window.location.hash = hash;
  render(<App adapter={createMockAdapter({ seed, fault: null, erpStepMs: 5 })} />);
}

describe('ERP 对账', () => {
  test('T2 直接打开：五行比对（合计 1264.00），No.3 高亮为不一致；重新对账仍有不一致，原地等待', async () => {
    renderAt('#/task/T2/reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    const table = screen.getByRole('table', { name: '逐行比对' });
    expect(within(table).getAllByRole('row').filter((row) => row.closest('tbody'))).toHaveLength(5);
    expect(screen.getByTestId('readback-3').className).toContain('row-err');
    expect(screen.getByTestId('readback-1').className).not.toContain('row-err');
    expect(screen.getByTestId('readback-local-total').textContent).toBe('1264.00');
    expect(screen.getByText('ERP 中存在草稿 BX20260718-0142，5 行明细中 4 行一致，1 行金额不一致。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新对账' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '转人工' })).toBeTruthy();
    // 服务端建议的处置（转人工）用选中样式标出，不是主按钮；整页至多一个主按钮。
    expect(screen.getByRole('button', { name: '转人工' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '重新对账' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '转人工' }).className).not.toContain('btn-primary');
    expect(document.querySelectorAll('.btn-primary').length).toBeLessThanOrEqual(1);

    fireEvent.click(screen.getByRole('button', { name: '重新对账' }));
    expect(await screen.findByText(/已重新对账（第 1 次）/)).toBeTruthy();
    expect(screen.getByTestId('reconcile-status').textContent).toBe('原地等待');
  });

  test('转人工：处置区消失，页面与侧栏都显示已转人工', async () => {
    renderAt('#/task/T2/reconcile');
    fireEvent.click(await screen.findByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入 ERP/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新对账' })).toBeNull();
    expect(screen.getByText('已转人工处理，应用不再写入 ERP。')).toBeTruthy();
  });

  test('?seed=reconcile（T1 保存步中止）：显示中止原因与对账状态；重新对账读到草稿且逐行一致，进入完成页', async () => {
    renderAt('#/task/T1/reconcile', 'reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/保存草稿时 ERP 没有在限定时间内返回结果/)).toBeTruthy();
    const state = screen.getByRole('region', { name: '当前对账状态' });
    expect(within(state).getByText('未知')).toBeTruthy();
    expect(within(state).getByText('尚未读到草稿')).toBeTruthy();
    // 保存步中止建议原地等待：重新对账是选中样式。
    expect(screen.getByRole('button', { name: '重新对账' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '转人工' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '重新对账' }));
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    expect(screen.getByText(/重新对账：ERP 中已有草稿 BX20260911-0173/)).toBeTruthy();
  });
});
