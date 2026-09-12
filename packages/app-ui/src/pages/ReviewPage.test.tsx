import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { STALE_STEP_NOTICE } from '../contract/actions';
import { PAYMENT_SCREENSHOT_ERRORS, REVIEW_INVALIDATED_NOTICE } from '../contract/snapshot';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderReview(seed: TaskStage = 'review') {
  window.location.hash = '#/task/T1/review';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

const table = () => screen.getByRole('table', { name: '候选明细' });
const confirmPanel = () => screen.getByLabelText('整单确认');
const checkbox = () => within(confirmPanel()).getByRole('checkbox', { name: '我已核对整单明细' });
const printLink = () => screen.queryByRole('link', { name: '去打印' });
const claimLink = () => screen.queryByRole('link', { name: '去报销' });

function chooseScreenshot(file: File) {
  const input = screen.getByLabelText('选择支付截图：全季酒店_发票.pdf');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const png = (name = 'IMG_5011.png') => new File(['png bytes'], name, { type: 'image/png' });

describe('整单明细确认', () => {
  test('?seed=review：9 行按统一业务序号连续列出，一票多段归为一组，合计与夹具一致；未勾选时没有动作按钮', async () => {
    renderReview();
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    const rows = within(table()).getAllByRole('row').filter((row) => row.closest('tbody'));
    expect(rows).toHaveLength(9);
    const nos = rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(nos).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    // 高德三段是同一张发票：同一 rowgroup，后两行的材料来源写「同上」。
    const amap = within(table()).getByRole('rowgroup', { name: 'No.3-5 · 高德打车_发票.pdf' });
    expect(within(amap).getAllByRole('row')).toHaveLength(3);
    expect(within(amap).getAllByText('同上')).toHaveLength(2);
    expect(within(amap).getByText('普通发票 · 参考材料：高德打车_行程单.pdf')).toBeTruthy();
    // 曹操（08-11）排在高德第三段（08-12）之后：分组优先于逐行按日期。
    expect(within(table()).getByRole('rowgroup', { name: 'No.6 · 曹操出行_发票.pdf' })).toBeTruthy();
    expect(rows[6]?.textContent).toContain('出租车 · 张江高科 → 漕河泾开发区');
    expect(within(table()).getAllByText('外地市内交通')).toHaveLength(6);
    // 价税合计突出，不含税与税额为次要列。
    const hotel = within(table()).getByRole('rowgroup', { name: 'No.2 · 全季酒店_发票.pdf' });
    expect(within(hotel).getByText('3640.00').className).toContain('gross');
    expect(within(hotel).getByText('3433.96').className).toContain('secondary');
    expect(within(hotel).getByText('206.04').className).toContain('secondary');
    expect(screen.getByTestId('gross-total').textContent).toBe('3972.59');
    expect(screen.getByText('合计 · 7 张发票 · 9 行')).toBeTruthy();
    expect(screen.getByText(/未进入明细：餐饮_发票\.pdf/)).toBeTruthy();

    expect((checkbox() as HTMLInputElement).checked).toBe(false);
    expect(printLink()).toBeNull();
    expect(claimLink()).toBeNull();
    expect(screen.queryByRole('button', { name: '追加材料' })).toBeNull();
  });

  test('勾选「我已核对整单明细」即确认：出现并列的去打印与去报销，样式相同，分别指向打印稿与项目归属', async () => {
    const adapter = renderReview();
    await screen.findByRole('heading', { name: '整单明细确认' });
    fireEvent.click(checkbox());
    const print = await screen.findByRole('link', { name: '去打印' });
    const claim = screen.getByRole('link', { name: '去报销' });
    expect(print.getAttribute('href')).toBe('#/task/T1/print');
    expect(claim.getAttribute('href')).toBe('#/task/T1/project');
    expect(print.className).toBe(claim.className);
    expect(print.className).toContain('btn-primary');
    expect(screen.getByText(/^整单明细已确认（2026-09-11 \d\d:\d\d）/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: '我已核对整单明细' })).toBeNull();
    expect(screen.getByRole('button', { name: '追加材料' })).toBeTruthy();

    // 确认动作带着快照里的摘要与 stepToken 到了服务端：阶段进入去打印 / 去报销。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(snapshot.confirmation.digest).toBe('digest-t1-v1');
    expect(snapshot.stage).toBe('actions');
    expect(snapshot.step.kind).toBe('choose_action');

    // 两个入口都能进（页面骨架属于后续票，这里只看导航）。
    fireEvent.click(print);
    expect(await screen.findByRole('heading', { name: '打印稿预览' })).toBeTruthy();
    window.location.hash = '#/task/T1/review';
    fireEvent.click(await screen.findByRole('link', { name: '去报销' }));
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
  });

  test('?seed=actions：直接是已确认状态，两个按钮并列', async () => {
    renderReview('actions');
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '去报销' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // 侧栏：整单明细确认为当前项，「去打印 / 去报销」已可进入。
    const stages = screen.getByRole('list', { name: '流程阶段' });
    expect(within(stages).getByText('整单明细确认').closest('a')?.getAttribute('aria-current')).toBe('step');
    expect(within(stages).getByText('去打印 / 去报销').closest('a')).toBeTruthy();
  });

  test('住宿发票行补充与移除支付截图：只进 paymentScreenshots，不改变确认状态；非图片被拒', async () => {
    const adapter = renderReview('actions');
    await screen.findByRole('link', { name: '去打印' });
    const hotel = within(table()).getByRole('rowgroup', { name: 'No.2 · 全季酒店_发票.pdf' });
    expect(within(hotel).getByRole('button', { name: '补充支付截图' })).toBeTruthy();
    // 只有住宿发票行有入口。
    expect(within(table()).getAllByRole('button', { name: '补充支付截图' })).toHaveLength(1);

    chooseScreenshot(new File(['%PDF'], '支付记录.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe(PAYMENT_SCREENSHOT_ERRORS.notImage);
    expect((await adapter.getSnapshot('T1')).paymentScreenshots).toHaveLength(0);

    chooseScreenshot(png());
    expect(await within(hotel).findByText('支付截图：IMG_5011.png')).toBeTruthy();
    expect(within(hotel).queryByRole('button', { name: '补充支付截图' })).toBeNull();
    let snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.paymentScreenshots).toMatchObject([{ voucherMaterialId: 'm01', fileName: 'IMG_5011.png' }]);
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(snapshot.stage).toBe('actions');
    // 两个按钮仍在：截图不影响确认。
    expect(printLink()).toBeTruthy();
    expect(claimLink()).toBeTruthy();

    fireEvent.click(within(hotel).getByRole('button', { name: '移除' }));
    expect(await within(hotel).findByRole('button', { name: '补充支付截图' })).toBeTruthy();
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.paymentScreenshots).toHaveLength(0);
    expect(snapshot.confirmation.status).toBe('confirmed');
    expect(printLink()).toBeTruthy();
  });

  test('未确认时也能补充支付截图，确认状态保持 unconfirmed', async () => {
    const adapter = renderReview('review');
    await screen.findByRole('heading', { name: '整单明细确认' });
    chooseScreenshot(png());
    expect(await screen.findByText('支付截图：IMG_5011.png')).toBeTruthy();
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.paymentScreenshots).toHaveLength(1);
    expect(snapshot.confirmation.status).toBe('unconfirmed');
    expect(printLink()).toBeNull();
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
