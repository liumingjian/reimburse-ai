import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { EXCLUDE_MATERIAL_ERRORS, STALE_STEP_NOTICE } from '../contract/actions';
import { CATALOG_PREPARATION_COPY, PROJECT_CHANGED_NOTICE, REVIEW_INVALIDATED_NOTICE } from '../contract/snapshot';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderReview(seed: TaskStage = 'review', autoStepMs = 5) {
  window.location.hash = '#/task/T1/review';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs, erpStepMs: 5, erpLoginAutoMs: 60_000 });
  render(<App adapter={adapter} />);
  return adapter;
}

const table = () => screen.getByRole('table', { name: '整单明细' });
const confirmPanel = () => screen.getByLabelText('整单确认');
const checkbox = () => within(confirmPanel()).getByRole('button', { name: '确认' });
const printLink = () => screen.queryByRole('link', { name: '去打印' });
const claimButton = () => screen.queryByRole('button', { name: '去报销' });
const bodyRows = () => within(table()).getAllByRole('row').filter((row) => row.closest('tbody'));
const cells = (row: HTMLElement | undefined) => (row ? within(row).getAllByRole('cell').map((cell) => cell.textContent) : []);

const REMOTE = '外地市内交通';
// 与内核 next.mjs:522-535 逐字一致的 13 列，前面加 No.。
const HEADERS = ['No.', '发票', '项目号', '起始日期', '结束日期', '住宿地/城市', '出发点', '目的地', '费用分类', '费用项目', '发票类型', '费用金额', '税额', '总额'];

