import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { PROJECT_ASSIGNMENT_ERRORS } from '../contract/actions';
import type { AppAdapter } from '../contract/adapter';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderProject(seed: TaskStage = 'project', prepare?: (adapter: AppAdapter) => Promise<unknown>) {
  window.location.hash = '#/task/T1/project';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  const ready = (prepare ? prepare(adapter) : Promise.resolve()).then(() => render(<App adapter={adapter} />));
  return { adapter, ready };
}

const workbench = () => screen.getByRole('complementary', { name: '项目工作台' });
const search = () => screen.getByRole('searchbox', { name: '查找个人项目簿' });
const listNames = () =>
  (within(workbench()).queryByRole('list', { name: '项目列表' })?.querySelectorAll('.name') ?? []).length === 0
    ? []
    : [...(within(workbench()).getByRole('list', { name: '项目列表' }).querySelectorAll('.name') ?? [])].map((node) => node.textContent);
const usageNames = () => [...(within(workbench()).queryByRole('list', { name: '本次已归入' })?.querySelectorAll('.name') ?? [])].map((node) => node.textContent);
const usage = (number: string) => screen.getByTestId(`usage-${number}`).textContent;
const pick = (no: number) => fireEvent.click(screen.getByRole('checkbox', { name: `选择明细 No.${no}` }));
const assignTo = (label: string) => fireEvent.click(within(workbench()).getByRole('button', { name: `归入 ${label}` }));
const projectOf = (no: number) => screen.getByTestId(`project-of-${no}`).textContent;
const submitButton = () => screen.getByRole('button', { name: '确认项目归属' }) as HTMLButtonElement;
const summary = () => screen.getByTestId('assign-summary').textContent;
const purpose = () => screen.getByLabelText('报销事由');
const settled = async (no: number, text: string) => waitFor(() => expect(projectOf(no)).toBe(text));

