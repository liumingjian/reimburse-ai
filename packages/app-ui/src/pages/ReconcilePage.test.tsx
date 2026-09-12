import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { AppProvider } from '../adapter/context';
import { AppStore } from '../adapter/store';
import { HUMAN_REVIEW_NOTICE, RECONCILE_BUCKETS, type ReconcileBucket } from '../contract/snapshot';
import type { TaskStage } from '../contract/stage';
import { reconcileVerdict } from '../mock/fixtures/erp';
import { t2Snapshot } from '../mock/fixtures/tasks';
import { createMockAdapter } from '../mock/mock-adapter';
import { ReconcilePage } from './ReconcilePage';

function renderAt(hash: string, seed: TaskStage | null = null) {
  window.location.hash = hash;
  render(<App adapter={createMockAdapter({ seed, fault: null, erpStepMs: 5 })} />);
}

// 直接渲染对账页：服务端给出的对账判定换成某个 bucket 的判定，页面只渲染允许的处置。
function renderVerdict(bucket: ReconcileBucket, savedConsistent: boolean) {
  const base = t2Snapshot();
  const snapshot = { ...base, reconcile: { ...base.reconcile, ...reconcileVerdict(bucket, savedConsistent) } };
  const store = new AppStore(createMockAdapter({ seed: null, fault: null }), { validate: false });
  render(
    <AppProvider store={store}>
      <ReconcilePage snapshot={snapshot} />
    </AppProvider>,
  );
}

const actionButtons = () =>
  within(screen.getByRole('region', { name: '处置' }))
    .getAllByRole('button')
    .map((button) => button.textContent);

describe('对账', () => {
  // 内核 classifyReconciliation：只有三种情况转人工（未保存·已导入未写明细、不自洽、身份不成立或逐行不一致的已保存）。
  const CASES: ReadonlyArray<readonly [ReconcileBucket, boolean, string, boolean]> = [
    ['未知', true, '重新对账', false],
    ['未保存·导入前', true, '重新对账', false],
    ['未保存·已导入未写明细', true, '转人工', true],
    ['未保存·就绪待保存', true, '重新对账', false],
    ['已保存', true, '重新对账', false],
    ['已保存', false, '转人工', true],
    ['不自洽', true, '转人工', true],
  ];

  test('六个 bucket 都有判定', () => {
    expect(new Set(CASES.map(([bucket]) => bucket))).toEqual(new Set(RECONCILE_BUCKETS));
  });

  for (const [bucket, consistent, only, humanReview] of CASES) {
    test(`${bucket}${bucket === '已保存' ? (consistent ? '（一致）' : '（逐行不一致）') : ''}：只显示「${only}」${humanReview ? '，显示人工核对固定句' : ''}`, () => {
      renderVerdict(bucket, consistent);
      expect(screen.getByTestId('reconcile-bucket').textContent).toBe(bucket);
      expect(actionButtons()).toEqual([only]);
      if (humanReview) {
        expect(screen.getByTestId('human-review').textContent).toBe(HUMAN_REVIEW_NOTICE);
        expect(screen.queryByRole('button', { name: '重新对账' })).toBeNull();
      } else {
        expect(screen.queryByTestId('human-review')).toBeNull();
      }
    });
  }

  test('T2（已保存、逐行不一致 ⇒ 转人工）：固定句、没有「重新对账」；五行比对（合计 1264.00），No.3 展开后显示对不上的字段与原因', async () => {
    renderAt('#/task/T2/reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(screen.getByTestId('human-review').textContent).toBe('当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。');
    expect(screen.queryByRole('button', { name: '重新对账' })).toBeNull();
    expect(screen.getByRole('button', { name: '转人工' })).toBeTruthy();
    const table = screen.getByRole('table', { name: '逐行比对' });
    expect(within(table).getAllByRole('row').filter((row) => row.closest('tbody'))).toHaveLength(5);
    expect(screen.getByTestId('readback-3').className).toContain('row-err');
    expect(screen.getByTestId('readback-1').className).not.toContain('row-err');
    expect(screen.getByTestId('readback-local-total').textContent).toBe('1264.00');
    expect(screen.getByText('报销系统中存在草稿 BX20260718-0142，5 行明细中 4 行一致，1 行不一致。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开 No.3' }));
    expect(screen.getByRole('list', { name: 'No.3 对不上的字段' }).textContent).toBe('申请报销金额 本地 182.00 / 报销系统 128.00');
    expect(screen.getByRole('list', { name: 'No.3 原因' }).textContent).toContain('任务第 3 行');
  });

  test('转人工：处置区消失，页面与侧栏都显示已转人工', async () => {
    renderAt('#/task/T2/reconcile');
    fireEvent.click(await screen.findByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入报销系统/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '处置' })).toBeNull();
    expect(screen.getByText('已转人工处理，应用不再写入报销系统。')).toBeTruthy();
  });

  test('?seed=reconcile（T1 保存步中止，未知 ⇒ 原地等待）：只有「重新对账」；读到草稿且逐行一致，进入完成页并显示固定句', async () => {
    renderAt('#/task/T1/reconcile', 'reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/保存草稿时报销系统没有在限定时间内返回结果/)).toBeTruthy();
    const state = screen.getByRole('region', { name: '当前对账状态' });
    expect(within(state).getByText('未知')).toBeTruthy();
    expect(within(state).getByText('尚未读到草稿')).toBeTruthy();
    expect(actionButtons()).toEqual(['重新对账']);
    expect(screen.queryByTestId('human-review')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新对账' }));
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    expect(screen.getByTestId('save-completed').textContent).toBe('报销草稿已保存。请打开报销系统检查，是否提交由你决定。');
    expect(screen.getByText(/重新对账：报销系统中已有草稿 BX20260911-0173/)).toBeTruthy();
  });

  test('服务端也只接受允许的处置：未知 bucket 拒绝转人工，转人工的 bucket 拒绝重新对账', async () => {
    const adapter = createMockAdapter({ seed: 'reconcile', fault: null });
    const t1 = await adapter.getSnapshot('T1');
    const refused = await adapter.handOff('T1', t1.step.stepToken);
    expect(!refused.ok && refused.error.code).toBe('action_not_allowed');
    const t2 = await adapter.getSnapshot('T2');
    const refusedWait = await adapter.reconcile('T2', t2.step.stepToken);
    expect(!refusedWait.ok && refusedWait.error.code).toBe('action_not_allowed');
  });
});