describe('整单明细确认', () => {
  test('?seed=review：No. 加 13 列，按费用分类排序（外地市内交通、长途交通、住宿排最后），无组、无合计行；整页没有「参考材料」，文件名只出现在材料包清单一节；只能「确认」', async () => {
    renderReview();
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    expect(within(table()).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(HEADERS);
    const rows = bodyRows();
    expect(rows).toHaveLength(9);
    expect(within(table()).getAllByRole('rowgroup')).toHaveLength(2);
    expect(rows.map((row) => cells(row)[0])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(rows.map((row) => cells(row)[8])).toEqual([REMOTE, REMOTE, REMOTE, REMOTE, REMOTE, REMOTE, '长途交通', '长途交通', '住宿']);
    // 住宿：住宿地/城市为上海，起止日期为入住与离店；费用金额是不含税金额。
    expect(cells(rows[8])).toEqual(['9', '发票1', 'P-2307 / 华东客户交付', '2026-08-09', '2026-08-22', '上海', '', '', '住宿', 'FY020102 / 住宿费', '增值税发票', '3433.96', '206.04', '3640.00']);
    // 交通：结束日期与起始日期相同。
    expect(cells(rows[0])).toEqual(['1', '发票2', 'P-3312 / 产品调研', '2026-08-10', '2026-08-10', '上海', '虹桥枢纽', '漕河泾', REMOTE, 'FY020103 / 外地市内交通费', '普通发票', '25.92', '0.77', '26.69']);
    expect(cells(rows[4]).slice(1, 8)).toEqual(['发票6', 'P-3312 / 产品调研', '2026-08-15', '2026-08-15', '上海', '张江高科', '漕河泾开发区']);
    expect(cells(rows[6]).slice(3, 8)).toEqual(['2026-08-09', '2026-08-09', '', '杭州东', '上海虹桥']);
    // 13 列表格里没有文件名、参考材料与合计行。
    expect(table().textContent ?? '').not.toMatch(/\.pdf|\.jpg|\.png|参考材料|同上|合计 ·/);
    expect(screen.queryByTestId('gross-total')).toBeNull();
    // 整页没有「参考材料」四个字；文件名只在「材料包」一节（#114 要求的材料包文件清单）里出现，别处没有。
    expect(document.body.textContent ?? '').not.toContain('参考材料');
    // 标题下只有一句话，较长的解释在「说明」里；材料包清单默认收起，点开才看文件。
    expect(screen.getByText('唯一一次整单确认，项目归属一并生效。')).toBeTruthy();
    const packageSection = screen.getByRole('region', { name: '材料包' });
    const packageDetails = packageSection.querySelector('details');
    expect(packageDetails?.open).toBe(false);
    fireEvent.click(within(packageSection).getByText('材料包 13 份文件'));
    expect(packageDetails?.open).toBe(true);
    const outside = (document.body.textContent ?? '').replace(packageSection.textContent ?? '', '');
    expect(outside).not.toMatch(/\.pdf|\.jpg|\.png/);
    expect(screen.getByTestId('package-files').textContent).toBe('核对材料已生成，共 13 份文件。');
    const files = within(screen.getByRole('list', { name: '材料包文件' })).getAllByRole('listitem');
    expect(files).toHaveLength(13);
    expect(files[0]?.textContent).toBe('发票 invoices/全季酒店_发票.pdf');
    expect(files.map((item) => item.textContent)).toContain('证明材料 evidence/曹操出行_行程单.pdf');
    expect(screen.queryByRole('table', { name: '不匹配项' })).toBeNull();
    expect(screen.queryByRole('table', { name: '准备缺项' })).toBeNull();
    // 项目归属在确认之前已完成，随确认一起生效；支付截图不在这里补充。
    expect(screen.getByTestId('review-purpose').textContent).toContain('上海产品评审出差');
    expect(screen.getByRole('link', { name: '修改项目归属' }).getAttribute('href')).toBe('#/task/T1/project');
    expect(screen.getByTestId('confirm-only').textContent).toContain('不能在表里修改');
    expect(screen.getByRole('link', { name: '回到待确认项' }).getAttribute('href')).toBe('#/task/T1/pending');
    expect(screen.queryByRole('button', { name: /补充支付截图/ })).toBeNull();
    expect(screen.queryByLabelText(/选择支付截图/)).toBeNull();
    expect(within(table()).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    // 底部操作栏：左边一句话，右边「确认」加两个三级链接。
    expect(within(confirmPanel()).getByText('确认后项目归属一并生效')).toBeTruthy();
    expect(within(confirmPanel()).getByRole('link', { name: '回到待确认项' })).toBeTruthy();
    expect(within(confirmPanel()).getByRole('link', { name: '修改项目归属' })).toBeTruthy();
    expect((checkbox() as HTMLButtonElement).disabled).toBe(false);
    expect(printLink()).toBeNull();
    expect(claimButton()).toBeNull();
    expect(screen.queryByRole('button', { name: '追加材料' })).toBeNull();
  });

  test('点「确认」：出现并列的去打印与去报销；去打印进入打印稿，去报销请服务端开始写入并进入 ERP 填报页（没有开始填报）', async () => {
    const adapter = renderReview();
    await screen.findByRole('heading', { name: '整单明细确认' });
    fireEvent.click(checkbox());
    const print = await screen.findByRole('link', { name: '去打印' });
    const claim = screen.getByRole('button', { name: '去报销' });
    expect(print.getAttribute('href')).toBe('#/task/T1/print');
    expect(print.className).toBe(claim.className);
    expect(print.className).toContain('cds--btn--primary');
    expect(screen.getByText(/^整单明细已确认（2026-09-11 \d\d:\d\d）/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull();
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
    expect(await screen.findByRole('heading', { name: '保存报销草稿' })).toBeTruthy();
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

  test('?seed=actions：直接是已确认状态，两个入口并列；步骤条里项目归属排在整单明细确认之前', async () => {
    renderReview('actions');
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '去报销' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const stages = screen.getByRole('list', { name: '流程阶段' });
    const labels = ['上传材料', '材料盘点', '待确认项', '项目归属', '整单明细确认', '去打印 / 去报销', '完成'];
    within(stages)
      .getAllByRole('listitem')
      .forEach((item, index) => expect(item.textContent?.startsWith(labels[index] ?? '?'), labels[index]).toBe(true));
    expect(within(stages).getByRole('button', { name: /^整单明细确认/ }).getAttribute('aria-current')).toBe('step');
    expect(within(stages).getByRole('button', { name: /^去打印 \/ 去报销/ }).getAttribute('aria-disabled')).toBeNull();
    const project = within(stages).getByRole('button', { name: /^项目归属/ });
    expect(project.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(project);
    expect(window.location.hash).toBe('#/task/T1/project');
  });

  test('确认后改派项目：确认失效并提示重新确认；重新确认后两个入口回来', async () => {
    const adapter = renderReview('actions');
    fireEvent.click(await screen.findByRole('link', { name: '修改项目归属' }));
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择明细 No.9' }));
    fireEvent.click(within(screen.getByRole('complementary', { name: '项目工作台' })).getByRole('button', { name: '归入 P-1180 内部培训' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '1 条明细已有其他项目归属，请确认是否覆盖' })).getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(screen.getByTestId('project-of-9').textContent).toBe('P-1180 / 内部培训'));
    fireEvent.click(screen.getByRole('button', { name: '确认项目归属' }));

    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    expect(await screen.findByText(PROJECT_CHANGED_NOTICE)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '确认' })).toBeTruthy();
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

  test('?seed=catalog：确认页先显示报销信息核对与材料准备的进度（内核话术），完成后才能确认，并出现材料包文件清单', async () => {
    renderReview('catalog', 300);
    expect(await screen.findByText(CATALOG_PREPARATION_COPY.catalogRunning)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull();
    expect(screen.queryByTestId('package-files')).toBeNull();
    expect(await screen.findByText(CATALOG_PREPARATION_COPY.preparationRunning)).toBeTruthy();
    expect(await screen.findByRole('button', { name: '确认' })).toBeTruthy();
    expect((checkbox() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('package-files').textContent).toBe('核对材料已生成，共 13 份文件。');
  });

  test('?catalog=mismatch：不匹配表（列照内核）阻塞确认；回到项目归属把 No.7-9 改派出 P-2307 后重新核对通过', async () => {
    window.location.hash = '#/task/T1/review';
    const adapter = createMockAdapter({ seed: 'catalog', fault: null, autoStepMs: 5, catalogMismatch: true });
    render(<App adapter={adapter} />);
    const mismatch = await screen.findByRole('table', { name: '不匹配项' });
    expect(within(mismatch).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['序号', '材料/明细', '参考材料', '待处理问题', '处理人']);
    const row = within(mismatch).getAllByRole('row').find((candidate) => candidate.closest('tbody'));
    expect(cells(row)).toEqual(['1', '项目号 P-2307', '', '项目 P-2307「华东客户交付」在报销系统里已被禁用，不能引用', '要你处理']);
    expect(screen.getByText(CATALOG_PREPARATION_COPY.catalogMismatch)).toBeTruthy();
    expect((checkbox() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('package-files')).toBeNull();
    expect((await adapter.getSnapshot('T1')).step.kind).toBe('assign_projects');

    fireEvent.click(screen.getByRole('link', { name: '回到项目归属改派' }));
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    expect(screen.getAllByRole('alert').map((node) => node.textContent).join('')).toContain('P-2307');
    for (const no of [7, 8, 9]) fireEvent.click(screen.getByRole('checkbox', { name: `选择明细 No.${no}` }));
    fireEvent.click(within(screen.getByRole('complementary', { name: '项目工作台' })).getByRole('button', { name: '归入 P-1180 内部培训' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认覆盖' }));
    await waitFor(() => expect(screen.getByTestId('project-of-7').textContent).toBe('P-1180 / 内部培训'));
    fireEvent.click(screen.getByRole('button', { name: '确认项目归属' }));

    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    await waitFor(() => expect((checkbox() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('table', { name: '不匹配项' })).toBeNull();
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.catalog.status).toBe('matched');
    expect(snapshot.preparation.status).toBe('ready');
  });

  test('?preparation=blocked：缺项表（序号 | 准备缺项 | 关联材料/明细 | 处理人），确认不可用；排除相关材料后重新准备，确认恢复可用', async () => {
    window.location.hash = '#/task/T1/review';
    const adapter = createMockAdapter({ seed: 'preparation', fault: null, autoStepMs: 5, preparationBlocked: true });
    render(<App adapter={adapter} />);
    const problems = await screen.findByRole('table', { name: '准备缺项' });
    expect(within(problems).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['序号', '准备缺项', '关联材料/明细', '处理人']);
    const row = within(problems).getAllByRole('row').find((candidate) => candidate.closest('tbody'));
    expect(cells(row)[0]).toBe('1');
    expect(cells(row)[1]).toContain('明细 No.4 的出发点与行程单不一致');
    expect(cells(row).slice(2)).toEqual(['曹操出行_行程单.pdf', '要你处理']);
    expect(screen.getByText(CATALOG_PREPARATION_COPY.preparationBlocked)).toBeTruthy();
    expect((checkbox() as HTMLButtonElement).disabled).toBe(true);
    // 有缺项也生成材料包，供核对。
    expect(screen.getByTestId('package-files').textContent).toBe('核对材料已生成，共 13 份文件。');
    expect((await adapter.getSnapshot('T1')).step.kind).toBe('resolve_preparation');

    fireEvent.click(screen.getByRole('button', { name: '排除 曹操出行_行程单.pdf' }));
    await waitFor(() => expect((checkbox() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('table', { name: '准备缺项' })).toBeNull();
    expect(screen.getByTestId('package-files').textContent).toBe('核对材料已生成，共 12 份文件。');
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.materials.find((material) => material.materialId === 'm06')?.role).toBe('excluded');
    expect(snapshot.lines.find((line) => line.no === 4)?.referenceMaterialIds).toEqual([]);
    expect(snapshot.step.kind).toBe('confirm_review');

    fireEvent.click(checkbox());
    expect(await screen.findByRole('link', { name: '去打印' })).toBeTruthy();
  });

  test('排除材料只在材料包缺项时、且只对服务端标明可排除的材料接受', async () => {
    const adapter = createMockAdapter({ seed: 'review', fault: null });
    const review = await adapter.getSnapshot('T1');
    const outcome = await adapter.excludeMaterial('T1', 'm06', review.step.stepToken);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error.message).toBe(EXCLUDE_MATERIAL_ERRORS.notReady);
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
    expect(screen.getByRole('status').textContent).toContain(REVIEW_INVALIDATED_NOTICE);
    snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.confirmation.status).toBe('invalidated');
    expect(snapshot.confirmation.notice).toBe(REVIEW_INVALIDATED_NOTICE);
    expect(snapshot.stage).toBe('upload');
    expect(snapshot.step.kind).toBe('start_inventory');

    // 上传页直接打开了追加区，能接收新批次。
    const input = screen.getByLabelText('选择文件');
    Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.4 more'], '地铁_发票.pdf', { type: 'application/pdf' })], configurable: true });
    fireEvent.change(input);
    expect(await screen.findByRole('heading', { name: '上传批次 #2' })).toBeTruthy();
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
    expect(screen.getByRole('status').textContent).toContain(REVIEW_INVALIDATED_NOTICE);
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