describe('项目归属（内核 Variant B 工作台）', () => {
  test('只列可选项目：不可选的（已过期、复检未通过）不出现；本次已归入的项目带条数与金额，不在可选列表里重复；搜索只过滤可选列表', async () => {
    const { ready } = renderProject();
    await ready;
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    expect(screen.getByText('常驻城市：杭州')).toBeTruthy();
    expect(usageNames()).toEqual(['华东客户交付']);
    expect(usage('P-2307')).toBe('2 条 · 47.54 元');
    expect(listNames()).toEqual(['华东客户交付二期', '产品调研', '内部培训']);
    expect(within(workbench()).queryByText('南京客户培训')).toBeNull();
    expect(within(workbench()).queryByText('旧版对账工具')).toBeNull();
    expect(within(workbench()).queryByText('已过期')).toBeNull();
    // 没勾选明细时「归入」不可用。
    expect((within(workbench()).getByRole('button', { name: '归入 P-3312 产品调研' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(search(), { target: { value: '华东' } });
    expect(listNames()).toEqual(['华东客户交付二期']);
    fireEvent.change(search(), { target: { value: 'p-331' } });
    expect(listNames()).toEqual(['产品调研']);
    fireEvent.change(search(), { target: { value: '不存在的项目' } });
    expect(listNames()).toEqual([]);
    expect(within(workbench()).getByText('没有匹配的可选项目')).toBeTruthy();
    fireEvent.change(search(), { target: { value: '' } });
    expect(listNames()).toHaveLength(3);
  });

  test('明细按费用类别分组，组标题带条数；卡片有日期范围、城市、路线与脱敏票号', async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    // 类别组是「费用明细」区域里按类别命名的区域。
    const groups = within(screen.getByRole('region', { name: '费用明细' })).getAllByRole('region');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['外地市内交通', '长途交通', '住宿']);
    expect(within(groups[0]!).getByText('6 条')).toBeTruthy();
    expect(within(groups[1]!).getByText('2 条')).toBeTruthy();
    expect(within(groups[2]!).getByText('1 条')).toBeTruthy();
    const hotel = screen.getByTestId('line-card-9');
    expect(hotel.textContent).toContain('2026-08-09 至 2026-08-22');
    expect(hotel.textContent).toContain('上海');
    expect(hotel.textContent).toContain('2631************7734');
    const rail = screen.getByTestId('line-card-7');
    expect(rail.textContent).toContain('杭州东 → 上海虹桥');
    expect(rail.textContent).toContain('长途交通');
    expect(screen.getByTestId('line-card-5').textContent).toContain('04****77');
  });

  test('勾选「外地市内交通」组标题，一次归入 P-2307：该组全部明细已归入，项目的条数与金额随之变化（来自快照）', async () => {
    const { adapter, ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择外地市内交通' }));
    expect(screen.getByText('已选 6 条')).toBeTruthy();
    assignTo('P-2307 华东客户交付');
    for (const no of [1, 2, 3, 4, 5, 6]) await settled(no, 'P-2307 · 华东客户交付');
    expect(projectOf(7)).toBe('未归属');
    expect(usage('P-2307')).toBe('6 条 · 186.59 元');
    expect(screen.getByText('已选 0 条')).toBeTruthy();

    // 归入一个新项目：它进入「本次已归入」，不再出现在可选列表里。
    pick(9);
    assignTo('P-3312 产品调研');
    await waitFor(() => expect(usage('P-3312')).toBe('1 条 · 3640.00 元'));
    expect(usageNames()).toEqual(['华东客户交付', '产品调研']);
    expect(listNames()).toEqual(['华东客户交付二期', '内部培训']);

    // 条数与金额是服务端给的，归入只改正在编辑的归属，没有提交。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.projectAssignment.usage).toEqual([
      { number: 'P-2307', name: '华东客户交付', lineCount: 6, grossTotal: '186.59', selectable: true },
      { number: 'P-3312', name: '产品调研', lineCount: 1, grossTotal: '3640.00', selectable: true },
    ]);
    expect(snapshot.projectAssignment.status).toBe('pending');
    expect(snapshot.projectAssignment.assignments).toHaveLength(2);
  });

  // 这个用例连着做好几轮归入与弹层选择；页面换成 Carbon 组件后在 jsdom 里渲染更慢，放宽到 15 秒（行为断言不变）。
  test('逐条与批量归入；批量碰到已有其他项目时三个选项：取消不变、只处理未归属、确认覆盖', { timeout: 15_000 }, async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    expect(projectOf(1)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(3)).toBe('未归属');

    pick(3);
    expect(screen.getByText('已选 1 条')).toBeTruthy();
    assignTo('P-1180 内部培训');
    await settled(3, 'P-1180 · 内部培训');
    expect(screen.getByText('已选 0 条')).toBeTruthy();

    // 批量：No.1、No.2（已归 P-2307）与 No.4（未归属）一起归入 P-3312。
    const selectConflict = () => {
      pick(1);
      pick(2);
      pick(4);
      assignTo('P-3312 产品调研');
      return screen.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });
    };

    let dialog = selectConflict();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(projectOf(1)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(4)).toBe('未归属');
    // 取消保留勾选，可以换个项目或调整勾选。
    expect(screen.getByText('已选 3 条')).toBeTruthy();
    for (const no of [1, 2, 4]) pick(no);

    dialog = selectConflict();
    fireEvent.click(within(dialog).getByRole('button', { name: '只处理未归属' }));
    await settled(4, 'P-3312 · 产品调研');
    expect(projectOf(1)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(2)).toBe('P-2307 · 华东客户交付');

    pick(1);
    pick(2);
    pick(5);
    assignTo('P-3312 产品调研');
    dialog = screen.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认覆盖' }));
    await settled(1, 'P-3312 · 产品调研');
    expect(projectOf(2)).toBe('P-3312 · 产品调研');
    expect(projectOf(5)).toBe('P-3312 · 产品调研');

    // 同一项目再归入不算冲突。
    pick(1);
    pick(6);
    assignTo('P-3312 产品调研');
    expect(screen.queryByRole('dialog')).toBeNull();
    await settled(6, 'P-3312 · 产品调研');
  });

  test('提交按钮：任一明细未归属或事由为空时不可用，显示已归属 n/m 与合计；「仅未归属」只列未归属明细', async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    expect(summary()).toBe('已归属 2 / 9 条 · 合计 3972.59 元');
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(PROJECT_ASSIGNMENT_ERRORS.incomplete)).toBeTruthy();

    fireEvent.change(purpose(), { target: { value: '上海产品评审出差' } });
    expect(submitButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: '仅未归属' }));
    expect(screen.queryByRole('checkbox', { name: '选择明细 No.1' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前明细' }));
    expect(screen.getByText('已选 7 条')).toBeTruthy();
    assignTo('P-3312 产品调研');
    expect(await screen.findByText('所有明细都已归属。')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '仅未归属' }));
    expect(summary()).toBe('已归属 9 / 9 条 · 合计 3972.59 元');
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(PROJECT_ASSIGNMENT_ERRORS.incomplete)).toBeNull();

    // 事由清空（只有空白也算空）又不可用。
    fireEvent.change(purpose(), { target: { value: '   ' } });
    expect(submitButton().disabled).toBe(true);
  });

  test('提交：带 stepToken 送出，项目归属变为已提交；服务端自动核对报销信息、准备材料后进入整单确认，确认绑定这份归属', async () => {
    const { adapter, ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    const before = await adapter.getSnapshot('T1');
    fireEvent.change(purpose(), { target: { value: '  上海产品评审出差 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前明细' }));
    assignTo('P-2311 华东客户交付二期');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '只处理未归属' }));
    await settled(9, 'P-2311 · 华东客户交付二期');
    fireEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/review');
    expect(await screen.findByRole('button', { name: '确认整单明细' })).toBeTruthy();

    const after = await adapter.getSnapshot('T1');
    expect(after.projectAssignment.status).toBe('submitted');
    expect(after.projectAssignment.purpose).toBe('上海产品评审出差');
    expect(after.projectAssignment.assignments).toHaveLength(9);
    expect(after.projectAssignment.assignments.find((item) => item.lineId === 'l1')).toMatchObject({ projectNumber: 'P-2307', projectName: '华东客户交付' });
    expect(after.projectAssignment.assignments.find((item) => item.lineId === 'l9')).toMatchObject({ projectNumber: 'P-2311' });
    expect(after.stage).toBe('review');
    expect(after.step.kind).toBe('confirm_review');
    expect(after.step.stepToken).not.toBe(before.step.stepToken);
    expect(after.confirmation.status).toBe('unconfirmed');
    expect(after.confirmation.digest).toMatch(/^digest-t1-v1-/);

    // 回到项目归属页：显示已提交，ERP 写入开始前仍可改派，并有整单确认入口。
    window.location.hash = '#/task/T1/project';
    expect(await screen.findByText(/项目归属已提交/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '去整单明细确认' }).getAttribute('href')).toBe('#/task/T1/review');
    expect(submitButton().disabled).toBe(false);
  });

  test('在项目簿删除本任务已用的项目：已归入的明细沿用，提交仍通过；这个项目显示「已锁定」，不能归入新的明细', async () => {
    const { adapter, ready } = renderProject('review', async (a) => {
      const removed = await a.removeProject('P-2307');
      expect(removed).toMatchObject({ ok: true, result: { status: 'removed' } });
    });
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    expect(usage('P-2307')).toBe('3 条 · 3786.00 元');
    const locked = within(workbench()).getByRole('list', { name: '本次已归入' });
    expect(within(locked).getByText('已锁定')).toBeTruthy();
    expect(within(workbench()).queryByRole('button', { name: '归入 P-2307 华东客户交付' })).toBeNull();
    expect(listNames()).toEqual(['华东客户交付二期', '内部培训']);

    // 服务端同样拒绝新的归属用它（归入与提交都拒绝）。
    const snapshot = await adapter.getSnapshot('T1');
    const assignOutcome = await adapter.assignProjectLines('T1', { lineIds: ['l1'], projectNumber: 'P-2307', onlyUnassigned: false }, snapshot.step.stepToken);
    expect(assignOutcome).toMatchObject({ ok: false, error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotSelectable('P-2307') } });
    const projects = Object.fromEntries(snapshot.projectAssignment.assignments.map((item) => [item.lineId, item.projectNumber]));
    const submitOutcome = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects: { ...projects, l1: 'P-2307' } }, snapshot.step.stepToken);
    expect(submitOutcome).toMatchObject({ ok: false, error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(1, 'P-2307') } });

    // 沿用旧归属、改一下事由后提交：通过，进入整单确认。
    fireEvent.change(purpose(), { target: { value: '上海产品评审出差（补）' } });
    fireEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    const after = await adapter.getSnapshot('T1');
    expect(after.projectAssignment.status).toBe('submitted');
    expect(after.projectAssignment.assignments.find((item) => item.lineId === 'l9')).toMatchObject({ projectNumber: 'P-2307', projectName: '华东客户交付' });
    expect(after.projectAssignment.projects.map((project) => project.number)).not.toContain('P-2307');
  });

  test('项目归属没完成时，整单确认页不能进（阶段不可跳过）', async () => {
    const { ready } = renderProject('project');
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    expect(screen.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到当前阶段' }).getAttribute('href')).toBe('#/task/T1/project');
  });

  test('ERP 写入开始后项目归属只读，服务端也拒绝归入与改派', async () => {
    const { adapter, ready } = renderProject('erp');
    await ready;
    expect(await screen.findByText('已开始写入报销系统，项目归属不能再修改。')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect((purpose() as HTMLInputElement).disabled).toBe(true);
    const snapshot = await adapter.getSnapshot('T1');
    const projects = Object.fromEntries(snapshot.lines.map((line) => [line.lineId, 'P-2307']));
    const outcome = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects }, snapshot.step.stepToken);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    const assigned = await adapter.assignProjectLines('T1', { lineIds: ['l1'], projectNumber: 'P-1180', onlyUnassigned: false }, snapshot.step.stepToken);
    expect(assigned).toMatchObject({ ok: false, error: { code: 'not_ready' } });
  });

  test('服务端判定：不在允许列表或不可选的项目、缺项目、空事由都被拒绝，状态不变', async () => {
    const adapter = createMockAdapter({ seed: 'project', fault: null });
    const snapshot = await adapter.getSnapshot('T1');
    const token = snapshot.step.stepToken;
    const all = (number: string) => Object.fromEntries(snapshot.lines.map((line) => [line.lineId, number]));
    expect(snapshot.projectAssignment.projects.map((project) => project.number)).toEqual(['P-2307', 'P-2311', 'P-3312', 'P-1180']);

    const expired = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects: all('P-4420') }, token);
    expect(expired).toMatchObject({ ok: false, error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(1, 'P-4420') } });
    const unknown = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects: all('P-9999') }, token);
    expect(unknown).toMatchObject({ ok: false, error: { code: 'project_not_allowed' } });
    const missing = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects: { l1: 'P-2307' } }, token);
    expect(missing).toMatchObject({ ok: false, error: { code: 'line_unassigned', message: PROJECT_ASSIGNMENT_ERRORS.lineUnassigned(2) } });
    const blank = await adapter.submitProjectAssignment('T1', { purpose: '  ', projects: all('P-2307') }, token);
    expect(blank).toMatchObject({ ok: false, error: { code: 'invalid_purpose', message: PROJECT_ASSIGNMENT_ERRORS.purpose } });
    const stale = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects: all('P-2307') }, 'tok-old');
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_step' } });
    const expiredAssign = await adapter.assignProjectLines('T1', { lineIds: ['l3'], projectNumber: 'P-4420', onlyUnassigned: false }, token);
    expect(expiredAssign).toMatchObject({ ok: false, error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotSelectable('P-4420') } });
    const noLines = await adapter.assignProjectLines('T1', { lineIds: [], projectNumber: 'P-2307', onlyUnassigned: false }, token);
    expect(noLines).toMatchObject({ ok: false, error: { code: 'no_lines' } });

    const still = await adapter.getSnapshot('T1');
    expect(still.projectAssignment.status).toBe('pending');
    expect(still.projectAssignment.working).toHaveLength(2);
    expect(still.stage).toBe('project');
  });
});
