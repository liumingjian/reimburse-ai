import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { STALE_STEP_NOTICE } from '../contract/actions';
import { PROJECT_CHANGED_NOTICE, REVIEW_INVALIDATED_NOTICE } from '../contract/snapshot';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderReview(seed: TaskStage = 'review', autoStepMs = 5) {
  window.location.hash = '#/task/T1/review';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs, erpStepMs: 5, erpLoginAutoMs: 60_000 });
  render(<App adapter={adapter} />);
  return adapter;
}

const table = () => screen.getByRole('table', { name: '候选明细' });
const confirmPanel = () => screen.getByLabelText('整单确认');
const checkbox = () => within(confirmPanel()).getByRole('checkbox', { name: '我已核对整单明细' });
const printLink = () => screen.queryByRole('link', { name: '去打印' });
const claimButton = () => screen.queryByRole('button', { name: '去报销' });
const bodyRows = () => within(table()).getAllByRole('row').filter((row) => row.closest('tbody'));
// Testing Library 跳过 aria-hidden 的色条单元格：0 是 No.，1 是日期，2 是费用类别。
const cell = (row: HTMLElement, index: number) => within(row).getAllByRole('cell')[index]?.textContent;

const REMOTE = '外地市内交通';

describe('整单明细确认', () => {
  test('?seed=review：9 行按统一业务序号列出，No.1 是外地市内交通的首条、住宿排最后；一票多段归为一组；合计与夹具一致；未勾选时没有动作按钮', async () => {
    renderReview();
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    const rows = bodyRows();
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => cell(row, 0))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(rows.map((row) => cell(row, 2))).toEqual([REMOTE, REMOTE, REMOTE, REMOTE, REMOTE, REMOTE, '长途交通', '长途交通', '住宿']);
    expect(rows[0]?.textContent).toContain('高德 · 虹桥枢纽 → 漕河泾');
    expect(rows[8]?.textContent).toContain('全季酒店 13 晚');
    // 高德三段是同一张发票：同一 rowgroup，后两行的材料来源写「同上」。
    const amap = within(table()).getByRole('rowgroup', { name: 'No.1-3 · 高德打车_发票.pdf' });
    expect(within(amap).getAllByRole('row')).toHaveLength(3);
    expect(within(amap).getAllByText('同上')).toHaveLength(2);
    expect(within(amap).getByText('普通发票 · 参考材料：高德打车_行程单.pdf')).toBeTruthy();
    expect(within(table()).getByRole('rowgroup', { name: 'No.4 · 曹操出行_发票.pdf' })).toBeTruthy();
    expect(rows[4]?.textContent).toContain('出租车 · 张江高科 → 漕河泾开发区');
    // 价税合计突出，不含税与税额为次要列。
    const hotel = within(table()).getByRole('rowgroup', { name: 'No.9 · 全季酒店_发票.pdf' });
    expect(within(hotel).getByText('3640.00').className).toContain('gross');
    expect(within(hotel).getByText('3433.96').className).toContain('secondary');
    expect(within(hotel).getByText('206.04').className).toContain('secondary');
    expect(screen.getByTestId('gross-total').textContent).toBe('3972.59');
    expect(screen.getByText('合计 · 7 张发票 · 9 行')).toBeTruthy();
    expect(screen.getByText(/未进入明细：餐饮_发票\.pdf/)).toBeTruthy();
    // 项目归属在确认之前已完成，随确认一起生效；支付截图不在这里补充。
    expect(screen.getByTestId('review-purpose').textContent).toContain('上海产品评审出差');
    expect(screen.getByRole('link', { name: '修改项目归属' }).getAttribute('href')).toBe('#/task/T1/project');
    expect(screen.queryByRole('button', { name: /补充支付截图/ })).toBeNull();
    expect(screen.queryByLabelText(/选择支付截图/)).toBeNull();

    expect((checkbox() as HTMLInputElement).checked).toBe(false);
    expect(printLink()).toBeNull();
    expect(claimButton()).toBeNull();
    expect(screen.queryByRole('button', { name: '追加材料' })).toBeNull();
  });

  test('勾选即确认：出现并列的去打印与去报销；去打印进入打印稿，去报销请服务端开始写入并进入 ERP 填报页（没有开始填报）', async () => {
    const adapter = renderReview();
    await screen.findByRole('heading', { name: '整单明细确认' });
    fireEvent.click(checkbox());
    const print = await screen.findByRole('link', { name: '去打印' });
    const claim = screen.getByRole('button', { name: '去报销' });
    expect(print.getAttribute('href')).toBe('#/task/T1/print');
    expect(print.className).toBe(claim.className);
    expect(print.className).toContain('btn-primary');
    expect(screen.getByText(/^整单明细已确认（2026-09-11 \d\d:\d\d）/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '我已核对整单明细' })).toBeNull();
    expect(screen.getByRole('button', { name: '追加材料' })).toBeTruthy();

    // 确认动作带着快照里的摘要（绑定项目归属）与 stepToken 到了服务端：阶段进入去打印 / 去报销。
    let snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(snapshot.confirmation.digest).toMatch(/^digest-t1-v1-/);
    expect(snapshot.stage).toBe('actions');
    expect(snapshot.step.kind).toBe('choose_action');

    fireEvent.click(print);
    expect(await screen.findByRole('heading', { name: '打印稿预览' })).toBeTruthy();
    window.location.hash = '#/task/T1/review';
    fireEvent.click(await screen.findByRole('button', { name: '去报销' }));
    expect(await screen.findByRole('heading', { name: 'ERP 填报' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/erp');
    expect(screen.queryByRole('button', { name: '开始填报' })).toBeNull();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.stage).toBe('erp');
    expect(snapshot.erp.status).not.toBe('idle');
    expect(snapshot.confirmation.status).toBe('confirmed');

    // 回到确认页：去报销换成查看填报进度；写入已开始，追加材料与修改项目归属不再可用。
    window.location.hash = '#/task/T1/review';
    expect((await screen.findByRole('link', { name: '查看填报进度' })).getAttribute('href')).toBe('#/task/T1/erp');
    expect(screen.queryByRole('link', { name: '修改项目归属' })).toBeNull();
    expect((screen.getByRole('button', { name: '追加材料' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('?seed=actions：直接是已确认状态，两个入口并列；侧栏里项目归属排在整单明细确认之前', async () => {
    renderReview('actions');
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '去报销' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    const labels = within(stages).getAllByRole('listitem').map((item) => item.textContent?.replace(/^(\d|✓)/, ''));
    expect(labels).toEqual(['上传材料', '材料盘点', '待确认项', '项目归属', '整单明细确认', '去打印 / 去报销', '完成']);
    expect(within(stages).getByText('整单明细确认').closest('a')?.getAttribute('aria-current')).toBe('step');
    expect(within(stages).getByText('项目归属').closest('a')?.getAttribute('href')).toBe('#/task/T1/project');
    expect(within(stages).getByText('去打印 / 去报销').closest('a')).toBeTruthy();
  });

  test('确认后改派项目：确认失效并提示重新确认；重新确认后两个入口回来', async () => {
    const adapter = renderReview('actions');
    fireEvent.click(await screen.findByRole('link', { name: '修改项目归属' }));
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.9' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: '项目工作台' })).getByRole('button', { name: '归入 P-1180 内部培训' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '1 条明细已有其他项目归属，请确认是否覆盖' })).getByRole('button', { name: '确认覆盖' }));
    fireEvent.click(screen.getByRole('button', { name: '确认项目归属' }));

    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    expect(await screen.findByText(PROJECT_CHANGED_NOTICE)).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: '我已核对整单明细' })).toBeTruthy();
    expect(printLink()).toBeNull();
    expect(claimButton()).toBeNull();
    let snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('invalidated');
    expect(snapshot.projectAssignment.assignments.find((item) => item.lineId === 'l9')?.projectNumber).toBe('P-1180');

    fireEvent.click(checkbox());
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(snapshot.confirmation.notice).toBeNull();
  });

  test('确认后再次提交相同的项目归属与事由：摘要不变，确认仍然有效', async () => {
    const adapter = createMockAdapter({ seed: 'actions', fault: null });
    const before = await adapter.getSnapshot('T1');
    const projects = Object.fromEntries(before.projectAssignment.assignments.map((item) => [item.lineId, item.projectNumber]));
    const outcome = await adapter.submitProjectAssignment('T1', { purpose: before.projectAssignment.purpose ?? '', projects }, before.step.stepToken);
    expect(outcome.ok).toBe(true);
    const after = await adapter.getSnapshot('T1');
    expect(after.confirmation).toMatchObject({ status: 'confirmed', digest: before.confirmation.digest });
    expect(after.stage).toBe('actions');
  });

  test('?seed=catalog：确认页先显示报销信息核对与材料准备的进度，完成后才能确认', async () => {
    renderReview('catalog', 300);
    expect(await screen.findByText(/正在核对报销信息/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '我已核对整单明细' })).toBeNull();
    expect(await screen.findByText(/正在准备报销材料/)).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: '我已核对整单明细' })).toBeTruthy();
  });

  test('确认后追加材料：二次确认弹层，取消不改变任何状态，继续则确认失效并回到上传页接收新批次', async () => {
    const adapter = renderReview('actions');
    await screen.findByRole('link', { name: '去打印' });
    fireEvent.click(screen.getByRole('button', { name: '追加材料' }));
    const dialog = screen.getByRole('dialog', { name: '追加材料会形成新的盘点版本' });
    expect(within(dialog).getByText(/将使整单明细确认失效/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(printLink()).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/review');
    let snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(snapshot.stage).toBe('actions');

    fireEvent.click(screen.getByRole('button', { name: '追加材料' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '继续追加' }));
    expect(await screen.findByRole('heading', { name: '上传材料' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/upload');
    expect(screen.getByRole('status').textContent).toBe(REVIEW_INVALIDATED_NOTICE);
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('invalidated');
    expect(snapshot.confirmation.notice).toBe(REVIEW_INVALIDATED_NOTICE);
    expect(snapshot.stage).toBe('upload');
    expect(snapshot.step.kind).toBe('start_inventory');

    // 上传页直接打开了追加区，能接收新批次。
    const input = screen.getByLabelText('选择文件');
    Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.4 more'], '地铁_发票.pdf', { type: 'application/pdf' })], configurable: true });
    fireEvent.change(input);
    expect(await screen.findByRole('heading', { name: '上传批次 #2 · 1 份材料' })).toBeTruthy();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.batches).toHaveLength(2);
    expect(snapshot.confirmation.status).toBe('invalidated');

    // 旧确认失效后，整单明细确认页在重新盘点前不能进。
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
  });

  test('上传页的追加下一批在已确认时同样先二次确认', async () => {
    window.location.hash = '#/task/T1/upload';
    const adapter = createMockAdapter({ seed: 'actions', fault: null });
    render(<App adapter={adapter} />);
    fireEvent.click(await screen.findByRole('button', { name: '追加下一批' }));
    const dialog = screen.getByRole('dialog', { name: '追加材料会形成新的盘点版本' });
    fireEvent.click(within(dialog).getByRole('button', { name: '继续追加' }));
    expect(await screen.findByText('拖入文件，或点击选择')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(REVIEW_INVALIDATED_NOTICE);
    expect((await adapter.getSnapshot('T1')).confirmation.status).toBe('invalidated');
  });

  test('stepToken 过期：确认被拒，页面换成最新快照并提示任务已在别处推进', async () => {
    const adapter = renderReview();
    await screen.findByRole('heading', { name: '整单明细确认' });
    const before = await adapter.getSnapshot('T1');
    // 另一个窗口先确认了；本页还没收到推送，勾选时带着旧凭据。
    expect((await adapter.confirmReview('T1', before.confirmation.digest ?? '', before.step.stepToken)).ok).toBe(true);
    fireEvent.click(checkbox());
    expect(await screen.findByText(STALE_STEP_NOTICE)).toBeTruthy();
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
    // 服务端只确认了一次，确认时间来自第一次。
    const after = await adapter.getSnapshot('T1');
    expect(after.confirmation.status).toBe('confirmed');
    expect(after.step.stepToken).not.toBe(before.step.stepToken);
  });
});
