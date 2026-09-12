import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { PROJECT_ASSIGNMENT_ERRORS } from '../contract/actions';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';

function renderProject(seed: TaskStage = 'project') {
  window.location.hash = '#/task/T1/project';
  const adapter = createMockAdapter({ seed, fault: null, inventoryPhaseMs: 5, autoStepMs: 5 });
  render(<App adapter={adapter} />);
  return adapter;
}

const workbench = () => screen.getByRole('complementary', { name: '项目工作台' });
const search = () => screen.getByRole('searchbox', { name: '查找个人项目簿' });
const projectNames = () => within(workbench()).queryAllByRole('listitem').map((item) => item.querySelector('.name')?.textContent);
const pick = (no: number) => fireEvent.click(screen.getByRole('checkbox', { name: `选择明细 No.${no}` }));
const assignTo = (label: string) => fireEvent.click(within(workbench()).getByRole('button', { name: `归入 ${label}` }));
const projectOf = (no: number) => screen.getByTestId(`project-of-${no}`).textContent;
const submitButton = () => screen.getByRole('button', { name: '确认项目归属' }) as HTMLButtonElement;
const summary = () => screen.getByTestId('assign-summary').textContent;
const purpose = () => screen.getByLabelText('报销事由');

describe('项目归属', () => {
  test('允许列表来自快照：可选项目有「归入」，不可选的显示状态；搜索按项目号与名称过滤，无结果有提示', async () => {
    renderProject();
    expect(await screen.findByRole('heading', { name: '项目归属' })).toBeTruthy();
    expect(screen.getByText('常驻城市：杭州')).toBeTruthy();
    expect(projectNames()).toEqual(['华东客户交付', '华东客户交付二期', '产品调研', '内部培训', '南京客户培训', '旧版对账工具']);
    expect(within(workbench()).getByText('已过期')).toBeTruthy();
    expect(within(workbench()).getByText('复检未通过')).toBeTruthy();
    expect(within(workbench()).queryByRole('button', { name: /P-4420/ })).toBeNull();
    // 没勾选明细时「归入」不可用。
    expect((within(workbench()).getByRole('button', { name: '归入 P-3312 产品调研' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(search(), { target: { value: '华东' } });
    expect(projectNames()).toEqual(['华东客户交付', '华东客户交付二期']);
    fireEvent.change(search(), { target: { value: 'p-331' } });
    expect(projectNames()).toEqual(['产品调研']);
    fireEvent.change(search(), { target: { value: '不存在的项目' } });
    expect(projectNames()).toEqual([]);
    expect(within(workbench()).getByText('没有匹配的可选项目')).toBeTruthy();
    fireEvent.change(search(), { target: { value: '' } });
    expect(projectNames()).toHaveLength(6);
  });

  test('逐条与批量归入；批量碰到已有其他项目时三个选项：取消不变、只处理未归属、确认覆盖', async () => {
    renderProject();
    await screen.findByRole('heading', { name: '项目归属' });
    expect(projectOf(1)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(3)).toBe('未归属');

    // 逐条：只勾一条。
    pick(3);
    expect(screen.getByText('已选 1 条')).toBeTruthy();
    assignTo('P-1180 内部培训');
    expect(projectOf(3)).toBe('P-1180 · 内部培训');
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
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(projectOf(1)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(2)).toBe('P-2307 · 华东客户交付');
    expect(projectOf(4)).toBe('P-3312 · 产品调研');

    pick(1);
    pick(2);
    pick(5);
    assignTo('P-3312 产品调研');
    dialog = screen.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认覆盖' }));
    expect(projectOf(1)).toBe('P-3312 · 产品调研');
    expect(projectOf(2)).toBe('P-3312 · 产品调研');
    expect(projectOf(5)).toBe('P-3312 · 产品调研');

    // 同一项目再归入不算冲突。
    pick(1);
    pick(6);
    assignTo('P-3312 产品调研');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(projectOf(6)).toBe('P-3312 · 产品调研');
  });

  test('提交按钮：任一明细未归属或事由为空时不可用，显示已归属 n/m 与合计；「仅未归属」只列未归属明细', async () => {
    renderProject();
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
    expect(screen.getByText('所有明细都已归属。')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '仅未归属' }));
    expect(summary()).toBe('已归属 9 / 9 条 · 合计 3972.59 元');
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText(PROJECT_ASSIGNMENT_ERRORS.incomplete)).toBeNull();

    // 事由清空（只有空白也算空）又不可用。
    fireEvent.change(purpose(), { target: { value: '   ' } });
    expect(submitButton().disabled).toBe(true);
  });

  test('提交：带 stepToken 送出，项目归属变为已提交；服务端自动核对报销信息、准备材料后进入整单确认，确认绑定这份归属', async () => {
    const adapter = renderProject();
    await screen.findByRole('heading', { name: '项目归属' });
    const before = await adapter.getSnapshot('T1');
    fireEvent.change(purpose(), { target: { value: '  上海产品评审出差 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前明细' }));
    assignTo('P-2311 华东客户交付二期');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '只处理未归属' }));
    fireEvent.click(submitButton());
    expect(await screen.findByRole('heading', { name: '整单明细确认' })).toBeTruthy();
    expect(window.location.hash).toBe('#/task/T1/review');
    expect(await screen.findByRole('button', { name: '确认' })).toBeTruthy();

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
    renderProject('project');
    await screen.findByRole('heading', { name: '项目归属' });
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    expect(screen.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到当前阶段' }).getAttribute('href')).toBe('#/task/T1/project');
  });

  test('ERP 写入开始后项目归属只读，服务端也拒绝改派', async () => {
    const adapter = renderProject('erp');
    expect(await screen.findByText('已开始 ERP 填报，项目归属不能再修改。')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect((purpose() as HTMLInputElement).disabled).toBe(true);
    const snapshot = await adapter.getSnapshot('T1');
    const projects = Object.fromEntries(snapshot.lines.map((line) => [line.lineId, 'P-2307']));
    const outcome = await adapter.submitProjectAssignment('T1', { purpose: '出差', projects }, snapshot.step.stepToken);
    expect(outcome).toMatchObject({ ok: false, error: { code: 'not_ready' } });
  });

  test('服务端判定：不在允许列表或不可选的项目、缺项目、空事由都被拒绝，状态不变', async () => {
    const adapter = createMockAdapter({ seed: 'project', fault: null });
    const snapshot = await adapter.getSnapshot('T1');
    const token = snapshot.step.stepToken;
    const all = (number: string) => Object.fromEntries(snapshot.lines.map((line) => [line.lineId, number]));

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

    const still = await adapter.getSnapshot('T1');
    expect(still.projectAssignment.status).toBe('pending');
    expect(still.stage).toBe('project');
  });
});
