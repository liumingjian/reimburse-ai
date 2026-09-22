import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { PROJECT_ASSIGNMENT_ERRORS, type AppAdapter, type TaskStage } from '@baox/contract';
import { createMockAdapter } from '../mock/mock-adapter';

function renderProject(seed: TaskStage = 'project', prepare?: (adapter: AppAdapter) => Promise<unknown>) {
  window.location.hash = '#/task/T1/project';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  const ready = (prepare ? prepare(adapter) : Promise.resolve()).then(() => render(<App adapter={adapter} />));
  return { adapter, ready };
}

// Right-hand 归入项目 (assign to project) panel: every project is a button; clicking it assigns the ticked lines.
const panel = () => screen.getByRole('complementary', { name: '归入项目' });
const projectButtons = (listName?: string) => {
  const scope = listName ? within(panel()).queryByRole('list', { name: listName }) : panel();
  if (!scope) return [];
  return within(scope)
    .queryAllByRole('button')
    .filter((button) => button.classList.contains('app-project-target')) as HTMLButtonElement[];
};
const numberOf = (button: HTMLElement) => button.querySelector('.app-code')!.textContent;
const usageNumbers = () => projectButtons('本次已归入').map(numberOf);
const optionNumbers = () => projectButtons().map(numberOf);
const usage = (number: string) => screen.getByTestId(`usage-${number}`).textContent;
const target = (number: string) => projectButtons().find((button) => numberOf(button) === number)!;
const panelSearch = () => within(panel()).getByRole('searchbox', { name: '查找项目' });
const selection = () => screen.getByTestId('assign-selection').textContent;
// Assign the ticked lines: click the project in the panel.
const assignTo = (number: string) => fireEvent.click(target(number));
const pick = (no: number) => fireEvent.click(screen.getByRole('checkbox', { name: `选择明细 No.${no}` }));
const projectOf = (no: number) => screen.getByTestId(`project-of-${no}`).textContent;
const submitButton = () => screen.getByRole('button', { name: /^(确认项目归属|继续)$/ }) as HTMLButtonElement;
const summary = () => screen.getByTestId('assign-summary').textContent;
const purpose = () => screen.getByLabelText('报销事由');
const settled = async (no: number, text: string) => waitFor(() => expect(projectOf(no)).toBe(text));
describe('项目归属（工作台：勾选明细，点右侧项目归入）', () => {
  test('右栏「归入项目」面板：没勾选时项目不可点并提示先勾选；勾选后可点；取消选择清空勾选', async () => {
    const { adapter, ready } = renderProject();
    const assignSpy = vi.spyOn(adapter, 'assignProjectLines');
    await ready;
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    // 常驻城市是带标签的只读字段，与报销事由并排。
    const homeCity = screen.getByLabelText('常驻城市') as HTMLInputElement;
    expect(homeCity.value).toBe('杭州');
    expect(homeCity.readOnly).toBe(true);
    // No modal: the batch action bar and the 归入项目 modal button are gone.
    expect(screen.queryByRole('region', { name: '批量操作' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(usageNumbers()).toEqual(['P-2307']);
    expect(usage('P-2307')).toBe('2 条 / 47.54 元');
    expect(within(panel()).getByText('华东客户交付')).toBeTruthy();
    expect(selection()).toBe('勾选明细后，点右侧项目归入');
    expect(within(panel()).getByText('先勾选左侧明细')).toBeTruthy();
    expect(projectButtons().every((button) => button.disabled)).toBe(true);

    pick(3);
    pick(4);
    expect(selection()).toBe('已选 2 条，点右侧项目归入');
    expect(within(panel()).getByText('已选 2 条')).toBeTruthy();
    expect(projectButtons().every((button) => !button.disabled)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(selection()).toBe('勾选明细后，点右侧项目归入');
    expect((screen.getByRole('checkbox', { name: '选择明细 No.3' }) as HTMLInputElement).checked).toBe(false);
    expect(target('P-3312').disabled).toBe(true);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  test('面板列表：只列可选项目，本次已用的在前并带条数与金额；按项目号、名称或简称搜索并高亮；搜到唯一项目时回车直接归入', async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    expect(optionNumbers()).toEqual(['P-2307', 'P-2311', 'P-3312', 'P-1180']);
    expect(projectButtons('可选项目').map(numberOf)).toEqual(['P-2311', 'P-3312', 'P-1180']);
    // 不可选的（已过期、复检未通过）不出现。
    expect(within(panel()).queryByText('南京客户培训')).toBeNull();
    expect(within(panel()).queryByText('旧版对账工具')).toBeNull();

    fireEvent.change(panelSearch(), { target: { value: '华东' } });
    expect(optionNumbers()).toEqual(['P-2307', 'P-2311']);
    fireEvent.change(panelSearch(), { target: { value: 'p-331' } });
    expect(optionNumbers()).toEqual(['P-3312']);
    // Characters in order also match, so an abbreviation finds the full name; the hit characters are marked.
    fireEvent.change(panelSearch(), { target: { value: '华交 二期' } });
    expect(optionNumbers()).toEqual(['P-2311']);
    expect(Array.from(target('P-2311').querySelectorAll('mark')).map((mark) => mark.textContent).join('')).toBe('华交二期');
    fireEvent.change(panelSearch(), { target: { value: '不存在的项目' } });
    expect(optionNumbers()).toEqual([]);
    expect(within(panel()).getByText('没有匹配的项目')).toBeTruthy();

    // Enter without ticked lines does nothing; with lines ticked and a single match it assigns.
    fireEvent.change(panelSearch(), { target: { value: '产品' } });
    fireEvent.keyDown(panelSearch(), { key: 'Enter' });
    expect(projectOf(3)).toBe('未归属');
    pick(3);
    fireEvent.keyDown(panelSearch(), { key: 'Enter' });
    await settled(3, 'P-3312 / 产品调研');
    expect(selection()).toBe('已归入 P-3312 产品调研');
  });

  test('明细按费用类别分组，组标题带条数；卡片有日期范围、城市、路线与脱敏票号', async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    // 类别组是「费用明细」区域里按类别命名的区域。
    const groups = within(screen.getByRole('region', { name: '费用明细' }))
      .getAllByRole('region')
      .filter((region) => region.getAttribute('aria-label') !== '明细工具栏');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['外地市内交通', '长途交通', '住宿']);
    expect(within(groups[0]!).getByText('6 条')).toBeTruthy();
    expect(within(groups[1]!).getByText('2 条')).toBeTruthy();
    expect(within(groups[2]!).getByText('1 条')).toBeTruthy();
    const hotel = screen.getByTestId('line-card-9');
    expect(hotel.textContent).toContain('入住：2026-08-09');
    expect(hotel.textContent).toContain('离店：2026-08-22');
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
    expect(selection()).toBe('已选 6 条，点右侧项目归入');
    assignTo('P-2307');
    for (const no of [1, 2, 3, 4, 5, 6]) await settled(no, 'P-2307 / 华东客户交付');
    expect(projectOf(7)).toBe('未归属');
    expect(usage('P-2307')).toBe('6 条 / 186.59 元');
    expect(selection()).toBe('已归入 P-2307 华东客户交付');

    // 归入一个新项目：它进入「本次已归入」，排到本次已用的项目之后、其余项目之前。
    pick(9);
    assignTo('P-3312');
    await waitFor(() => expect(usage('P-3312')).toBe('1 条 / 3640.00 元'));
    expect(usageNumbers()).toEqual(['P-2307', 'P-3312']);
    expect(optionNumbers()).toEqual(['P-2307', 'P-3312', 'P-2311', 'P-1180']);

    // 条数与金额是服务端给的，归入只改正在编辑的归属，没有提交。
    const snapshot = await adapter.getSnapshot('T1');
    expect(snapshot.projectAssignment.usage).toEqual([
      { number: 'P-2307', name: '华东客户交付', lineCount: 6, grossTotal: '186.59', selectable: true },
      { number: 'P-3312', name: '产品调研', lineCount: 1, grossTotal: '3640.00', selectable: true },
    ]);
    expect(snapshot.projectAssignment.status).toBe('pending');
    expect(snapshot.projectAssignment.assignments).toHaveLength(2);
  });

  // 这个用例连着做好几轮归入；页面换成 Carbon 组件后在 jsdom 里渲染更慢，放宽到 15 秒（行为断言不变）。
  test('逐条与批量归入；批量碰到已有其他项目时三个选项：取消不变、只处理未归属、确认覆盖', { timeout: 15_000 }, async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    expect(projectOf(1)).toBe('P-2307 / 华东客户交付');
    expect(projectOf(3)).toBe('未归属');

    pick(3);
    expect(selection()).toBe('已选 1 条，点右侧项目归入');
    assignTo('P-1180');
    await settled(3, 'P-1180 / 内部培训');
    expect(selection()).toBe('已归入 P-1180 内部培训');

    // 批量：No.1、No.2（已归 P-2307）与 No.4（未归属）一起归入 P-3312。
    const selectConflict = () => {
      pick(1);
      pick(2);
      pick(4);
      assignTo('P-3312');
      return screen.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });
    };

    let dialog = selectConflict();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(projectOf(1)).toBe('P-2307 / 华东客户交付');
    expect(projectOf(4)).toBe('未归属');
    // 取消保留勾选，可以换个项目或调整勾选。
    expect(selection()).toBe('已选 3 条，点右侧项目归入');
    // While the overwrite question was open nothing else could be assigned; after cancel the projects work again.
    expect(target('P-3312').disabled).toBe(false);
    for (const no of [1, 2, 4]) pick(no);

    dialog = selectConflict();
    fireEvent.click(within(dialog).getByRole('button', { name: '只处理未归属' }));
    await settled(4, 'P-3312 / 产品调研');
    expect(projectOf(1)).toBe('P-2307 / 华东客户交付');
    expect(projectOf(2)).toBe('P-2307 / 华东客户交付');

    pick(1);
    pick(2);
    pick(5);
    assignTo('P-3312');
    dialog = screen.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认覆盖' }));
    await settled(1, 'P-3312 / 产品调研');
    expect(projectOf(2)).toBe('P-3312 / 产品调研');
    expect(projectOf(5)).toBe('P-3312 / 产品调研');

    // 同一项目再归入不算冲突。
    pick(1);
    pick(6);
    assignTo('P-3312');
    expect(screen.queryByRole('dialog')).toBeNull();
    await settled(6, 'P-3312 / 产品调研');
  });

  test('提交按钮：任一明细未归属或事由为空时不可用，显示已归属 n/m 与合计；「仅未归属」只列未归属明细', async () => {
    const { ready } = renderProject();
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    // 吸底栏写的是整单合计（服务端给出），不是已归属部分的合计。
    expect(summary()).toBe('已归属2 / 9 条整单合计3972.59 元');
    expect(within(screen.getByTestId('assign-summary')).getByText('整单合计')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(PROJECT_ASSIGNMENT_ERRORS.incomplete)).toBeTruthy();

    fireEvent.change(purpose(), { target: { value: '上海产品评审出差' } });
    expect(submitButton().disabled).toBe(true);

    // 「未归属」筛选是切换器（与任务列表一致），不是复选框。
    expect(screen.queryByRole('checkbox', { name: '仅未归属' })).toBeNull();
    const filter = screen.getByRole('tablist', { name: '明细筛选' });
    expect(within(filter).getByRole('tab', { name: '全部' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(filter).getByRole('tab', { name: '未归属' }));
    expect(within(filter).getByRole('tab', { name: '未归属' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('checkbox', { name: '选择明细 No.1' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前明细' }));
    expect(selection()).toBe('已选 7 条，点右侧项目归入');
    assignTo('P-3312');
    expect(await screen.findByText('所有明细都已归属。')).toBeTruthy();
    fireEvent.click(within(filter).getByRole('tab', { name: '全部' }));
    expect(summary()).toBe('已归属9 / 9 条整单合计3972.59 元');
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
    assignTo('P-2311');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '只处理未归属' }));
    await settled(9, 'P-2311 / 华东客户交付二期');
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

  test('项目归属没完成时，整单确认页不能进（阶段不可跳过）', async () => {
    const { ready } = renderProject('project');
    await ready;
    await screen.findByRole('heading', { name: '项目归属' });
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    expect(screen.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到当前阶段' }).getAttribute('href')).toBe('#/task/T1/project');
  });

  test('ERP 写入开始后项目归属只读：不能勾选明细，面板里的项目不能点；服务端也拒绝归入与改派', async () => {
    const { adapter, ready } = renderProject('erp');
    await ready;
    expect(await screen.findByText('已开始写入报销系统，项目归属不能再修改。')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect((purpose() as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: '全选当前明细' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: '选择明细 No.1' }) as HTMLInputElement).disabled).toBe(true);
    expect(projectButtons().length).toBeGreaterThan(0);
    expect(projectButtons().every((button) => button.disabled)).toBe(true);
    expect(within(panel()).getByText('不能再修改')).toBeTruthy();
    expect((within(panel()).getByRole('button', { name: '新增项目' }) as HTMLButtonElement).disabled).toBe(true);
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
