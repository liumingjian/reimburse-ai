import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { AppProvider } from '../adapter/context';
import { AppStore } from '../adapter/store';
import { HUMAN_REVIEW_NOTICE, RECONCILE_BUCKETS, type ReconcileBucket, type TaskStage } from '@baox/contract';
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

  test('页头没有孤立的「返回任务列表」：回任务列表走顶栏', async () => {
    renderAt('#/task/T2/reconcile');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: '返回任务列表' })).toBeNull();
    expect(screen.getByRole('link', { name: '报销任务' })).toBeTruthy();
  });

  test('六个 bucket 都有判定', () => {
    expect(new Set(CASES.map(([bucket]) => bucket))).toEqual(new Set(RECONCILE_BUCKETS));
  });

  for (const [bucket, consistent, suggested, humanReview] of CASES) {
    // 建议转人工时只能转人工；建议原地等待时两个都能做（与服务端 reconcileView 的 allowedActions 一致）。
    const expected = humanReview ? ['转人工'] : ['重新对账', '转人工'];
    test(`${bucket}${bucket === '已保存' ? (consistent ? '（一致）' : '（逐行不一致）') : ''}：建议「${suggested}」，可做 ${expected.join(' / ')}${humanReview ? '，显示人工核对固定句' : ''}`, () => {
      renderVerdict(bucket, consistent);
      expect(screen.getByTestId('reconcile-bucket').textContent).toBe(bucket);
      expect(actionButtons()).toEqual(expected);
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
    expect(within(screen.getByTestId('readback-3')).getByText('不一致')).toBeTruthy();
    expect(within(screen.getByTestId('readback-1')).queryByText('不一致')).toBeNull();
    expect(screen.getByTestId('readback-local-total').textContent).toBe('1264.00');
    expect(screen.getByText('报销系统中存在草稿 BX20260718-0142，5 行明细中 4 行一致，1 行不一致。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开 No.3' }));
    expect(screen.getByRole('list', { name: 'No.3 对不上的字段' }).textContent).toBe('申请报销金额 本地 182.00 / 报销系统 128.00');
    expect(screen.getByRole('list', { name: 'No.3 原因' }).textContent).toContain('任务第 3 行');
  });

  test('T2：顶部只有一条错误通知（写入结果不确定，副标题是中止原因），没有「当前对账状态」节标题；摘要条显示快照里的草稿号与一致、不一致行数；转人工在吸底栏，固定句写在后果说明里', async () => {
    renderAt('#/task/T2/reconcile');
    await screen.findByRole('heading', { name: '对账' });
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('写入结果不确定');
    expect(alerts[0]?.textContent).toContain('保存草稿后回读超时，写入结果不确定。');
    expect(screen.queryByRole('heading', { name: '当前对账状态' })).toBeNull();
    expect(screen.getByTestId('reconcile-draft-no').textContent).toBe('BX20260718-0142');
    expect(screen.getByTestId('reconcile-banner').textContent).toBe('报销系统中存在草稿 BX20260718-0142，5 行明细中 4 行一致，1 行不一致。');
    const bar = screen.getByRole('region', { name: '处置' });
    expect(within(bar).getByTestId('human-review').textContent).toContain('请联系报销管理员');
    expect(within(bar).getByText(/转人工后任务标记为人工处理/)).toBeTruthy();
  });

  test('转人工：处置区消失，页面与步骤条都显示已转人工', async () => {
    renderAt('#/task/T2/reconcile');
    fireEvent.click(await screen.findByRole('button', { name: '转人工' }));
    expect(await screen.findByText(/已转人工处理：应用不再写入报销系统/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '处置' })).toBeNull();
    expect(screen.getByText('已转人工处理，应用不再写入报销系统。')).toBeTruthy();
  });

  test('?seed=reconcile（T1 保存步中止，未知 ⇒ 原地等待）：只有「重新对账」；读到草稿且逐行一致，进入完成页并显示固定句', async () => {
    renderAt('#/task/T1/reconcile', 'reconcile');
    expect(await screen.findByRole('heading', { name: '对账' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '中止原因' })).getByText(/交接单据时报销系统没有在限定时间内返回结果/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '当前对账状态' })).toBeNull();
    expect(screen.getByTestId('reconcile-bucket').textContent).toBe('未知');
    expect(screen.getByTestId('reconcile-draft-no').textContent).toBe('尚未读到草稿');
    expect(actionButtons()).toEqual(['重新对账', '转人工']);
    expect(screen.queryByTestId('human-review')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重新对账' }));
    expect(await screen.findByRole('heading', { name: '完成' })).toBeTruthy();
    expect(screen.getByText('明细 9/9 一致')).toBeTruthy();
    expect(screen.getByTestId('handover-completed').textContent).toBe('报销单已经按你确认的明细填好，还没有保存。请在报销系统里逐行核对，由你自己点「保存」。保存时如果弹出「字段必录提示」或「处理结果」，说明有字段没有真正写进报销系统：回到这里重新去报销这一项，不要手工补填。保存成功后回到这里再对一次账，这是最后一步。');
    expect(screen.getByText(/重新对账：报销系统中已有草稿 BX20260911-0173/)).toBeTruthy();
  });

  test('服务端也只接受允许的处置：转人工的 bucket 拒绝重新对账，原地等待的 bucket 两种都接受', async () => {
    const adapter = createMockAdapter({ seed: 'reconcile', fault: null });
    const t2 = await adapter.getSnapshot('T2');
    const refusedWait = await adapter.reconcile('T2', t2.step.stepToken);
    expect(!refusedWait.ok && refusedWait.error.code).toBe('action_not_allowed');
    // 建议原地等待（未知）时转人工一直是允许的：卡住的人总得能交给人处理。
    const t1 = await adapter.getSnapshot('T1');
    expect((await adapter.handOff('T1', t1.step.stepToken)).ok).toBe(true);
  });
});
